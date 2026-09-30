import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupWorktrees, effectiveWorkspace, runDelegation, topoWaves } from "../extensions/code-changes/delegate.ts";
import { topologicalWaves } from "../extensions/code-changes/artifacts.ts";
import { git } from "../extensions/code-changes/runner.ts";
import type { DelegationPacket, PlanTask, TaskList, TaskRun } from "../extensions/code-changes/state.ts";

const TIMEOUT = 30_000;

function makeTask(overrides: Partial<PlanTask> & Pick<PlanTask, "id">): PlanTask {
	return {
		spec: `spec for ${overrides.id}`,
		verification_commands: [],
		executor_tier: "implementer",
		workspace: "main",
		dependencies: [],
		paths: [`${overrides.id}/`],
		...overrides,
	};
}

async function makeTempRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-par-repo-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await fs.promises.writeFile(path.join(dir, "README.md"), "# test repo\n", "utf-8");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "initial commit"], dir);
	return dir;
}

async function rmrf(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

function packetsFor(plan: TaskList): DelegationPacket[] {
	return plan.tasks.map((t) => ({
		task_id: t.id,
		spec: t.spec,
		verification_commands: t.verification_commands,
		standing_instructions: "Report what changed.",
	}));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Timing {
	start: number;
	end: number;
	cwd: string;
}

/**
 * A fake `runAgent`: identifies the task from its prompt, writes the files configured for it
 * (relative to its cwd), holds for `holdMs` so overlapping runs are observable, and records timing.
 */
function fakeAgent(files: Record<string, string[]>, holdMs = 250) {
	const timings = new Map<string, Timing>();
	let active = 0;
	let peak = 0;
	const runAgent = async (opts: { cwd: string; task: string }) => {
		const id = Object.keys(files).find((candidate) => opts.task.includes(`spec for ${candidate}`)) as string;
		const start = Date.now();
		active += 1;
		peak = Math.max(peak, active);
		await sleep(holdMs);
		for (const rel of files[id]) {
			const target = path.join(opts.cwd, rel);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, `from ${id}\n`, "utf-8");
		}
		active -= 1;
		timings.set(id, { start, end: Date.now(), cwd: opts.cwd });
		return { exitCode: 0, text: `done ${id}`, stderr: "", timedOut: false };
	};
	return { runAgent, timings, peak: () => peak };
}

const overlaps = (a: Timing, b: Timing) => a.start < b.end && b.start < a.end;
const run = (runs: TaskRun[], id: string) => runs.find((r) => r.task_id === id) as TaskRun;

describe("shared wave computation", () => {
	it("exports one implementation under both names", () => {
		expect(topoWaves).toBe(topologicalWaves);
	});
});

describe("runDelegation parallelism (integration)", () => {
	it(
		"moves independent main tasks in different folders to worktrees, runs them concurrently, and merges both",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "task-a" }), makeTask({ id: "task-b" })] };
				expect(plan.tasks.map((t) => effectiveWorkspace(t, plan))).toEqual(["worktree", "worktree"]);
				const agent = fakeAgent({ "task-a": ["task-a/a.txt"], "task-b": ["task-b/b.txt"] });

				const { runs, mergeLog } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "p1",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
				});

				expect(run(runs, "task-a").status).toBe("succeeded");
				expect(run(runs, "task-b").status).toBe("succeeded");
				expect(run(runs, "task-a").auto_worktree).toBe(true);
				expect(run(runs, "task-b").auto_worktree).toBe(true);
				expect(run(runs, "task-a").worktree).toBeTruthy();
				expect(overlaps(agent.timings.get("task-a") as Timing, agent.timings.get("task-b") as Timing)).toBe(true);
				expect(agent.timings.get("task-a")?.cwd).not.toBe(repo);
				expect(mergeLog).toContain("task task-a moved to a worktree to run in parallel with task-b");
				expect(mergeLog).toContain("task task-b moved to a worktree to run in parallel with task-a");
				expect(runs.every((r) => r.merged)).toBe(true);
				expect(fs.existsSync(path.join(repo, "task-a", "a.txt"))).toBe(true);
				expect(fs.existsSync(path.join(repo, "task-b", "b.txt"))).toBe(true);
				expect(run(runs, "task-a").out_of_scope).toBeUndefined();
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"keeps a requires_main_tree task in the main tree while its peer runs in a worktree",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "task-a", requires_main_tree: true }), makeTask({ id: "task-b" })] };
				const agent = fakeAgent({ "task-a": ["task-a/a.txt"], "task-b": ["task-b/b.txt"] });

				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "p2",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
				});

				expect(run(runs, "task-a").auto_worktree).toBeFalsy();
				expect(run(runs, "task-a").worktree).toBeUndefined();
				expect(agent.timings.get("task-a")?.cwd).toBe(repo);
				expect(run(runs, "task-b").auto_worktree).toBe(true);
				expect(agent.timings.get("task-b")?.cwd).not.toBe(repo);
				expect(run(runs, "task-b").merged).toBe(true);
				expect(run(runs, "task-a").out_of_scope).toBeUndefined();
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"serializes everything when maxParallel is 1",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "task-a" }), makeTask({ id: "task-b" })] };
				const agent = fakeAgent({ "task-a": ["task-a/a.txt"], "task-b": ["task-b/b.txt"] });

				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "p3",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
					maxParallel: 1,
				});

				expect(run(runs, "task-a").status).toBe("succeeded");
				expect(run(runs, "task-b").status).toBe("succeeded");
				expect(overlaps(agent.timings.get("task-a") as Timing, agent.timings.get("task-b") as Timing)).toBe(false);
				expect(agent.peak()).toBe(1);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"caps concurrent implementers at maxParallel",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = {
					tasks: [makeTask({ id: "task-a" }), makeTask({ id: "task-b" }), makeTask({ id: "task-c" })],
				};
				const agent = fakeAgent({ "task-a": ["task-a/a.txt"], "task-b": ["task-b/b.txt"], "task-c": ["task-c/c.txt"] });

				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "p4",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
					maxParallel: 2,
				});

				expect(runs.every((r) => r.status === "succeeded" && r.merged)).toBe(true);
				expect(agent.peak()).toBe(2);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"runs a dependent task in a worktree that has its moved dependencies merged in",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = {
					tasks: [
						makeTask({ id: "task-a" }),
						makeTask({ id: "task-b" }),
						makeTask({ id: "task-c", dependencies: ["task-a", "task-b"] }),
					],
				};
				const seen: Record<string, boolean> = {};
				const agent = fakeAgent({ "task-a": ["task-a/a.txt"], "task-b": ["task-b/b.txt"], "task-c": ["task-c/c.txt"] }, 50);
				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "p5",
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						if (opts.task.includes("spec for task-c")) {
							seen.a = fs.existsSync(path.join(opts.cwd, "task-a", "a.txt"));
							seen.b = fs.existsSync(path.join(opts.cwd, "task-b", "b.txt"));
						}
						return agent.runAgent(opts);
					},
				});

				expect(run(runs, "task-c").auto_worktree).toBe(true);
				expect(seen).toEqual({ a: true, b: true });
				expect(runs.every((r) => r.status === "succeeded")).toBe(true);
				// Files brought in from dependency branches are not the dependent task's own changes.
				expect(run(runs, "task-c").out_of_scope).toBeUndefined();
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});

