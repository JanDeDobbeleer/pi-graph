/**
 * Artifact contract for the code-changes graph: one TypeBox schema per phase edge, plus the pure
 * apply/validate functions that enforce artifacts.md and verify.md against `WorkflowState`.
 *
 * No pi runtime calls and no I/O here — this module is exercised directly by unit tests. The
 * extension's event handlers call into these functions and persist the returned state.
 */

import { Type, type Static } from "typebox";
import { transition, type WorkflowState, type PlanTask, type TaskList, type FailureRecord, type PullRequestRef, type AnalysisReport } from "./state.ts";
import type { GateResult } from "./state.ts";

// ---------------------------------------------------------------------------
// 1. Schemas
// ---------------------------------------------------------------------------

export const AnalysisSchema = Type.Object({
	root_cause: Type.String({ description: "What is happening and why, with file references." }),
	proposed_change: Type.String({ description: "The scope of the fix, in enough detail to plan tasks from." }),
	out_of_scope: Type.String({ description: "What is deliberately left alone." }),
	repro_status: Type.String({ description: "Reproduced-with-evidence, or unverified-by-repro with the reason." }),
	open_questions: Type.Array(Type.String(), {
		description: "Anything still unresolved. Must be empty for the stop gate to clear automatically.",
	}),
});
export type AnalysisParams = Static<typeof AnalysisSchema>;

const PlanTaskSchema = Type.Object({
	id: Type.String({ description: "Short unique identifier for this task, e.g. 'task-1'." }),
	spec: Type.String({ description: "Approach, files/entry points, constraints, pinned skill rules, non-goals." }),
	verification_commands: Type.Array(Type.String(), {
		description: "Commands the executor must run and pass before reporting done.",
	}),
	executor_tier: Type.Union([Type.Literal("trivial"), Type.Literal("implementer"), Type.Literal("coordinator-direct")], {
		description: "Which tier executes this task. Escalation is never a value here.",
	}),
	workspace: Type.Union([Type.Literal("main"), Type.Literal("worktree")], {
		description: "Whether this task runs in the main tree or an isolated git worktree.",
	}),
	dependencies: Type.Array(Type.String(), {
		description: "IDs of other tasks in this plan that must land first, if any.",
	}),
});

export const PlanSchema = Type.Object({
	tasks: Type.Array(PlanTaskSchema, { description: "One entry per task to delegate." }),
	merge_plan: Type.Optional(
		Type.Object(
			{
				order: Type.Array(Type.String(), { description: "Task IDs in the order their worktrees should be merged." }),
				conflict_owner: Type.String({ description: "Who resolves a merge conflict between worktree tasks." }),
			},
			{ description: "Required whenever more than one task runs in a worktree." },
		),
	),
});
export type PlanParams = Static<typeof PlanSchema>;

export const ReviewSchema = Type.Object({
	overrides: Type.Array(Type.String(), {
		description: "Any subagent solution the coordinator replaced, and why. Empty when nothing was overridden.",
	}),
	tests_kept: Type.Array(Type.String(), { description: "Added tests that survived critical review, and why." }),
	tests_cut: Type.Array(Type.String(), { description: "Added tests that were removed, and why." }),
	notes: Type.Optional(Type.String({ description: "Any other context needed before Verify." })),
});
export type ReviewParams = Static<typeof ReviewSchema>;

export const VerificationSchema = Type.Object({
	outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
		description: "Whether the merged change passed verification.",
	}),
	functional_proof: Type.String({
		description: "Actual observed values from exercising the real flow, not adjectives. Required on pass.",
	}),
	failure_class: Type.Optional(
		Type.Union([Type.Literal("gate_failure"), Type.Literal("spec_mismatch"), Type.Literal("wrong_root_cause")], {
			description: "Required when outcome is fail: what kind of failure this was.",
		}),
	),
	failure_summary: Type.Optional(Type.String({ description: "Required when outcome is fail: what broke." })),
	hypothesis: Type.Optional(Type.String({ description: "Working theory for the failure, if any." })),
});
export type VerificationParams = Static<typeof VerificationSchema>;

