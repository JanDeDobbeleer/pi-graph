import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createResumeTaskTool, needsSpecGapEscalation, RESUME_TOOL, type ResumeDeps } from "../extensions/code-changes/resume.ts";
import { git } from "../extensions/code-changes/runner.ts";
import { newState, type PlanTask, type TaskRun, type WorkflowState } from "../extensions/code-changes/state.ts";

const TIMEOUT = 30_000;

async function makeTempRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-resume-repo-"));
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

function baseState(task: PlanTask, run: TaskRun, phase: WorkflowState["phase"] = "supervise"): WorkflowState {
	const state = newState("do the thing", [], undefined);
	return {
		...state,
		phase,
		plan: { tasks: [task] },
		packets: [{ task_id: task.id, spec: task.spec, verification_commands: task.verification_commands, standing_instructions: "Report what changed." }],
		runs: [run],
	};
}

function makeDeps(overrides: Partial<ResumeDeps> & { state: WorkflowState }): ResumeDeps & { committed: WorkflowState[]; escalateCalls: number } {
	let current = overrides.state;
	const committed: WorkflowState[] = [];
	let escalateCalls = 0;
	return {
		committed,
		get escalateCalls() {
			return escalateCalls;
		},
		getState: () => current,
		commit: (next) => {
			current = next;
			committed.push(next);
		},
		resolveModel: () => undefined,
		escalate: async () => {
			escalateCalls += 1;
			return { decision: "Cut scope: skip the null case.", model: "anthropic/claude-fable-5-1" };
		},
		runAgent: overrides.runAgent,
		taskTimeoutMs: overrides.taskTimeoutMs,
	} as ResumeDeps & { committed: WorkflowState[]; escalateCalls: number };
}

const ctxFor = (cwd: string) => ({ cwd }) as any;

describe("resume_task", () => {
	it("throws outside the Supervise phase", async () => {
		const task = makeTask({ id: "task-a", workspace: "main" });
		const run: TaskRun = { task_id: "task-a", status: "failed" };
		const state = baseState(task, run, "verify");
		const deps = makeDeps({ state });
		const tool = createResumeTaskTool(deps);

		await expect(
			tool.execute("call-1", { task_id: "task-a", answer: "do X" }, undefined, undefined, ctxFor(process.cwd())),
		).rejects.toThrow(/Supervise/);
	});

	it("throws for a coordinator-direct task", async () => {
		const task = makeTask({ id: "task-a", workspace: "main", executor_tier: "coordinator-direct" });
		const run: TaskRun = { task_id: "task-a", status: "coordinator" };
		const state = baseState(task, run, "supervise");
		const deps = makeDeps({ state });
		const tool = createResumeTaskTool(deps);

		await expect(
			tool.execute("call-1", { task_id: "task-a", answer: "do X" }, undefined, undefined, ctxFor(process.cwd())),
		).rejects.toThrow(/coordinator-direct/);
	});

	it(
		"applies only the resume delta when the task's branch was already merged",
		async () => {
			const repo = await makeTempRepo();
			const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-resume-wt-"));
			try {
				const branch = "pi-cc/rt1/task-a";
				await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], repo);
				await fs.promises.writeFile(path.join(worktreePath, "a.txt"), "first\n", "utf-8");
				await git(["add", "-A"], worktreePath);
				await git(["commit", "-m", "wip(task-a): implementer output"], worktreePath);

				// Simulate runDelegation's squash-merge having already landed in the main tree.
				await git(["merge", "--squash", branch], repo);
				await git(["commit", "-m", "wip(task-a): implementer output"], repo);

				const task = makeTask({ id: "task-a", workspace: "worktree" });
				const run: TaskRun = {
					task_id: "task-a",
					status: "succeeded",
					worktree: worktreePath,
					branch,
					merged: true,
				};
				const state = baseState(task, run, "supervise");
				const deps = makeDeps({
					state,
					runAgent: async (opts) => {
						await fs.promises.writeFile(path.join(opts.cwd, "b.txt"), "second\n", "utf-8");
						return { exitCode: 0, text: "wrote b.txt", stderr: "", timedOut: false };
					},
				});
				const tool = createResumeTaskTool(deps);

				const result = await tool.execute("call-1", { task_id: "task-a", answer: "add b.txt too" }, undefined, undefined, ctxFor(repo));
				const details = result.details as { run: TaskRun };
				expect(details.run.status).toBe("succeeded");
				expect(details.run.conflict).toBeFalsy();
				expect(details.run.resumes).toBe(1);

				// The originally merged file is present exactly once, and the resume's new file landed too.
				expect(await fs.promises.readFile(path.join(repo, "a.txt"), "utf-8")).toBe("first\n");
				expect(await fs.promises.readFile(path.join(repo, "b.txt"), "utf-8")).toBe("second\n");

				const statusResult = await git(["status", "--porcelain"], repo);
				expect(statusResult.stdout).toContain("b.txt");
			} finally {
				await git(["worktree", "remove", "--force", worktreePath], repo).catch(() => undefined);
				await rmrf(repo);
				await rmrf(worktreePath);
			}
		},
		TIMEOUT,
	);

	it(
		"escalates once a task's spec gaps repeat, and does not escalate a third time",
		async () => {
			const task = makeTask({ id: "task-a", workspace: "main" });
			// Simulates the initial delegation run already having reported one spec gap.
			const run: TaskRun = { task_id: "task-a", status: "failed", spec_gaps: ["first gap"], stalled: false };
			const state = baseState(task, run, "supervise");

			let gapText = "SPEC GAP: second gap";
			const deps = makeDeps({
				state,
				runAgent: async () => ({ exitCode: 0, text: gapText, stderr: "", timedOut: false }),
			});
			const tool = createResumeTaskTool(deps);

			const firstResult = await tool.execute("call-1", { task_id: "task-a", answer: "keep going" }, undefined, undefined, ctxFor(process.cwd()));
			const firstRun = (firstResult.details as { run: TaskRun }).run;
			expect(firstRun.spec_gaps).toEqual(["first gap", "second gap"]);
			expect(needsSpecGapEscalation({ ...firstRun, escalated: false })).toBe(true);
			expect(firstRun.escalated).toBe(true);
			expect(deps.escalateCalls).toBe(1);
			expect(deps.getState()?.escalations).toHaveLength(1);
			expect(firstResult.content[0]).toMatchObject({ type: "text" });
			expect((firstResult.content[0] as { text: string }).text).toContain("Escalation:");

			gapText = "SPEC GAP: third gap";
			const secondResult = await tool.execute("call-2", { task_id: "task-a", answer: "still going" }, undefined, undefined, ctxFor(process.cwd()));
			const secondRun = (secondResult.details as { run: TaskRun }).run;
			expect(secondRun.spec_gaps).toEqual(["first gap", "second gap", "third gap"]);
			expect(deps.escalateCalls).toBe(1); // no second escalation call
			expect(deps.getState()?.escalations).toHaveLength(1);
		},
		TIMEOUT,
	);
});

