import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupWorktrees, mergedDiff, parseSpecGaps, runDelegation, topoWaves } from "../extensions/code-changes/delegate.ts";
import { git, runShell } from "../extensions/code-changes/runner.ts";
import type { DelegationPacket, PlanTask, TaskList } from "../extensions/code-changes/state.ts";

const TIMEOUT = 30_000;

function makeTask(overrides: Partial<PlanTask> & Pick<PlanTask, "id">): PlanTask {
	return {
		spec: `spec for ${overrides.id}`,
		verification_commands: [],
		executor_tier: "implementer",
		workspace: "worktree",
		dependencies: [],
		paths: ["."],
		...overrides,
	};
}

describe("topoWaves", () => {
	it("groups independent tasks into a single wave", () => {
		const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" }), makeTask({ id: "c" })];
		const waves = topoWaves(tasks);
		expect(waves).toHaveLength(1);
		expect(waves[0].map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
	});

	it("orders dependent tasks into successive waves", () => {
		const tasks = [
			makeTask({ id: "a" }),
			makeTask({ id: "b", dependencies: ["a"] }),
			makeTask({ id: "c", dependencies: ["b"] }),
		];
		const waves = topoWaves(tasks);
		expect(waves.map((w) => w.map((t) => t.id))).toEqual([["a"], ["b"], ["c"]]);
	});

	it("puts tasks with a shared dependency in the same later wave", () => {
		const tasks = [
			makeTask({ id: "a" }),
			makeTask({ id: "b", dependencies: ["a"] }),
			makeTask({ id: "c", dependencies: ["a"] }),
		];
		const waves = topoWaves(tasks);
		expect(waves).toHaveLength(2);
		expect(waves[0].map((t) => t.id)).toEqual(["a"]);
		expect(waves[1].map((t) => t.id).sort()).toEqual(["b", "c"]);
	});

	it("throws on a cycle", () => {
		const tasks = [makeTask({ id: "a", dependencies: ["b"] }), makeTask({ id: "b", dependencies: ["a"] })];
		expect(() => topoWaves(tasks)).toThrow(/cycle/i);
	});
});

describe("parseSpecGaps", () => {
	it("extracts a single SPEC GAP line", () => {
		const gaps = parseSpecGaps("Did the work.\nSPEC GAP: what should happen on empty input?\nDone.");
		expect(gaps).toEqual(["what should happen on empty input?"]);
	});

	it("extracts every SPEC GAP line, case-insensitively and indented", () => {
		const report = ["Report:", "  spec gap: first question", "some text", "SPEC GAP: second question"].join("\n");
		expect(parseSpecGaps(report)).toEqual(["first question", "second question"]);
	});

	it("returns an empty array when there is no spec gap", () => {
		expect(parseSpecGaps("All good, nothing to report.")).toEqual([]);
	});
});

describe("runShell", () => {
	it(
		"captures a non-zero exit code and its output",
		async () => {
			const result = await runShell(`node -e "console.log('hi'); process.exit(3)"`, process.cwd());
			expect(result.exit_code).toBe(3);
			expect(result.output).toContain("hi");
		},
		TIMEOUT,
	);

	it(
		"captures a zero exit code",
		async () => {
			const result = await runShell(`node -e "console.log('ok')"`, process.cwd());
			expect(result.exit_code).toBe(0);
			expect(result.output).toContain("ok");
		},
		TIMEOUT,
	);

	it(
		"reports a spawn error as exit code 127",
		async () => {
			const result = await runShell("this-command-does-not-exist-xyz", process.cwd());
			expect(result.exit_code).not.toBe(0);
		},
		TIMEOUT,
	);

	it(
		"truncates output that exceeds maxOutput",
		async () => {
			const result = await runShell(`node -e "process.stdout.write('a'.repeat(5000))"`, process.cwd(), { maxOutput: 500 });
			expect(result.output.length).toBeLessThan(1000);
			expect(result.output).toContain("truncated");
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// Integration: a throwaway git repo, real worktrees, a fake sub-agent.
// ---------------------------------------------------------------------------

async function makeTempRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-test-repo-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await fs.promises.writeFile(path.join(dir, "README.md"), "# test repo\n", "utf-8");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "initial commit"], dir);
	return dir;
}

/** A fake `runAgent`: writes a file (or a specific content) into its cwd and reports success. */
function fakeWriterAgent(fileName: string, content: string) {
	return async (opts: { cwd: string }) => {
		await fs.promises.writeFile(path.join(opts.cwd, fileName), content, "utf-8");
		return { exitCode: 0, text: `wrote ${fileName}`, stderr: "", timedOut: false };
	};
}

async function rmrf(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

describe("runDelegation (integration)", () => {
	it(
		"runs two worktree tasks in parallel, commits each, and merges both back",
		async () => {
			const repo = await makeTempRepo();
			const runId = "t1";
			try {
				const plan: TaskList = {
					tasks: [
						makeTask({ id: "task-a", workspace: "worktree" }),
						makeTask({ id: "task-b", workspace: "worktree" }),
					],
					merge_plan: { order: ["task-a", "task-b"], conflict_owner: "coordinator" },
				};
				const packets: DelegationPacket[] = plan.tasks.map((t) => ({
					task_id: t.id,
					spec: t.spec,
					verification_commands: t.verification_commands,
					standing_instructions: "Report what changed.",
				}));

				const agents: Record<string, ReturnType<typeof fakeWriterAgent>> = {
					"task-a": fakeWriterAgent("file-a.txt", "from task a\n"),
					"task-b": fakeWriterAgent("file-b.txt", "from task b\n"),
				};

				const { runs, mergeLog } = await runDelegation(plan, packets, {
					cwd: repo,
					runId,
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						const taskId = Object.keys(agents).find((id) => opts.task.includes(id)) as string | undefined;
						// Fall back to matching by content of the spec (contains the task id).
						const match = taskId ?? (opts.task.includes("task-a") ? "task-a" : "task-b");
						return agents[match](opts);
					},
				});

				expect(runs.find((r) => r.task_id === "task-a")?.status).toBe("succeeded");
				expect(runs.find((r) => r.task_id === "task-b")?.status).toBe("succeeded");
				expect(runs.every((r) => r.merged)).toBe(true);
				expect(mergeLog.some((line) => line.includes("merged"))).toBe(true);

				const statusAfterMerge = await git(["status", "--porcelain"], repo);
				expect(statusAfterMerge.stdout).toContain("file-a.txt");
				expect(statusAfterMerge.stdout).toContain("file-b.txt");
				expect(fs.existsSync(path.join(repo, "file-a.txt"))).toBe(true);
				expect(fs.existsSync(path.join(repo, "file-b.txt"))).toBe(true);

				const diff = await mergedDiff(repo, undefined);
				expect(diff.length).toBeGreaterThan(0);
				expect(diff).toContain("file-a.txt");

				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"marks the second merge as a conflict when both tasks touch the same file",
		async () => {
			const repo = await makeTempRepo();
			const runId = "t2";
			try {
				const plan: TaskList = {
					tasks: [
						makeTask({ id: "task-a", workspace: "worktree" }),
						makeTask({ id: "task-b", workspace: "worktree" }),
					],
					merge_plan: { order: ["task-a", "task-b"], conflict_owner: "coordinator" },
				};
				const packets: DelegationPacket[] = plan.tasks.map((t) => ({
					task_id: t.id,
					spec: t.spec,
					verification_commands: t.verification_commands,
					standing_instructions: "Report what changed.",
				}));

				const agents: Record<string, ReturnType<typeof fakeWriterAgent>> = {
					"task-a": fakeWriterAgent("shared.txt", "content from task a\n"),
					"task-b": fakeWriterAgent("shared.txt", "different content from task b\n"),
				};

				const { runs } = await runDelegation(plan, packets, {
					cwd: repo,
					runId,
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						const match = opts.task.includes("task-a") ? "task-a" : "task-b";
						return agents[match](opts);
					},
				});

				const runA = runs.find((r) => r.task_id === "task-a");
				const runB = runs.find((r) => r.task_id === "task-b");
				expect(runA?.status).toBe("succeeded");
				expect(runB?.status).toBe("succeeded");
				expect(runA?.merged).toBe(true);
				expect(runB?.conflict).toBe(true);
				expect(runB?.merged).toBeFalsy();

				// Clean up the conflicted merge state before removing worktrees.
				await git(["merge", "--abort"], repo);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"records a warning when the main tree has uncommitted changes",
		async () => {
			const repo = await makeTempRepo();
			try {
				await fs.promises.writeFile(path.join(repo, "dirty.txt"), "uncommitted\n", "utf-8");
				const plan: TaskList = { tasks: [makeTask({ id: "solo", workspace: "worktree" })] };
				const { runs, mergeLog } = await runDelegation(plan, [], {
					cwd: repo,
					runId: "t3",
					resolveModel: () => undefined,
					runAgent: fakeWriterAgent("solo.txt", "solo\n"),
				});
				expect(mergeLog.some((line) => line.includes("uncommitted changes"))).toBe(true);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"marks a stalled implementer as failed and keeps its worktree",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "slow-task", workspace: "worktree" })] };
				const { runs } = await runDelegation(plan, [], {
					cwd: repo,
					runId: "t5",
					resolveModel: () => undefined,
					runAgent: async () => ({ exitCode: 124, text: "still working on it", stderr: "", timedOut: true }),
				});
				const run = runs.find((r) => r.task_id === "slow-task");
				expect(run?.status).toBe("failed");
				expect(run?.stalled).toBe(true);
				expect(run?.error).toMatch(/stalled: exceeded \d+ min budget/);
				expect(run?.worktree).toBeTruthy();
				expect(fs.existsSync(run!.worktree!)).toBe(true);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"records spec gaps from a successful implementer report without failing the run",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = { tasks: [makeTask({ id: "gappy-task", workspace: "worktree" })] };
				const { runs } = await runDelegation(plan, [], {
					cwd: repo,
					runId: "t6",
					resolveModel: () => undefined,
					runAgent: async (opts) => {
						await fs.promises.writeFile(path.join(opts.cwd, "gap.txt"), "content\n", "utf-8");
						return { exitCode: 0, text: "SPEC GAP: should this handle nulls?\nDone otherwise.", stderr: "", timedOut: false };
					},
				});
				const run = runs.find((r) => r.task_id === "gappy-task");
				expect(run?.status).toBe("succeeded");
				expect(run?.spec_gaps).toEqual(["should this handle nulls?"]);
				await cleanupWorktrees(runs, repo);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"marks a coordinator-direct task without spawning an agent",
		async () => {
			const repo = await makeTempRepo();
			try {
				const plan: TaskList = {
					tasks: [makeTask({ id: "trivial-fix", workspace: "main", executor_tier: "coordinator-direct" })],
				};
				let called = false;
				const { runs } = await runDelegation(plan, [], {
					cwd: repo,
					runId: "t4",
					resolveModel: () => undefined,
					runAgent: async () => {
						called = true;
						return { exitCode: 0, text: "", stderr: "", timedOut: false };
					},
				});
				expect(runs[0].status).toBe("coordinator");
				expect(called).toBe(false);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});