export const DeliverySchema = Type.Object({
	report: Type.String({ description: "Outcome-first report of what shipped." }),
	no_commit_reason: Type.Optional(Type.String({ description: "Required when no commits were made." })),
});
export type DeliveryParams = Static<typeof DeliverySchema>;

// ---------------------------------------------------------------------------
// 2. Errors
// ---------------------------------------------------------------------------

export class ArtifactError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactError";
	}
}

// ---------------------------------------------------------------------------
// 3a. Analysis <-> Markdown (approval-gate display + human editing round trip)
// ---------------------------------------------------------------------------

const ANALYSIS_SECTION_HEADINGS: Record<keyof Omit<AnalysisReport, "open_questions">, string> = {
	root_cause: "Root cause",
	proposed_change: "Proposed change",
	out_of_scope: "Out of scope",
	repro_status: "Repro status",
};

const REQUIRED_ANALYSIS_SECTIONS: Array<{ key: keyof AnalysisReport; heading: string }> = [
	{ key: "root_cause", heading: "Root cause" },
	{ key: "proposed_change", heading: "Proposed change" },
	{ key: "repro_status", heading: "Repro status" },
];

/**
 * Renders an analysis report as Markdown for the approval-gate transcript message and for the
 * human-editing flow (`ctx.ui.editor`). Open questions come first, when any are unresolved, so
 * they aren't missed below the other sections. `parseAnalysisMarkdown` is the inverse.
 */
export function formatAnalysis(a: AnalysisReport, opts?: { edited?: boolean }): string {
	const lines: string[] = [];
	lines.push("# Analysis");
	if (opts?.edited) lines.push("_(edited by you)_");
	if (a.open_questions.length > 0) {
		lines.push("");
		lines.push("## Open questions");
		for (const q of a.open_questions) lines.push(`- ${q}`);
	}
	lines.push("");
	lines.push(`## ${ANALYSIS_SECTION_HEADINGS.root_cause}\n${a.root_cause}`);
	lines.push("");
	lines.push(`## ${ANALYSIS_SECTION_HEADINGS.proposed_change}\n${a.proposed_change}`);
	lines.push("");
	lines.push(`## ${ANALYSIS_SECTION_HEADINGS.out_of_scope}\n${a.out_of_scope}`);
	lines.push("");
	lines.push(`## ${ANALYSIS_SECTION_HEADINGS.repro_status}\n${a.repro_status}`);
	return lines.join("\n");
}

/**
 * Parses `formatAnalysis`'s Markdown back into an `AnalysisReport`. Tolerant of the human deleting
 * or reordering sections (matched by heading text, not position) and of extra prose outside any
 * `## ` section. `open_questions` are `- ` bullets under "Open questions"; missing entirely means
 * none. Throws `ArtifactError` naming any missing required section (root cause, proposed change,
 * repro status — the same fields `applyAnalysis` requires).
 */
export function parseAnalysisMarkdown(md: string): AnalysisReport {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const sections = new Map<string, string[]>();
	let current: string | undefined;
	for (const line of lines) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			current = heading[1].trim().toLowerCase();
			if (!sections.has(current)) sections.set(current, []);
			continue;
		}
		if (/^#\s+/.test(line)) {
			current = undefined; // top-level title (or a stray "# ..."): not a section body
			continue;
		}
		if (current) sections.get(current)!.push(line);
	}

	const sectionText = (heading: string): string => {
		const body = sections.get(heading.toLowerCase());
		if (!body) return "";
		return body.join("\n").trim();
	};

	const values: Partial<Record<keyof AnalysisReport, string>> = {};
	const missing: string[] = [];
	for (const { key, heading } of REQUIRED_ANALYSIS_SECTIONS) {
		const text = sectionText(heading);
		values[key] = text;
		if (!text) missing.push(heading);
	}
	if (missing.length > 0) {
		throw new ArtifactError(`Edited analysis is missing required section(s): ${missing.join(", ")}.`);
	}

	const openQuestionsBody = sections.get("open questions") ?? [];
	const open_questions = openQuestionsBody
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2).trim())
		.filter((l) => l.length > 0);

	return {
		root_cause: values.root_cause ?? "",
		proposed_change: values.proposed_change ?? "",
		out_of_scope: sectionText(ANALYSIS_SECTION_HEADINGS.out_of_scope),
		repro_status: values.repro_status ?? "",
		open_questions,
	};
}