describe("resume_task scope recheck", () => {
	it(
		"recomputes out_of_scope for a worktree task after a resume, and clears it once fixed",
		async () => {
			const repo = await makeTempRepo();
			const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-resume-scope-wt-"));
			try {
				const branch = "pi-cc/rs1/task-a";
				await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], repo);
				await fs.promises.mkdir(path.join(worktreePath, "pkg"), { recursive: true });
				await fs.promises.writeFile(path.join(worktreePath, "pkg", "a.txt"), "first\n", "utf-8");
				await git(["add", "-A"], worktreePath);
				await git(["commit", "-m", "wip(task-a): implementer output"], worktreePath);

				const task = makeTask({ id: "task-a", workspace: "worktree", paths: ["pkg/"] });
				const run: TaskRun = { task_id: "task-a", status: "succeeded", worktree: worktreePath, branch };
				const state = baseState(task, run, "supervise");
				let strayMode: "write" | "remove" = "write";
				const deps = makeDeps({
					state,
					runAgent: async (opts) => {
						if (strayMode === "write") {
							await fs.promises.writeFile(path.join(opts.cwd, "stray.txt"), "oops\n", "utf-8");
						} else {
							await fs.promises.rm(path.join(opts.cwd, "stray.txt"), { force: true });
						}
						return { exitCode: 0, text: "resumed", stderr: "", timedOut: false };
					},
				});
				const tool = createResumeTaskTool(deps);

				const first = await tool.execute("c1", { task_id: "task-a", answer: "go on" }, undefined, undefined, ctxFor(repo));
				const firstRun = (first.details as { run: TaskRun }).run;
				expect(firstRun.out_of_scope).toEqual(["stray.txt"]);
				expect(firstRun.spec_gaps).toEqual(["changed files outside its declared paths: stray.txt"]);
				expect(needsSpecGapEscalation({ ...firstRun, spec_gaps: [...(firstRun.spec_gaps ?? []), "another"] })).toBe(true);

				strayMode = "remove";
				const second = await tool.execute("c2", { task_id: "task-a", answer: "remove it" }, undefined, undefined, ctxFor(repo));
				const secondRun = (second.details as { run: TaskRun }).run;
				expect(secondRun.out_of_scope).toBeUndefined();
				expect(secondRun.spec_gaps).toEqual([]);
			} finally {
				await git(["worktree", "remove", "--force", worktreePath], repo).catch(() => undefined);
				await rmrf(repo);
				await rmrf(worktreePath);
			}
		},
		TIMEOUT,
	);

	it(
		"records out_of_scope for a main-tree task resume, without duplicating the spec-gap line",
		async () => {
			const repo = await makeTempRepo();
			try {
				const task = makeTask({ id: "task-a", workspace: "main", paths: ["pkg/"] });
				const run: TaskRun = { task_id: "task-a", status: "failed" };
				const state = baseState(task, run, "supervise");
				const deps = makeDeps({
					state,
					runAgent: async (opts) => {
						await fs.promises.mkdir(path.join(opts.cwd, "pkg"), { recursive: true });
						await fs.promises.writeFile(path.join(opts.cwd, "pkg", "a.txt"), "in scope\n", "utf-8");
						await fs.promises.writeFile(path.join(opts.cwd, "stray.txt"), "oops\n", "utf-8");
						return { exitCode: 0, text: "resumed", stderr: "", timedOut: false };
					},
				});
				const tool = createResumeTaskTool(deps);

				const first = await tool.execute("c1", { task_id: "task-a", answer: "go" }, undefined, undefined, ctxFor(repo));
				expect((first.details as { run: TaskRun }).run.out_of_scope).toEqual(["stray.txt"]);

				const second = await tool.execute("c2", { task_id: "task-a", answer: "again" }, undefined, undefined, ctxFor(repo));
				const secondRun = (second.details as { run: TaskRun }).run;
				// stray.txt is still dirty from the first resume, so it stays flagged - exactly once.
				expect(secondRun.out_of_scope).toEqual(["stray.txt"]);
				expect(secondRun.spec_gaps).toEqual(["changed files outside its declared paths: stray.txt"]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});
