/**
 * Workflow state for the code-changes graph.
 *
 * This file is the shared contract: every other module reads and writes these types.
 * State is persisted with `pi.appendEntry(STATE_ENTRY, state)` on every transition and
 * restored from the active branch on `session_start`.
 */

import type { GateAdvice, GateHistoryItem, GateKind } from "./gatelog.ts";

export const STATE_ENTRY = "code-changes-state";

export type Phase =
	| "analyze"
	| "awaiting_approval"
	| "plan"
	| "awaiting_plan_approval"
	| "delegate"
	| "supervise"
	| "verify"
	| "deliver"
	| "ci"
	| "done"
	| "stopped";

export const PHASE_LABEL: Record<Phase, string> = {
	analyze: "Analyze",
	awaiting_approval: "Awaiting approval",
	plan: "Plan",
	awaiting_plan_approval: "Awaiting plan approval",
	delegate: "Delegate",
	supervise: "Supervise",
	verify: "Verify",
	deliver: "Deliver",
	ci: "CI checks",
	done: "Done",
	stopped: "Stopped",
};

/** Which Phase 1 door the task came in through (SKILL.md "Special cases"). */
export type EntryKind = "analyze" | "issue-triage" | "pr-review-comments";

export type Tier = "escalation" | "coordinator" | "implementer" | "trivial";
export type ExecutorTier = "trivial" | "implementer" | "coordinator-direct";

// Analyze → Plan
/** What kind of request the analysis found; selects headings, guidance and whether a change is expected. */
export type AnalysisKind = "bug" | "feature" | "refactor" | "question" | "investigation" | "chore";

export const ANALYSIS_KINDS: readonly AnalysisKind[] = ["bug", "feature", "refactor", "question", "investigation", "chore"];

/** A candidate approach the human can pick at the gate. */
export interface AnalysisOption {
	id: string;
	title: string;
	summary: string;
	tradeoffs: string;
	/** True when this option needs no repository change; choosing it ends the run with the analysis as the deliverable. */
	no_change?: boolean;
}

export interface AnalysisReport {
	kind: AnalysisKind;
	/** Bug: root cause. Feature: current behavior and where it fits. Refactor: what the current code does. Question: the answer. */
	findings: string;
	/** Scope of the change to plan from; may be empty for question/investigation (nothing to implement). */
	proposed_change: string;
	out_of_scope: string;
	/** Bug: reproduction. Feature: prior art. Question: sources. Otherwise the evidence the findings rest on. */
	evidence: string;
	open_questions: string[];
	/** Alternative approaches with trade-offs, when there is a real choice to make. */
	options?: AnalysisOption[];
	/** Id of the recommended option. */
	recommendation?: string;
	/** Id of the option the human picked at the gate. */
	chosen_option?: string;
}

// Plan → Delegate
export interface PlanTask {
	id: string;
	spec: string;
	verification_commands: string[];
	executor_tier: ExecutorTier;
	workspace: "main" | "worktree";
	dependencies: string[];
	/** Repo-relative folders, files or globs this task may change. Required for sub-agent tasks. */
	paths?: string[];
	/** Keep this task in the main tree even when it could run in a worktree (needs uncommitted local changes). */
	requires_main_tree?: boolean;
}

export interface TaskList {
	tasks: PlanTask[];
	/** Required when more than one task runs in a worktree: merge order and who resolves conflicts. */
	merge_plan?: {
		order: string[];
		conflict_owner: string;
	};
}

// Delegate → Supervise
export interface DelegationPacket {
	task_id: string;
	spec: string;
	verification_commands: string[];
	standing_instructions: string;
}

export interface TaskRun {
	task_id: string;
	status: "pending" | "running" | "succeeded" | "failed" | "coordinator";
	model?: string;
	worktree?: string;
	branch?: string;
	/** Last assistant text from the implementer. */
	report?: string;
	error?: string;
	merged?: boolean;
	conflict?: boolean;
	/** Spec gaps the implementer reported (lines starting with "SPEC GAP:"), across all attempts. */
	spec_gaps?: string[];
	/** Changed files outside the task's declared paths. */
	out_of_scope?: string[];
	/** True when the harness moved a main-tree task into a worktree to run it in parallel. */
	auto_worktree?: boolean;
	/** True when the implementer was killed for exceeding its time budget. */
	stalled?: boolean;
	/** True once repeated spec gaps on this task were escalated (escalate.md trigger). */
	escalated?: boolean;
	/** How many times the coordinator resumed this task with an answer (resume_task). */
	resumes?: number;
}