// ---------------------------------------------------------------------------
// 3. Analyze -> Plan / Awaiting approval
// ---------------------------------------------------------------------------

export function applyAnalysis(state: WorkflowState, a: AnalysisParams): WorkflowState {
	if (state.phase !== "analyze") {
		throw new ArtifactError(`Cannot submit an analysis report while in phase "${state.phase}"; expected "analyze".`);
	}
	const missing: string[] = [];
	if (!a.root_cause.trim()) missing.push("root_cause");
	if (!a.proposed_change.trim()) missing.push("proposed_change");
	if (!a.repro_status.trim()) missing.push("repro_status");
	if (missing.length > 0) {
		throw new ArtifactError(`Analysis report is missing required field(s): ${missing.join(", ")}.`);
	}

	let rootCause = a.root_cause;
	const pending = state.escalations.filter((e) => e.phase === "analyze");
	if (pending.length > 0) {
		const folded = pending.map((e) => `- Q: ${e.question} -> A: ${e.decision}`).join("\n");
		rootCause = `${rootCause}\n\nEscalation decisions:\n${folded}`;
	}

	const analysis = { ...a, root_cause: rootCause };
	// A Verify bounce back to Analyze (wrong_root_cause) must re-arm the human stop gate even on a
	// preApproved run: verify.md — "Re-entering Phase 1 re-arms its stop gate." `state.failures`
	// being non-empty means this analysis follows at least one Verify attempt, so it always goes
	// through approval again.
	const next =
		state.preApproved && a.open_questions.length === 0 && state.failures.length === 0 ? "plan" : "awaiting_approval";
	return transition({ ...state, analysis }, next);
}

// ---------------------------------------------------------------------------
// 4. Plan -> Delegate
// ---------------------------------------------------------------------------