describe("runDelegation scope check (integration)", () => {
	it(
		"records out_of_scope and a spec gap for a worktree task that writes outside its paths",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "task-a" }), makeTask({ id: "task-b" })] };
				const agent = fakeAgent({ "task-a": ["task-a/a.txt", "stray.txt", "other/x.txt"], "task-b": ["task-b/b.txt"] }, 20);

				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "s1",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
				});

				const a = run(runs, "task-a");
				expect(a.status).toBe("succeeded");
				expect(a.out_of_scope).toEqual(["other/x.txt", "stray.txt"]);
				expect(a.spec_gaps).toEqual(["changed files outside its declared paths: other/x.txt, stray.txt"]);
				expect(run(runs, "task-b").out_of_scope).toBeUndefined();
				expect(run(runs, "task-b").spec_gaps).toEqual([]);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"records out_of_scope for a main-tree task, ignoring files that were already dirty",
		async () => {
			const repo = await makeTempRepo();
			try {
				await fs.promises.writeFile(path.join(repo, "README.md"), "# locally edited\n", "utf-8");
				await fs.promises.writeFile(path.join(repo, "scratch.txt"), "pre-existing untracked\n", "utf-8");
				const plan: TaskList = { tasks: [makeTask({ id: "solo" })] };
				const agent = fakeAgent({ solo: ["solo/s.txt", "stray.txt"] }, 10);

				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "s2",
					resolveModel: () => undefined,
					runAgent: agent.runAgent,
				});

				const solo = run(runs, "solo");
				expect(solo.auto_worktree).toBeFalsy();
				expect(solo.out_of_scope).toEqual(["stray.txt"]);
				expect(solo.spec_gaps).toEqual(["changed files outside its declared paths: stray.txt"]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"catches a main-tree task that re-edits a file that was already dirty",
		async () => {
			const repo = await makeTempRepo();
			try {
				await fs.promises.writeFile(path.join(repo, "README.md"), "# locally edited\n", "utf-8");
				const plan: TaskList = { tasks: [makeTask({ id: "solo" })] };
				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "s3",
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						await fs.promises.writeFile(path.join(opts.cwd, "README.md"), "# edited again by the implementer, longer\n", "utf-8");
						return { exitCode: 0, text: "ok", stderr: "", timedOut: false };
					},
				});
				expect(run(runs, "solo").out_of_scope).toEqual(["README.md"]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"counts the scope violation toward spec-gap escalation alongside a reported gap",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "solo", workspace: "worktree" })] };
				const { runs } = await runDelegation(plan, packetsFor(plan), {
					cwd: repo,
					runId: "s4",
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						await fs.promises.writeFile(path.join(opts.cwd, "stray.txt"), "x\n", "utf-8");
						return { exitCode: 0, text: "SPEC GAP: which folder?", stderr: "", timedOut: false };
					},
				});
				const solo = run(runs, "solo");
				expect(solo.status).toBe("succeeded");
				expect(solo.spec_gaps).toEqual(["which folder?", "changed files outside its declared paths: stray.txt"]);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});