// Supervise → Verify
export interface ReviewedDiff {
	/** Computed by the extension from git, never supplied by the model. */
	merged_diff: string;
	overrides: string[];
	tests_kept: string[];
	tests_cut: string[];
}

// Quality gates actually executed by the extension.
export interface GateResult {
	command: string;
	exit_code: number;
	/** Shell the command ran in, e.g. "bash (C:/Program Files/Git/bin/bash.exe)" or "cmd.exe". */
	shell?: string;
	/** False when the command could not run at all (program not found): a harness/environment problem, not a product failure. */
	runnable?: boolean;
	/** Truncated combined output. */
	output: string;
	duration_ms: number;
}

// Verify → Supervise / Analyze
export type FailureClass = "gate_failure" | "spec_mismatch" | "wrong_root_cause";

export interface FailureRecord {
	attempt_number: number;
	failure_class: FailureClass;
	destination: "supervise" | "analyze";
	summary: string;
	escalation_answer?: string;
	/** True when every failing gate was not runnable; such failures do not count toward the retry cap. */
	harness?: boolean;
}

/** A human-approved change to the plan's required gates. */
export interface GateAmendment {
	/** Gate being replaced or removed. */
	old: string;
	/** Replacement; undefined removes the gate. */
	new?: string;
	reason: string;
	phase: Phase;
	approved_at: string;
}

// Verify → Deliver
export interface VerificationEvidence {
	gates_run: GateResult[];
	functional_proof: string;
	retry_count: number;
}

// Escalate (side-call)
export interface Escalation {
	phase: Phase;
	question: string;
	evidence: string;
	hypothesis: string;
	model: string;
	decision: string;
}

// Stop hooks discovered from Claude Code / GitHub Copilot config files.
export interface HookResult {
	/** "claude" (.claude/settings*.json Stop) or "copilot" (.github/hooks/*.json agentStop). */
	source: "claude" | "copilot";
	command: string;
	exit_code: number;
	/** True when the hook asked to block the stop (decision "block" or exit code 2). */
	blocked: boolean;
	/** Block reason, stderr, or truncated output. */
	reason: string;
	duration_ms: number;
}

// Pull request checks watched after Deliver.
export interface PullRequestRef {
	number: number;
	url: string;
	/** Commit the checks must belong to (local HEAD at push time). */
	headSha: string;
}

export interface CheckRun {
	name: string;
	/** Normalized: pending | pass | fail | skipping | cancel. */
	bucket: "pending" | "pass" | "fail" | "skipping" | "cancel";
	link: string;
	workflow?: string;
}

export interface CiFailure {
	pr: PullRequestRef;
	failed: CheckRun[];
	/** Truncated failed-job logs. */
	logs: string;
}

export interface Delivery {
	commits: string[];
	no_commit_reason?: string;
	report: string;
}

export interface WorkflowState {
	id: string;
	task: string;
	phase: Phase;
	/** `git rev-parse HEAD` when the run started; undefined outside a git repo. */
	baseRef?: string;
	/** Active tool names when /change started, restored when the run ends. */
	baselineTools: string[];
	/** Set when the user gave the go in the request itself (`/change --approved`). */
	preApproved: boolean;
	/** Phase 1 entry point; selects the Analyze reference and Deliver extras. */
	entry: EntryKind;
	/** Issue or PR number/URL for the issue-triage / pr-review-comments entries. */
	entryRef?: string;
	/** Push, PR creation and PR/issue replies are blocked unless the user allowed them. */
	pushAllowed: boolean;
	/** True when the human edited the analysis at the approval gate. */
	analysisEditedByHuman?: boolean;
	/** True when the human edited the plan at the plan approval gate. */
	planEditedByHuman?: boolean;
	/** Human decisions at the analysis/plan gates so far in this run, oldest first. */
	gateHistory?: GateHistoryItem[];
	/** Gate advisor suggestion for the gate currently open, cached so a re-open does not ask again. */
	gateAdvice?: { gate: GateKind; advice: GateAdvice };
	/** Continuations after transient provider errors pi did not retry itself; reset on every phase change. */
	transientRetries?: number;
	analysis?: AnalysisReport;
	plan?: TaskList;
	packets: DelegationPacket[];
	runs: TaskRun[];
	review?: ReviewedDiff;
	/** Results of the most recent run_gates call in Verify. */
	lastGates: GateResult[];
	failures: FailureRecord[];
	escalations: Escalation[];
	evidence?: VerificationEvidence;
	delivery?: Delivery;
	/** Most recent stop-hook results (also required green for a Verify pass). */
	lastHooks: HookResult[];
	/** Pull request being watched in the "ci" phase. */
	pr?: PullRequestRef;
	/** Set when CI failed; Verify cannot pass until it is classified as a failure and fixed. */
	ciFailure?: CiFailure;
	/** Human-approved changes to the required gates (applied on top of the plan's verification commands). */
	gateAmendments?: GateAmendment[];
	/** Phase the run was in when it stopped; /change resume can reopen it with the user's go. */
	stoppedFrom?: Phase;
	/** Summary of the previous run in this session, carried into a follow-up run's prompts. */
	previousRun?: string;
	/** Human-readable reason when phase is "stopped". */
	stopReason?: string;
	/** True once the next-phase prompt for the current phase has been sent. */
	phasePromptSent: boolean;
}