export function validatePlan(plan: PlanParams): string[] {
	const problems: string[] = [];

	if (plan.tasks.length === 0) {
		problems.push("Plan must contain at least one task.");
		return problems;
	}

	const seenIds = new Set<string>();
	const ids = new Set(plan.tasks.map((t) => t.id));
	for (const task of plan.tasks) {
		if (!task.id.trim()) {
			problems.push("Task has an empty id.");
		} else if (seenIds.has(task.id)) {
			problems.push(`Duplicate task id "${task.id}".`);
		} else {
			seenIds.add(task.id);
		}

		if (!task.spec.trim()) {
			problems.push(`Task "${task.id}" has an empty spec.`);
		}

		if (task.verification_commands.length === 0) {
			problems.push(`Task "${task.id}" has no verification_commands.`);
		}

		for (const dep of task.dependencies) {
			if (dep === task.id) {
				problems.push(`Task "${task.id}" depends on itself.`);
			} else if (!ids.has(dep)) {
				problems.push(`Task "${task.id}" depends on unknown task "${dep}".`);
			}
		}
	}

	// Cycle detection (only over known ids, so an unknown dependency doesn't also report a false cycle).
	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color = new Map<string, number>();
	for (const t of plan.tasks) color.set(t.id, WHITE);
	const byId = new Map(plan.tasks.map((t) => [t.id, t]));
	let hasCycle = false;
	const visit = (id: string) => {
		if (hasCycle) return;
		color.set(id, GRAY);
		const task = byId.get(id);
		if (task) {
			for (const dep of task.dependencies) {
				if (!ids.has(dep)) continue;
				const c = color.get(dep);
				if (c === GRAY) {
					hasCycle = true;
					return;
				}
				if (c === WHITE) visit(dep);
			}
		}
		color.set(id, BLACK);
	};
	for (const t of plan.tasks) {
		if (color.get(t.id) === WHITE) visit(t.id);
	}
	if (hasCycle) {
		problems.push("Plan has a dependency cycle.");
	}

	const worktreeTasks = plan.tasks.filter((t) => t.workspace === "worktree");
	if (worktreeTasks.length > 1) {
		if (!plan.merge_plan) {
			problems.push("More than one task runs in a worktree; merge_plan is required.");
		} else {
			const worktreeIds = new Set(worktreeTasks.map((t) => t.id));
			const orderCounts = new Map<string, number>();
			for (const id of plan.merge_plan.order) {
				orderCounts.set(id, (orderCounts.get(id) ?? 0) + 1);
			}
			const missingFromOrder = [...worktreeIds].filter((id) => !orderCounts.has(id));
			const extraInOrder = plan.merge_plan.order.filter((id) => !worktreeIds.has(id));
			const duplicated = [...orderCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
			if (missingFromOrder.length > 0) {
				problems.push(`merge_plan.order is missing worktree task(s): ${missingFromOrder.join(", ")}.`);
			}
			if (extraInOrder.length > 0) {
				problems.push(`merge_plan.order references non-worktree task(s): ${extraInOrder.join(", ")}.`);
			}
			if (duplicated.length > 0) {
				problems.push(`merge_plan.order lists task(s) more than once: ${duplicated.join(", ")}.`);
			}
			if (!plan.merge_plan.conflict_owner.trim()) {
				problems.push("merge_plan.conflict_owner is required.");
			}
		}
	}

	return problems;
}

export function applyPlan(state: WorkflowState, plan: PlanParams): WorkflowState {
	if (state.phase !== "plan") {
		throw new ArtifactError(`Cannot submit a plan while in phase "${state.phase}"; expected "plan".`);
	}
	const problems = validatePlan(plan);
	if (problems.length > 0) {
		throw new ArtifactError(`Plan is invalid:\n- ${problems.join("\n- ")}`);
	}
	const taskList: TaskList = { tasks: plan.tasks, merge_plan: plan.merge_plan };
	return transition({ ...state, plan: taskList }, "delegate");
}

// ---------------------------------------------------------------------------
// 5. Delegate -> Supervise
// ---------------------------------------------------------------------------

export const STANDING_INSTRUCTIONS =
	"Report what changed and what was verified. When the spec doesn't cover something, write a line starting with " +
	'"SPEC GAP: <question>" and stop instead of improvising scope. ' +
	"Do not commit; the coordinator merges. Run the verification commands before reporting done.";

export function buildPackets(plan: TaskList) {
	return plan.tasks.map((task) => ({
		task_id: task.id,
		spec: task.spec,
		verification_commands: task.verification_commands,
		standing_instructions: STANDING_INSTRUCTIONS,
	}));
}

export function topologicalWaves(tasks: PlanTask[]): PlanTask[][] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const remainingDeps = new Map<string, Set<string>>();
	for (const t of tasks) {
		remainingDeps.set(t.id, new Set(t.dependencies.filter((d) => byId.has(d))));
	}

	const waves: PlanTask[][] = [];
	const placed = new Set<string>();
	while (placed.size < tasks.length) {
		const wave = tasks.filter((t) => !placed.has(t.id) && [...remainingDeps.get(t.id)!].every((d) => placed.has(d)));
		if (wave.length === 0) {
			// Defensive: shouldn't happen for a validated plan (no cycles), but avoid an infinite loop.
			waves.push(tasks.filter((t) => !placed.has(t.id)));
			break;
		}
		waves.push(wave);
		for (const t of wave) placed.add(t.id);
	}
	return waves;
}

// ---------------------------------------------------------------------------
// 7. Supervise -> Verify
// ---------------------------------------------------------------------------

export function applyReview(state: WorkflowState, r: ReviewParams, mergedDiff: string): WorkflowState {
	if (state.phase !== "supervise") {
		throw new ArtifactError(`Cannot submit a review while in phase "${state.phase}"; expected "supervise".`);
	}
	if (!mergedDiff.trim()) {
		throw new ArtifactError("no changes to review");
	}
	const review = {
		merged_diff: mergedDiff,
		overrides: r.overrides,
		tests_kept: r.tests_kept,
		tests_cut: r.tests_cut,
	};
	return transition({ ...state, review, lastGates: [] }, "verify");
}

