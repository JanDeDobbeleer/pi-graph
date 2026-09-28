/**
 * Workflow state for the code-changes graph.
 *
 * This file is the shared contract: every other module reads and writes these types.
 * State is persisted with `pi.appendEntry(STATE_ENTRY, state)` on every transition and
 * restored from the active branch on `session_start`.
 */

export const STATE_ENTRY = "code-changes-state";

export type Phase =
	| "analyze"
	| "awaiting_approval"
	| "plan"
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
	delegate: "Delegate",
	supervise: "Supervise",
	verify: "Verify",
	deliver: "Deliver",
	ci: "CI checks",
	done: "Done",
	stopped: "Stopped",
};

export type Tier = "escalation" | "coordinator" | "implementer" | "trivial";
export type ExecutorTier = "trivial" | "implementer" | "coordinator-direct";

// Analyze → Plan
export interface AnalysisReport {
	root_cause: string;
	proposed_change: string;
	out_of_scope: string;
	repro_status: string;
	open_questions: string[];
}

// Plan → Delegate
export interface PlanTask {
	id: string;
	spec: string;
	verification_commands: string[];
	executor_tier: ExecutorTier;
	workspace: "main" | "worktree";
	dependencies: string[];
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
	/** Human-readable reason when phase is "stopped". */
	stopReason?: string;
	/** True once the next-phase prompt for the current phase has been sent. */
	phasePromptSent: boolean;
}

export function newState(task: string, baselineTools: string[], baseRef: string | undefined, preApproved: boolean): WorkflowState {
	return {
		id: Date.now().toString(36),
		task,
		phase: "analyze",
		baseRef,
		baselineTools,
		preApproved,
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
	awaiting_approval: ["plan", "analyze", "stopped"],
	plan: ["delegate", "stopped"],
	delegate: ["supervise", "stopped"],
	supervise: ["verify", "stopped"],
	verify: ["supervise", "analyze", "deliver", "stopped"],
	deliver: ["done", "ci", "stopped"],
	ci: ["done", "verify", "stopped"],
	done: [],
	stopped: [],
};

export function transition(state: WorkflowState, to: Phase): WorkflowState {
	if (!EDGES[state.phase].includes(to)) {
		throw new Error(`Illegal transition ${state.phase} → ${to}`);
	}
	return { ...state, phase: to, phasePromptSent: false };
}

/** Rebuild state from the active branch: the last STATE_ENTRY custom entry wins. */
export function restoreState(branch: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): WorkflowState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			return entry.data as WorkflowState | undefined;
		}
	}
	return undefined;
}