export interface NewStateOptions {
	preApproved?: boolean;
	entry?: EntryKind;
	entryRef?: string;
	pushAllowed?: boolean;
}

export function newState(task: string, baselineTools: string[], baseRef: string | undefined, opts: NewStateOptions = {}): WorkflowState {
	return {
		id: Date.now().toString(36),
		task,
		phase: "analyze",
		baseRef,
		baselineTools,
		preApproved: opts.preApproved ?? false,
		entry: opts.entry ?? "analyze",
		entryRef: opts.entryRef,
		pushAllowed: opts.pushAllowed ?? false,
		packets: [],
		runs: [],
		lastGates: [],
		lastHooks: [],
		failures: [],
		escalations: [],
		phasePromptSent: false,
	};
}

export function isActive(state: WorkflowState | undefined): state is WorkflowState {
	return state !== undefined && state.phase !== "done" && state.phase !== "stopped";
}

/** Legal edges of the graph. Transitions outside this table are bugs. */
export const EDGES: Record<Phase, Phase[]> = {
	analyze: ["awaiting_approval", "plan", "stopped"],
	// "done" here is the issue-triage deliverable: the analysis itself was the product.
	awaiting_approval: ["plan", "analyze", "done", "stopped"],
	// "delegate" directly only when the user gave the go up front (/change --approved).
	plan: ["awaiting_plan_approval", "delegate", "stopped"],
	awaiting_plan_approval: ["delegate", "plan", "stopped"],
	delegate: ["supervise", "stopped"],
	supervise: ["verify", "stopped"],
	verify: ["supervise", "analyze", "deliver", "stopped"],
	deliver: ["done", "ci", "stopped"],
	ci: ["done", "verify", "stopped"],
	done: [],
	// Reopened only by the user (/change resume after a stop); the retry count is reset then.
	stopped: ["analyze", "plan", "supervise", "verify", "deliver"],
};

export function transition(state: WorkflowState, to: Phase): WorkflowState {
	if (!EDGES[state.phase].includes(to)) {
		throw new Error(`Illegal transition ${state.phase} → ${to}`);
	}
	return { ...state, phase: to, phasePromptSent: false, transientRetries: 0 };
}

/** Rebuild state from the active branch: the last STATE_ENTRY custom entry wins. */
export function restoreState(branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): WorkflowState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			return migrateState(entry.data as WorkflowState | undefined);
		}
	}
	return undefined;
}

/** Upgrades state persisted by older versions (analysis used root_cause / repro_status, no kind). */
export function migrateState(state: WorkflowState | undefined): WorkflowState | undefined {
	const analysis = state?.analysis as (Partial<AnalysisReport> & { root_cause?: string; repro_status?: string }) | undefined;
	if (!state || !analysis || analysis.kind !== undefined) return state;
	const { root_cause, repro_status, ...rest } = analysis;
	return {
		...state,
		analysis: {
			...rest,
			kind: "bug",
			findings: rest.findings ?? root_cause ?? "",
			evidence: rest.evidence ?? repro_status ?? "",
			proposed_change: rest.proposed_change ?? "",
			out_of_scope: rest.out_of_scope ?? "",
			open_questions: rest.open_questions ?? [],
		},
	};
}