// ---------------------------------------------------------------------------
// 8. Verify gate bookkeeping
// ---------------------------------------------------------------------------

export function requiredGateCommands(state: WorkflowState): string[] {
	const seen = new Set<string>();
	const commands: string[] = [];
	for (const task of state.plan?.tasks ?? []) {
		for (const cmd of task.verification_commands) {
			if (!seen.has(cmd)) {
				seen.add(cmd);
				commands.push(cmd);
			}
		}
	}
	return commands;
}

// ---------------------------------------------------------------------------
// 9. Verify
// ---------------------------------------------------------------------------

export type VerifyOutcome =
	| { kind: "deliver"; state: WorkflowState }
	| { kind: "retry"; state: WorkflowState; failure: FailureRecord }
	| { kind: "escalate"; state: WorkflowState; failure: FailureRecord }
	| { kind: "stop"; state: WorkflowState; report: string };

function gatesSatisfy(lastGates: GateResult[], required: string[]): { ok: boolean; missing: string[]; failing: string[] } {
	const byCommand = new Map<string, GateResult>();
	for (const g of lastGates) byCommand.set(g.command.trim(), g);

	const missing: string[] = [];
	const failing: string[] = [];
	for (const cmd of required) {
		const result = byCommand.get(cmd.trim());
		if (!result) {
			missing.push(cmd);
		} else if (result.exit_code !== 0) {
			failing.push(cmd);
		}
	}
	for (const g of lastGates) {
		if (g.exit_code !== 0 && !failing.includes(g.command)) failing.push(g.command);
	}
	return { ok: missing.length === 0 && failing.length === 0, missing, failing };
}

function formatFailureHistory(failures: FailureRecord[]): string {
	return failures
		.map((f) => `- Attempt ${f.attempt_number}: ${f.failure_class} -> ${f.destination}. ${f.summary}`)
		.join("\n");
}

