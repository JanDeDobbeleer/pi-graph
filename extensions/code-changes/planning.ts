/**
 * Plan structure shared by validation, display and delegation: dependency waves and the workspace
 * each task actually runs in. Pure and import-cycle free (artifacts.ts and delegate.ts both use it).
 *
 * Workspace policy: a task the plan puts in "worktree" always runs there. A task the plan leaves in
 * "main" is moved into a worktree by the harness (`auto`) when that lets it run in parallel:
 *   - it has an independent sub-agent task in the same wave with non-overlapping paths, or
 *   - it depends on a task that was itself moved, so it can merge that task's branch in.
 * Tasks flagged `requires_main_tree` (and anything they transitively depend on) stay in the main tree;
 * that is for tasks that truly need it (local services/state not in git), not for uncommitted file
 * changes: delegate.ts carries those into worktrees via a snapshot commit.
 */

import { independent, pathsOverlap } from "./paths.ts";
import type { PlanTask, TaskList } from "./state.ts";

/** Groups tasks into dependency waves (Kahn's algorithm, layered). Throws on a cycle. */
export function topologicalWaves(tasks: PlanTask[]): PlanTask[][] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const waves: PlanTask[][] = [];
	const done = new Set<string>();
	let remaining = tasks.slice();

	while (remaining.length > 0) {
		const ready = remaining.filter((t) => t.dependencies.every((d) => done.has(d) || !byId.has(d)));
		if (ready.length === 0) {
			throw new Error(`Cycle detected in task dependencies: ${remaining.map((t) => t.id).join(", ")}`);
		}
		waves.push(ready);
		for (const t of ready) done.add(t.id);
		const readyIds = new Set(ready.map((t) => t.id));
		remaining = remaining.filter((t) => !readyIds.has(t.id));
	}
	return waves;
}

/** Tasks executed by a sub-agent process (everything except coordinator-direct). */
export function isSubAgentTask(t: PlanTask): boolean {
	return t.executor_tier !== "coordinator-direct";
}

export interface WorkspaceDecision {
	workspace: "main" | "worktree";
	/** True when the harness moved a "main" task into a worktree. */
	auto: boolean;
	/** Sub-agent tasks in the same wave that can run at the same time as this one. */
	parallelWith: string[];
	/** Human-readable reason for an automatic move. */
	reason?: string;
}

function transitiveDependents(taskId: string, tasks: PlanTask[]): PlanTask[] {
	const found = new Map<string, PlanTask>();
	let frontier = [taskId];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const t of tasks) {
			if (found.has(t.id) || t.id === taskId) continue;
			if (t.dependencies.some((d) => frontier.includes(d))) {
				found.set(t.id, t);
				next.push(t.id);
			}
		}
		frontier = next;
	}
	return [...found.values()];
}

/** Workspace decision for every task in the plan (coordinator-direct tasks run in the main tree). Throws on a cycle. */
export function planWorkspaces(plan: Pick<TaskList, "tasks">): Map<string, WorkspaceDecision> {
	const decisions = new Map<string, WorkspaceDecision>();
	const tasks = plan.tasks;

	for (const wave of topologicalWaves(tasks)) {
		for (const t of wave) {
			if (!isSubAgentTask(t)) {
				decisions.set(t.id, { workspace: "main", auto: false, parallelWith: [] });
				continue;
			}
			const scope = t.paths && t.paths.length > 0 ? t.paths : ["."];
			const peers = wave
				.filter((p) => p.id !== t.id && isSubAgentTask(p) && independent(t, p, tasks))
				.filter((p) => !pathsOverlap(scope, p.paths && p.paths.length > 0 ? p.paths : ["."]))
				.map((p) => p.id);

			if (t.workspace === "worktree") {
				decisions.set(t.id, { workspace: "worktree", auto: false, parallelWith: peers });
				continue;
			}

			const pinnedToMain =
				t.requires_main_tree === true || transitiveDependents(t.id, tasks).some((d) => isSubAgentTask(d) && d.requires_main_tree === true);
			const movedDeps = t.dependencies.filter((d) => decisions.get(d)?.auto === true);

			if (!pinnedToMain && peers.length > 0) {
				decisions.set(t.id, {
					workspace: "worktree",
					auto: true,
					parallelWith: peers,
					reason: `to run in parallel with ${peers.join(", ")}`,
				});
			} else if (!pinnedToMain && movedDeps.length > 0) {
				decisions.set(t.id, {
					workspace: "worktree",
					auto: true,
					parallelWith: peers,
					reason: `because it depends on ${movedDeps.join(", ")}, which run(s) in a worktree`,
				});
			} else {
				decisions.set(t.id, { workspace: "main", auto: false, parallelWith: peers });
			}
		}
	}
	return decisions;
}

/**
 * The workspace a task really runs in. Coordinator-direct tasks are not delegated and report
 * "main" (they run in the main tree during Supervise).
 */
export function effectiveWorkspace(task: PlanTask, plan: Pick<TaskList, "tasks">): "main" | "worktree" {
	return planWorkspaces(plan).get(task.id)?.workspace ?? task.workspace;
}

/** Ids of the sub-agent tasks that end up in a worktree, in plan order. */
export function worktreeTaskIds(plan: Pick<TaskList, "tasks">): string[] {
	const decisions = planWorkspaces(plan);
	return plan.tasks.filter((t) => isSubAgentTask(t) && decisions.get(t.id)?.workspace === "worktree").map((t) => t.id);
}