export function applyVerification(state: WorkflowState, v: VerificationParams): VerifyOutcome {
	if (state.phase !== "verify") {
		throw new ArtifactError(`Cannot submit verification while in phase "${state.phase}"; expected "verify".`);
	}

	if (v.outcome === "pass") {
		if (state.ciFailure) {
			const names = state.ciFailure.failed.map((c) => c.name).join(", ");
			throw new ArtifactError(
				`Cannot report pass: CI failed for PR ${state.ciFailure.pr.url} (${names || "unknown check(s)"}) and must be classified as a failure (submit_verification fail) first.`,
			);
		}
		const required = requiredGateCommands(state);
		if (state.lastGates.length === 0) {
			throw new ArtifactError("Cannot report pass: no gates have been run yet (lastGates is empty).");
		}
		const { ok, missing, failing } = gatesSatisfy(state.lastGates, required);
		if (!ok) {
			const parts: string[] = [];
			if (missing.length > 0) parts.push(`missing required command(s): ${missing.join(", ")}`);
			if (failing.length > 0) parts.push(`failing command(s): ${failing.join(", ")}`);
			throw new ArtifactError(`Cannot report pass: ${parts.join("; ")}.`);
		}
		const blockedHooks = state.lastHooks.filter((h) => h.blocked);
		if (blockedHooks.length > 0) {
			const parts = blockedHooks.map((h) => `${h.source} hook \`${h.command}\`: ${h.reason}`);
			throw new ArtifactError(`Cannot report pass: stop hook(s) blocked: ${parts.join("; ")}.`);
		}
		if (!v.functional_proof.trim()) {
			throw new ArtifactError("Cannot report pass: functional_proof is required.");
		}
		const evidence = {
			gates_run: state.lastGates,
			functional_proof: v.functional_proof,
			retry_count: state.failures.length,
		};
		const next = transition({ ...state, evidence }, "deliver");
		return { kind: "deliver", state: next };
	}

	// outcome === "fail"
	if (!v.failure_class) {
		throw new ArtifactError("Cannot report fail: failure_class is required.");
	}
	if (!v.failure_summary?.trim()) {
		throw new ArtifactError("Cannot report fail: failure_summary is required.");
	}

	// A fail submitted while a CI failure is on record classifies it: fold the failed check names
	// into the summary and clear ciFailure so the harness doesn't keep rejecting a future pass for it.
	let failureSummary = v.failure_summary;
	if (state.ciFailure) {
		const names = state.ciFailure.failed.map((c) => c.name).join(", ");
		failureSummary = `${failureSummary} (CI failed for PR ${state.ciFailure.pr.url}: ${names || "unknown check(s)"})`;
		state = { ...state, ciFailure: undefined };
	}

	const attempt_number = state.failures.length + 1;
	const destination: "supervise" | "analyze" = v.failure_class === "wrong_root_cause" ? "analyze" : "supervise";
	const failure: FailureRecord = {
		attempt_number,
		failure_class: v.failure_class,
		destination,
		summary: failureSummary,
	};

	const priorEscalated = state.failures.some((f) => f.escalation_answer !== undefined);

	if (priorEscalated) {
		// Attempt >= 3: stop, do not route further.
		const stopped = { ...state, failures: [...state.failures, failure] };
		const finalState = transition(stopped, "stopped");
		const finalState2 = { ...finalState, stopReason: "Verify failed again after an escalation; stopping for the user." };
		const escalationEntry = [...state.escalations].reverse().find((e) => e.phase === "verify");
		const priorFailureWithAnswer = state.failures.find((f) => f.escalation_answer !== undefined);
		const failingGates = state.lastGates.filter((g) => g.exit_code !== 0);
		const reportLines: string[] = [];
		reportLines.push("# Verify stopped");
		reportLines.push("");
		reportLines.push("## Prior attempts");
		reportLines.push(formatFailureHistory(state.failures));
		reportLines.push("");
		if (escalationEntry || priorFailureWithAnswer) {
			reportLines.push("## Escalation");
			if (escalationEntry) {
				reportLines.push(`- Question: ${escalationEntry.question}`);
				reportLines.push(`- Answer: ${escalationEntry.decision}`);
			} else if (priorFailureWithAnswer?.escalation_answer) {
				reportLines.push(`- Answer: ${priorFailureWithAnswer.escalation_answer}`);
			}
			reportLines.push("");
		}
		reportLines.push("## Latest failure");
		reportLines.push(`- ${failureSummary}`);
		if (failingGates.length > 0) {
			reportLines.push(`- Failing gates: ${failingGates.map((g) => g.command).join(", ")}`);
		}
		const report = reportLines.join("\n");
		return { kind: "stop", state: finalState2, report };
	}

	if (attempt_number === 1) {
		const next = transition({ ...state, failures: [...state.failures, failure] }, destination);
		return { kind: "retry", state: next, failure };
	}

	// attempt_number === 2: escalate, phase unchanged (still "verify").
	const next = { ...state, failures: [...state.failures, failure] };
	return { kind: "escalate", state: next, failure };
}

export function resolveEscalatedFailure(state: WorkflowState, answer: string): WorkflowState {
	if (state.failures.length === 0) {
		throw new ArtifactError("Cannot resolve an escalated failure: there is no failure on record.");
	}
	const failures = [...state.failures];
	const last = failures[failures.length - 1];
	failures[failures.length - 1] = { ...last, escalation_answer: answer };
	return transition({ ...state, failures }, last.destination);
}

// ---------------------------------------------------------------------------
// 10. Deliver
// ---------------------------------------------------------------------------

export const CONVENTIONAL_COMMIT = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w\-./ ]+\))?!?: \S.*/;

export function validateCommitSubjects(subjects: string[]): string[] {
	return subjects.filter((s) => !CONVENTIONAL_COMMIT.test(s));
}

/**
 * `pr`, when given, is a known open pull request for the pushed commit: delivery routes to "ci"
 * instead of "done" so the harness watches its checks before the run completes.
 */
export function applyDelivery(state: WorkflowState, d: DeliveryParams, commitSubjects: string[], pr?: PullRequestRef): WorkflowState {
	if (state.phase !== "deliver") {
		throw new ArtifactError(`Cannot submit delivery while in phase "${state.phase}"; expected "deliver".`);
	}
	if (commitSubjects.length === 0 && !d.no_commit_reason?.trim()) {
		throw new ArtifactError("Cannot report delivery: no commits were made and no_commit_reason is missing.");
	}
	const offending = validateCommitSubjects(commitSubjects);
	if (offending.length > 0) {
		throw new ArtifactError(`Cannot report delivery: commit subject(s) are not conventional commits: ${offending.join(", ")}.`);
	}
	if (!d.report.trim()) {
		throw new ArtifactError("Cannot report delivery: report is required.");
	}
	const delivery = {
		commits: commitSubjects,
		no_commit_reason: d.no_commit_reason,
		report: d.report,
	};
	const withPr = pr ? { ...state, pr } : state;
	return transition({ ...withPr, delivery }, pr ? "ci" : "done");
}

// ---------------------------------------------------------------------------
// 11. Summarize
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function summarizeState(state: WorkflowState): string {
	const lines: string[] = [];
	lines.push(`# Prior state for "${state.task}"`);
	lines.push(`Phase: ${state.phase}`);

	if (state.analysis) {
		lines.push("");
		lines.push("## Analysis");
		lines.push(`- root_cause: ${truncate(state.analysis.root_cause, 600)}`);
		lines.push(`- proposed_change: ${truncate(state.analysis.proposed_change, 400)}`);
		lines.push(`- out_of_scope: ${truncate(state.analysis.out_of_scope, 200)}`);
		lines.push(`- repro_status: ${truncate(state.analysis.repro_status, 200)}`);
		if (state.analysis.open_questions.length > 0) {
			lines.push(`- open_questions: ${state.analysis.open_questions.join("; ")}`);
		}
	}

	if (state.plan) {
		lines.push("");
		lines.push("## Plan");
		for (const t of state.plan.tasks) {
			lines.push(`- ${t.id} [${t.executor_tier}/${t.workspace}] deps=${t.dependencies.join(",") || "none"}`);
		}
		if (state.plan.merge_plan) {
			lines.push(`- merge order: ${state.plan.merge_plan.order.join(" -> ")}, owner: ${state.plan.merge_plan.conflict_owner}`);
		}
	}

	if (state.runs.length > 0) {
		lines.push("");
		lines.push("## Runs");
		for (const r of state.runs) {
			lines.push(`- ${r.task_id}: ${r.status}${r.error ? ` (${truncate(r.error, 150)})` : ""}`);
		}
	}

	if (state.review) {
		lines.push("");
		lines.push("## Review");
		lines.push(`- overrides: ${state.review.overrides.join("; ") || "none"}`);
		lines.push(`- tests_kept: ${state.review.tests_kept.join("; ") || "none"}`);
		lines.push(`- tests_cut: ${state.review.tests_cut.join("; ") || "none"}`);
	}

	if (state.failures.length > 0) {
		lines.push("");
		lines.push("## Failures");
		lines.push(formatFailureHistory(state.failures));
	}

	if (state.escalations.length > 0) {
		lines.push("");
		lines.push("## Escalations");
		for (const e of state.escalations) {
			lines.push(`- [${e.phase}] Q: ${truncate(e.question, 200)} -> A: ${truncate(e.decision, 200)}`);
		}
	}

	if (state.delivery) {
		lines.push("");
		lines.push("## Delivery");
		lines.push(`- commits: ${state.delivery.commits.join("; ") || "none"}`);
		if (state.delivery.no_commit_reason) lines.push(`- no_commit_reason: ${state.delivery.no_commit_reason}`);
	}

	const result = lines.join("\n");
	return result.length > 4000 ? `${result.slice(0, 3990)}\n...(truncated)` : result;
}
