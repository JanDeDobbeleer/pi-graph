/**
 * Entry point for the code-changes pi extension: wires the graph defined in `state.ts` /
 * `artifacts.ts` / `gates.ts` / `delegate.ts` / `models.ts` / `escalate.ts` into pi's extension
 * events, tools, and the `/change` command.
 *
 * This file is glue only: state transitions, validation, and side-effect-free helpers live in the
 * other modules. What lives here is: the mutable `state` variable, persistence, tool/model
 * switching per phase, and the pi event/tool registrations themselves.
 */

import { Type } from "typebox";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
	AgentBeforeSettleEventResult,
	TurnEndEventResult,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEventResult,
	ToolCallEventResult,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	ArtifactError,
	AnalysisSchema,
	DeliverySchema,
	PlanSchema,
	ReviewSchema,
	VerificationSchema,
	applyAnalysis,
	applyDelivery,
	applyPlan,
	applyReview,
	applyVerification,
	buildPackets,
	formatAnalysis,
	formatPlan,
	parseAnalysisMarkdown,
	parseEditablePlan,
	planToEditable,
	requiredGateCommands,
	resolveEscalatedFailure,
	validateCommitSubjects,
} from "./artifacts.ts";
import { CiWatcher, detectPrFromText, formatCiFailure, isPushCommand, resolvePr, type WatchResult } from "./ci.ts";
import { cleanupWorktrees, mergedDiff, runDelegation } from "./delegate.ts";
import { runEscalation } from "./escalate.ts";
import { decideToolCall, READ_ONLY_PHASES, toolsForPhase, WORKFLOW_TOOLS } from "./gates.ts";
import { discoverStopHooks, findRepoRoot, formatHookFeedback, hooksBlocked, runStopHooks, StopHookGuard, type StopHook } from "./hooks.ts";
import { loadMaxParallel, loadReadOnlyTools, loadTierConfig, modelRef, resolveTierModel, tierForExecutor } from "./models.ts";
import { phasePrompt, phaseReminder } from "./prompts.ts";
import { createResumeTaskTool, escalateSpecGaps, needsSpecGapEscalation, type ResumeDeps } from "./resume.ts";
import { isTransientProviderError, MAX_TRANSIENT_RETRIES, retryBackoff } from "./retry.ts";
import { git, runShell } from "./runner.ts";
import {
	newState,
	PHASE_LABEL,
	restoreState,
	STATE_ENTRY,
	transition,
	isActive,
	type AnalysisReport,
	type EntryKind,
	type FailureRecord,
	type GateResult,
	type Phase,
	type PullRequestRef,
	type TaskList,
	type TaskRun,
	type WorkflowState,
} from "./state.ts";

// Phases in which the model is prompted and must produce an artifact to advance.
const MODEL_DRIVEN_PHASES: ReadonlySet<Phase> = new Set(["analyze", "plan", "delegate", "supervise", "verify", "deliver"]);

const PHASE_PROMPT_MESSAGE = "code-changes-phase-prompt";

interface PhasePromptDetails {
	phase: Phase;
	runId: string;
	/** True when the prompt carries extra context (revise feedback, CI failure, failure record). */
	extra: boolean;
}

// Cap on automatic CI-triggered fix turns per PR per session when CI fails *outside* a /change
// run (inside a run the normal Verify retry cap already applies once routed back from "ci").
const CI_FIX_CAP = 2;

export default function codeChanges(pi: ExtensionAPI): void {
	let state: WorkflowState | undefined;

	// -------------------------------------------------------------------------
	// Extra read-only tools (from other extensions) activated in Analyze/Plan/Supervise/Verify.
	// Loaded once per session_start and refreshed on every /change start, same caching pattern as
	// the stop-hooks discovery below.
	// -------------------------------------------------------------------------

	let extraReadOnlyTools: string[] = [];

	function refreshReadOnlyTools(cwd: string): void {
		extraReadOnlyTools = loadReadOnlyTools(cwd);
	}

	// -------------------------------------------------------------------------
	// "code-changes-analysis" messages render as Markdown in the transcript. pi supplies
	// @earendil-works/pi-tui to extensions (docs/packages.md), so it is a peer dependency.
	// -------------------------------------------------------------------------

	pi.registerMessageRenderer<AnalysisReport>("code-changes-analysis", (message) => {
		const text = typeof message.content === "string"
			? message.content
			: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		return new Markdown(text, 1, 0, getMarkdownTheme());
	});

	pi.registerMessageRenderer<TaskList>("code-changes-plan", (message) => {
		const text = typeof message.content === "string"
			? message.content
			: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		return new Markdown(text, 1, 0, getMarkdownTheme());
	});

	// Phase prompts carry the full reference Markdown for the model; in the transcript they
	// collapse to a one-line header and expand with pi's expanded view.
	pi.registerMessageRenderer<PhasePromptDetails>(PHASE_PROMPT_MESSAGE, (message, options, theme) => {
		const text = typeof message.content === "string"
			? message.content
			: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		if (options.expanded) return new Markdown(text, 1, 0, getMarkdownTheme());
		const details = message.details;
		const phase = details ? PHASE_LABEL[details.phase] : "phase";
		const run = details ? ` (run ${details.runId})` : "";
		const extra = details?.extra ? " · with feedback" : "";
		return new Text(theme.fg("muted", `code-changes · ${phase} phase${run}${extra} · expand to read the instructions`), 1, 0);
	});

	// -------------------------------------------------------------------------
	// Stop hooks: discovered once per session_start (cached), re-discovered on /change start.
	// -------------------------------------------------------------------------

	interface HooksCache {
		repoRoot: string;
		hooks: StopHook[];
	}
	let hooksCache: HooksCache | undefined;
	let hooksDiscovered = false;
	const stopHookGuard = new StopHookGuard();

	async function discoverHooks(cwd: string, force = false): Promise<void> {
		if (hooksDiscovered && !force) return;
		hooksDiscovered = true;
		const repoRoot = await findRepoRoot(cwd);
		if (!repoRoot) {
			hooksCache = undefined;
			return;
		}
		const { hooks } = discoverStopHooks(repoRoot);
		hooksCache = hooks.length > 0 ? { repoRoot, hooks } : undefined;
	}

	// -------------------------------------------------------------------------
	// CI watching
	// -------------------------------------------------------------------------

	const ciWatcher = new CiWatcher();
	/** Automatic CI-fix-turn counters, keyed by PR number, for failures seen outside a /change run. */
	const ciFixCounters = new Map<number, number>();
	let ciProgress: { prNumber: number; pending: number } | undefined;

	// -------------------------------------------------------------------------
	// State plumbing
	// -------------------------------------------------------------------------

	function persist(): void {
		pi.appendEntry(STATE_ENTRY, state);
	}

	function applyPhaseTools(): void {
		const current = state;
		if (!current) return;
		if (current.phase === "done" || current.phase === "stopped") {
			pi.setActiveTools(current.baselineTools);
		} else {
			const registered = pi.getAllTools().map((t) => t.name);
			pi.setActiveTools(toolsForPhase(current.phase, registered, extraReadOnlyTools));
		}
	}

	function runsWidgetLines(runs: TaskRun[]): string[] {
		return runs.map((r) => {
			const bits = [r.task_id, r.status];
			if (r.conflict) bits.push("conflict");
			return `- ${bits.join(" ")}`;
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!isActive(state)) {
			ctx.ui.setStatus("code-changes", undefined);
			ctx.ui.setWidget("code-changes-runs", undefined);
			return;
		}
		if (state.phase === "ci" && state.pr) {
			const progress = ciProgress && ciProgress.prNumber === state.pr.number ? ` (pending ${ciProgress.pending})` : "";
			ctx.ui.setStatus("code-changes", `⚙ CI checks: PR #${state.pr.number}${progress}`);
			ctx.ui.setWidget("code-changes-runs", undefined);
			return;
		}
		ctx.ui.setStatus("code-changes", `⚙ ${PHASE_LABEL[state.phase]}`);
		if ((state.phase === "delegate" || state.phase === "supervise") && state.runs.length > 0) {
			ctx.ui.setWidget("code-changes-runs", runsWidgetLines(state.runs));
		} else {
			ctx.ui.setWidget("code-changes-runs", undefined);
		}
	}

	function setState(next: WorkflowState, ctx: ExtensionContext): void {
		state = next;
		applyPhaseTools();
		persist();
		updateStatus(ctx);
	}

	// -------------------------------------------------------------------------
	// Escalation side-call, shared by submit_verification, escalate, and resume_task's
	// repeated-spec-gap trigger (resume.ts's ResumeDeps.escalate).
	// -------------------------------------------------------------------------

	async function runResumeEscalation(
		q: { question: string; evidence: string; hypothesis: string },
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ decision: string; model: string }> {
		const config = loadTierConfig(ctx.cwd);
		const resolved = resolveTierModel(ctx.modelRegistry, config, "escalation", ctx.model);
		if (!resolved.model) {
			throw new Error("escalate: no model resolved for the escalation tier.");
		}
		const { decision } = await runEscalation(ctx.modelRegistry, resolved.model, { phase: "supervise", ...q }, signal);
		return { decision, model: modelRef(resolved.model) };
	}

	// -------------------------------------------------------------------------
	// Coordinator model switching
	// -------------------------------------------------------------------------

	async function applyCoordinatorModel(ctx: ExtensionContext): Promise<void> {
		if (!state) return;
		const config = loadTierConfig(ctx.cwd);
		const resolved = resolveTierModel(ctx.modelRegistry, config, "coordinator", ctx.model);
		if (resolved.fellBack && resolved.ref) {
			ctx.ui.notify(`code-changes: could not resolve coordinator model "${resolved.ref}"; staying on the current model.`, "warning");
		}
		if (resolved.model && (!ctx.model || modelRef(resolved.model) !== modelRef(ctx.model))) {
			await pi.setModel(resolved.model);
		}
	}

	// -------------------------------------------------------------------------
	// Phase entry: sends the next model prompt, or wraps up when the run ends.
	// -------------------------------------------------------------------------

	async function enterPhase(ctx: ExtensionContext, extra?: string): Promise<void> {
		if (!state) return;

		if (state.phase === "done" || state.phase === "stopped") {
			if (state.phasePromptSent) return; // final message already sent for this run
			const finalTools = state.baselineTools;
			pi.setActiveTools(finalTools);
			state = { ...state, phasePromptSent: true };
			persist();
			updateStatus(ctx);
			const report =
				state.phase === "done"
					? state.delivery?.report ?? "Run complete."
					: `Run stopped: ${state.stopReason ?? "unknown reason"}`;
			pi.sendMessage(
				{ customType: "code-changes-phase", content: `[code-changes] ${PHASE_LABEL[state.phase]}\n\n${report}`, display: true },
				{ triggerTurn: false },
			);
			ctx.ui.notify(`code-changes: run ${state.id} ${state.phase}.`, state.phase === "done" ? "info" : "warning");
			return;
		}

		if (!MODEL_DRIVEN_PHASES.has(state.phase)) return;

		const message = await takePhasePrompt(ctx, extra);
		pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
	}

	/** Builds the current phase's prompt message and marks it sent. Caller delivers it. */
	async function takePhasePrompt(ctx: ExtensionContext, extra?: string) {
		const current = state!;
		await applyCoordinatorModel(ctx);
		state = { ...current, phasePromptSent: true };
		persist();
		const details: PhasePromptDetails = { phase: current.phase, runId: current.id, extra: extra !== undefined && extra.trim() !== "" };
		return { customType: PHASE_PROMPT_MESSAGE, content: phasePrompt(current, extra), display: true, details };
	}

	// -------------------------------------------------------------------------
	// CI watching
	// -------------------------------------------------------------------------

	/** Starts (or restarts) watching a PR's checks. `standalone` means no /change run owns this watch. */
	function startWatch(ctx: ExtensionContext, pr: PullRequestRef, opts?: { standalone?: boolean }): void {
		const standalone = opts?.standalone ?? false;
		ciProgress = { prNumber: pr.number, pending: 0 };
		updateStatus(ctx);
		ctx.ui.notify(`code-changes: watching CI for PR #${pr.number}.`, "info");
		ciWatcher.start(
			{
				cwd: ctx.cwd,
				pr,
				onUpdate: (summary) => {
					ciProgress = { prNumber: pr.number, pending: summary.pending.length };
					updateStatus(ctx);
				},
			},
			(result) => {
				void handleWatchResult(pr.number, result, ctx, standalone);
			},
		);
	}

	/** Called from a PR/push detected outside submit_delivery: records the PR and, if already in "ci", (re)starts the watch. */
	async function handlePrDetected(pr: PullRequestRef, ctx: ExtensionContext): Promise<void> {
		if (isActive(state)) {
			state = { ...state, pr };
			persist();
			if (state.phase === "ci") startWatch(ctx, pr);
			return;
		}
		startWatch(ctx, pr, { standalone: true });
	}

	/** Entered right after Deliver routes to "ci": starts the watch for the PR on record. */
	async function enterCiPhase(ctx: ExtensionContext): Promise<void> {
		if (!state || state.phase !== "ci" || !state.pr) return;
		const pr = state.pr;
		state = { ...state, phasePromptSent: true };
		persist();
		updateStatus(ctx);
		startWatch(ctx, pr);
	}

	/**
	 * Runs in the watcher's own callback, which may fire while the agent is idle: state
	 * transitions are applied here, against the latest `state`, and resumed with
	 * `enterPhase`'s own `sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`.
	 */
	async function handleWatchResult(prNumber: number, result: WatchResult, ctx: ExtensionContext, standalone: boolean): Promise<void> {
		if (standalone) {
			if (result.kind === "fail") {
				const count = ciFixCounters.get(prNumber) ?? 0;
				if (count >= CI_FIX_CAP) {
					ctx.ui.notify(
						`code-changes: CI failed again for PR #${prNumber}; automatic fix cap (${CI_FIX_CAP}) reached this session. Fix it manually, then /change watch to retry.`,
						"warning",
					);
					return;
				}
				ciFixCounters.set(prNumber, count + 1);
				pi.sendMessage({ customType: "code-changes-ci", content: formatCiFailure(result.failure), display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			if (result.kind === "stale") {
				const fresh = await resolvePr(ctx.cwd, String(prNumber));
				if (fresh) startWatch(ctx, fresh, { standalone: true });
				return;
			}
			if (result.kind === "pass") {
				ctx.ui.notify(`code-changes: CI passed for PR #${prNumber}.`, "info");
				return;
			}
			if (result.kind === "none") {
				ctx.ui.notify(`code-changes: no CI checks are configured for PR #${prNumber}.`, "info");
				return;
			}
			if (result.kind === "timeout") {
				ctx.ui.notify(`code-changes: timed out watching CI for PR #${prNumber}. Use /change watch to retry.`, "warning");
				return;
			}
			if (result.kind === "error") {
				ctx.ui.notify(`code-changes: error watching CI for PR #${prNumber}: ${result.message}`, "warning");
				return;
			}
			return; // aborted: superseded by a newer watch, which owns its own callback.
		}

		// Inside a /change run: only act if the run is still the same one, still watching this PR.
		if (!state || state.phase !== "ci" || state.pr?.number !== prNumber) return;

		if (result.kind === "pass") {
			setState(transition(state, "done"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (result.kind === "none") {
			const noted = state.delivery
				? { ...state, delivery: { ...state.delivery, report: `${state.delivery.report}\n\n(No CI checks were configured for PR #${prNumber}; nothing to watch.)` } }
				: state;
			setState(transition(noted, "done"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (result.kind === "fail") {
			const withFailure = { ...state, ciFailure: result.failure };
			setState(transition(withFailure, "verify"), ctx);
			await enterPhase(ctx, formatCiFailure(result.failure));
			return;
		}

		if (result.kind === "stale") {
			const fresh = await resolvePr(ctx.cwd, String(prNumber));
			if (fresh && state && state.phase === "ci") {
				state = { ...state, pr: fresh };
				persist();
				startWatch(ctx, fresh);
			}
			return;
		}

		if (result.kind === "timeout" || result.kind === "error") {
			ctx.ui.notify(
				`code-changes: CI watch ${result.kind === "timeout" ? "timed out" : `errored (${result.message})`} for PR #${prNumber}; run stays in CI. Use /change watch to retry.`,
				"warning",
			);
			return;
		}
		// aborted: superseded by a newer watch, which owns its own callback.
	}

	// -------------------------------------------------------------------------
	// Approval gate: entered from agent_settled (so the analysis message renders before the
	// dialog opens -- see the agent_settled handler below) and re-openable via /change show.
	// -------------------------------------------------------------------------

	function sendAnalysisMessage(current: WorkflowState): void {
		if (!current.analysis) return;
		pi.sendMessage(
			{
				customType: "code-changes-analysis",
				content: formatAnalysis(current.analysis, { edited: current.analysisEditedByHuman }),
				display: true,
				details: current.analysis,
			},
			{ triggerTurn: false },
		);
	}

	const NO_UI_GATE_HINT = "code-changes: analysis ready. Run /change approve, /change show or /change revise <feedback>.";

	async function openApprovalGate(ctx: ExtensionContext, opts?: { resend?: boolean }): Promise<void> {
		if (!state || state.phase !== "awaiting_approval") return;
		if ((opts?.resend ?? true) && state.analysis) sendAnalysisMessage(state);

		if (!ctx.hasUI) {
			ctx.ui.notify(NO_UI_GATE_HINT, "info");
			return;
		}

		const options = ["Approve", "Approve and allow push/PR", "Edit the analysis myself", "Send feedback to revise"];
		if (state.entry === "issue-triage") options.push("Done — triage only");
		options.push("Stop the run");

		const choice = await ctx.ui.select("Review the analysis above — what next?", options);
		if (!state || state.phase !== "awaiting_approval") return; // state moved on while the dialog was open

		if (choice === undefined) {
			ctx.ui.notify(`code-changes: run /change approve, /change show or /change revise <feedback>.`, "info");
			return; // cancelled: leave the run awaiting
		}

		if (choice === "Approve") {
			setState(transition(state, "plan"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (choice === "Approve and allow push/PR") {
			const allowed = { ...state, pushAllowed: true };
			setState(transition(allowed, "plan"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (choice === "Edit the analysis myself") {
			const prefill = formatAnalysis(state.analysis!, { edited: state.analysisEditedByHuman });
			const edited = await ctx.ui.editor("Edit the analysis", prefill);
			if (!state || state.phase !== "awaiting_approval") return;
			if (!edited?.trim()) {
				await openApprovalGate(ctx, { resend: false });
				return;
			}
			try {
				const parsed = parseAnalysisMarkdown(edited);
				const next = { ...state, analysis: parsed, analysisEditedByHuman: true };
				setState(next, ctx); // edits don't auto-approve: re-render + re-open the gate
				await openApprovalGate(ctx);
			} catch (err) {
				const message = err instanceof ArtifactError ? err.message : err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`code-changes: could not parse the edited analysis: ${message}`, "warning");
				await openApprovalGate(ctx, { resend: false });
			}
			return;
		}

		if (choice === "Send feedback to revise") {
			const feedback = await ctx.ui.editor("Revise the analysis:", "");
			if (!state) return;
			setState(transition(state, "analyze"), ctx);
			await enterPhase(ctx, feedback?.trim());
			return;
		}

		if (choice === "Done — triage only") {
			const report = `Triage complete — no implementation performed.\n\n${formatAnalysis(state.analysis!, { edited: state.analysisEditedByHuman })}`;
			const withDelivery = {
				...state,
				delivery: {
					commits: [],
					no_commit_reason: "issue-triage entry: the analysis is the deliverable, no implementation was performed.",
					report,
				},
			};
			setState(transition(withDelivery, "done"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (choice === "Stop the run") {
			const stopped = { ...state, stopReason: "stopped by user at the approval gate" };
			setState(transition(stopped, "stopped"), ctx);
			await enterPhase(ctx);
			return;
		}
	}

	// -------------------------------------------------------------------------
	// Plan approval gate: mirrors the approval gate above (same agent_settled entry, same
	// /change approve|revise|show wiring in index.ts's command handler).
	// -------------------------------------------------------------------------

	function sendPlanMessage(current: WorkflowState): void {
		if (!current.plan) return;
		pi.sendMessage(
			{
				customType: "code-changes-plan",
				content: formatPlan(current.plan, { edited: current.planEditedByHuman }),
				display: true,
				details: current.plan,
			},
			{ triggerTurn: false },
		);
	}

	const NO_UI_PLAN_GATE_HINT = "code-changes: plan ready. Run /change approve, /change show or /change revise <feedback>.";

	async function openPlanApprovalGate(ctx: ExtensionContext, opts?: { resend?: boolean }): Promise<void> {
		if (!state || state.phase !== "awaiting_plan_approval") return;
		if ((opts?.resend ?? true) && state.plan) sendPlanMessage(state);

		if (!ctx.hasUI) {
			ctx.ui.notify(NO_UI_PLAN_GATE_HINT, "info");
			return;
		}

		const options = ["Approve — start delegation", "Edit the plan myself", "Send feedback to revise", "Stop the run"];
		const choice = await ctx.ui.select("Review the plan above", options);
		if (!state || state.phase !== "awaiting_plan_approval") return; // state moved on while the dialog was open

		if (choice === undefined) {
			ctx.ui.notify(`code-changes: run /change approve, /change show or /change revise <feedback>.`, "info");
			return; // cancelled: leave the run awaiting
		}

		if (choice === "Approve — start delegation") {
			setState(transition(state, "delegate"), ctx);
			await enterPhase(ctx);
			return;
		}

		if (choice === "Edit the plan myself") {
			const prefill = planToEditable(state.plan!);
			const edited = await ctx.ui.editor("Edit the plan", prefill);
			if (!state || state.phase !== "awaiting_plan_approval") return;
			if (!edited?.trim()) {
				await openPlanApprovalGate(ctx, { resend: false });
				return;
			}
			try {
				const parsed = parseEditablePlan(edited);
				const next = { ...state, plan: parsed, packets: buildPackets(parsed), planEditedByHuman: true };
				setState(next, ctx); // edits don't auto-approve: re-render + re-open the gate
				await openPlanApprovalGate(ctx);
			} catch (err) {
				const message = err instanceof ArtifactError ? err.message : err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`code-changes: could not parse the edited plan: ${message}`, "warning");
				await openPlanApprovalGate(ctx, { resend: false });
			}
			return;
		}

		if (choice === "Send feedback to revise") {
			const feedback = await ctx.ui.editor("Revise the plan:", "");
			if (!state) return;
			setState(transition(state, "plan"), ctx);
			await enterPhase(ctx, feedback?.trim());
			return;
		}

		if (choice === "Stop the run") {
			const stopped = { ...state, stopReason: "stopped by user at the plan approval gate" };
			setState(transition(stopped, "stopped"), ctx);
			await enterPhase(ctx);
			return;
		}
	}

	// -------------------------------------------------------------------------
	// /change command
	// -------------------------------------------------------------------------

	const SUBCOMMANDS = ["status", "approve", "revise", "abort", "cleanup", "watch", "show", "triage", "review", "allow-push", "resume"];

	/** Parses `--approved`/`--push` flags (any order, any combination) preceding the rest of the args. */
	function parseFlags(args: string): { preApproved: boolean; pushAllowed: boolean; remainder: string } {
		let preApproved = false;
		let pushAllowed = false;
		let remainder = args.trim();
		for (;;) {
			if (remainder === "--approved" || remainder.startsWith("--approved ")) {
				preApproved = true;
				remainder = remainder.slice("--approved".length).trim();
				continue;
			}
			if (remainder === "--push" || remainder.startsWith("--push ")) {
				pushAllowed = true;
				remainder = remainder.slice("--push".length).trim();
				continue;
			}
			break;
		}
		return { preApproved, pushAllowed, remainder };
	}

	/** Shared by the plain `/change <task>`, `/change triage <issue>` and `/change review <pr>` forms. */
	async function startRun(
		ctx: ExtensionCommandContext,
		task: string,
		opts: { preApproved: boolean; pushAllowed: boolean; entry?: EntryKind; entryRef?: string },
	): Promise<void> {
		if (isActive(state)) {
			if (!ctx.hasUI) {
				ctx.ui.notify("code-changes: a run is already active; use /change abort first.", "error");
				return;
			}
			const replace = await ctx.ui.confirm(
				"Replace active run?",
				`A code-changes run is already active (phase ${PHASE_LABEL[state.phase]}). Start a new one instead?`,
			);
			if (!replace) return;
			if (state.pr) ciWatcher.stop(state.pr.number);
			const aborted = { ...state, stopReason: "replaced by a new /change run" };
			const stopped = transition(aborted, "stopped");
			await cleanupWorktrees(stopped.runs, ctx.cwd);
		}

		await discoverHooks(ctx.cwd, true);
		refreshReadOnlyTools(ctx.cwd);

		const baseRefResult = await git(["rev-parse", "HEAD"], ctx.cwd);
		const baseRef = baseRefResult.code === 0 ? baseRefResult.stdout.trim() : undefined;
		const baselineTools = pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.includes(name));
		const next = newState(task, baselineTools, baseRef, {
			preApproved: opts.preApproved,
			pushAllowed: opts.pushAllowed,
			entry: opts.entry,
			entryRef: opts.entryRef,
		});
		setState(next, ctx);
		await enterPhase(ctx);
	}

	pi.registerCommand("change", {
		description:
			"Start or control the code-changes workflow: /change [--approved] [--push] <task>, /change triage|review [--approved] [--push] <ref>, " +
			"or status/approve/revise/abort/cleanup/watch/show/allow-push/resume",
		getArgumentCompletions(argumentPrefix: string) {
			return SUBCOMMANDS.filter((s) => s.startsWith(argumentPrefix)).map((s) => ({ value: s, label: s }));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			const [first, ...rest] = trimmed.split(/\s+/);
			const restText = trimmed.slice(first?.length ?? 0).trim();

			if (first === "status") {
				if (!state) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				ctx.ui.notify(
					`code-changes: run ${state.id} — task "${state.task}" — phase ${PHASE_LABEL[state.phase]} — failures ${state.failures.length}.`,
					"info",
				);
				return;
			}

			if (first === "approve") {
				if (!state || (state.phase !== "awaiting_approval" && state.phase !== "awaiting_plan_approval")) {
					ctx.ui.notify("code-changes: nothing is awaiting approval.", "warning");
					return;
				}
				if (state.phase === "awaiting_approval") {
					setState(transition(state, "plan"), ctx);
				} else {
					setState(transition(state, "delegate"), ctx);
				}
				await enterPhase(ctx);
				return;
			}

			if (first === "revise") {
				if (!state || (state.phase !== "awaiting_approval" && state.phase !== "awaiting_plan_approval")) {
					ctx.ui.notify("code-changes: nothing is awaiting approval.", "warning");
					return;
				}
				if (!restText) {
					ctx.ui.notify("code-changes: usage: /change revise <feedback>", "warning");
					return;
				}
				if (state.phase === "awaiting_approval") {
					setState(transition(state, "analyze"), ctx);
				} else {
					setState(transition(state, "plan"), ctx);
				}
				await enterPhase(ctx, restText);
				return;
			}

			if (first === "resume") {
				if (!isActive(state)) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				if (state.phase === "awaiting_approval" || state.phase === "awaiting_plan_approval") {
					state = { ...state, transientRetries: 0, phasePromptSent: false };
					persist();
					if (state.phase === "awaiting_approval") await openApprovalGate(ctx);
					else await openPlanApprovalGate(ctx);
					return;
				}
				if (!MODEL_DRIVEN_PHASES.has(state.phase)) {
					ctx.ui.notify(
						`code-changes: /change resume only applies to a model-driven phase or an approval gate (current: ${PHASE_LABEL[state.phase]}).`,
						"warning",
					);
					return;
				}
				const currentPhase = state.phase;
				state = { ...state, transientRetries: 0, phasePromptSent: false };
				persist();
				await enterPhase(
					ctx,
					`Resuming after an interruption: continue the ${PHASE_LABEL[currentPhase]} phase from where it stopped; do not redo finished work.`,
				);
				return;
			}

			if (first === "abort") {
				if (!state) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				if (state.pr) ciWatcher.stop(state.pr.number);
				const aborted = { ...state, stopReason: "aborted by user" };
				setState(transition(aborted, "stopped"), ctx);
				await cleanupWorktrees(state.runs, ctx.cwd);
				ctx.ui.notify("code-changes: run aborted.", "warning");
				return;
			}

			if (first === "cleanup") {
				if (!state) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				await cleanupWorktrees(state.runs, ctx.cwd);
				ctx.ui.notify("code-changes: worktrees cleaned up.", "info");
				return;
			}

			if (first === "watch") {
				const hint = restText || undefined;
				const pr = await resolvePr(ctx.cwd, hint);
				if (!pr) {
					ctx.ui.notify(`code-changes: no open PR found${hint ? ` for "${hint}"` : ""}.`, "warning");
					return;
				}
				if (isActive(state)) {
					state = { ...state, pr };
					persist();
				}
				startWatch(ctx, pr, { standalone: !isActive(state) });
				return;
			}

			if (first === "allow-push") {
				if (!isActive(state)) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				state = { ...state, pushAllowed: true };
				persist();
				ctx.ui.notify("code-changes: push, PR creation and PR/issue replies are now allowed for this run.", "info");
				return;
			}

			if (first === "show") {
				if (!state) {
					ctx.ui.notify("code-changes: no active run.", "info");
					return;
				}
				if (state.analysis) sendAnalysisMessage(state);
				if (state.plan) sendPlanMessage(state);
				if (state.review) {
					const lines = [
						"# Reviewed diff summary",
						`overrides: ${state.review.overrides.join("; ") || "none"}`,
						`tests_kept: ${state.review.tests_kept.join("; ") || "none"}`,
						`tests_cut: ${state.review.tests_cut.join("; ") || "none"}`,
					];
					pi.sendMessage({ customType: "code-changes-phase", content: lines.join("\n"), display: true }, { triggerTurn: false });
				}
				const lastFailure = state.failures[state.failures.length - 1];
				if (lastFailure) {
					pi.sendMessage(
						{
							customType: "code-changes-phase",
							content: `# Last failure\nAttempt ${lastFailure.attempt_number}: ${lastFailure.failure_class} -> ${lastFailure.destination}. ${lastFailure.summary}`,
							display: true,
						},
						{ triggerTurn: false },
					);
				}
				if (state.phase === "awaiting_approval" && ctx.hasUI) {
					await openApprovalGate(ctx, { resend: false });
				}
				if (state.phase === "awaiting_plan_approval" && ctx.hasUI) {
					await openPlanApprovalGate(ctx, { resend: false });
				}
				return;
			}

			if (first === "triage" || first === "review") {
				const { preApproved, pushAllowed, remainder } = parseFlags(restText);
				if (!remainder) {
					ctx.ui.notify(`code-changes: usage: /change ${first} [--approved] [--push] <${first === "triage" ? "issue" : "pr"}> [notes]`, "warning");
					return;
				}
				const [ref, ...noteWords] = remainder.split(/\s+/);
				const notes = noteWords.join(" ").trim();
				const entry: EntryKind = first === "triage" ? "issue-triage" : "pr-review-comments";
				const task = first === "triage" ? `Triage issue ${ref}${notes ? `: ${notes}` : ""}` : `Review PR ${ref}${notes ? `: ${notes}` : ""}`;
				await startRun(ctx, task, { preApproved, pushAllowed, entry, entryRef: ref });
				return;
			}

			// Otherwise: [--approved] [--push] <task>
			const { preApproved, pushAllowed, remainder: task } = parseFlags(trimmed);
			if (!task) {
				ctx.ui.notify(
					"code-changes: usage: /change [--approved] [--push] <task>, or /change status|approve|revise|abort|cleanup|watch|show|triage|review|allow-push|resume",
					"warning",
				);
				return;
			}
			await startRun(ctx, task, { preApproved, pushAllowed });
		},
	});

	// -------------------------------------------------------------------------
	// Tools
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "submit_analysis",
		label: "Submit analysis",
		description:
			"Submit the analysis report (root_cause, proposed_change, out_of_scope, repro_status, open_questions) to end the Analyze phase. " +
			"For the pr-review-comments entry, map the review classification onto the same fields: root_cause/proposed_change is the " +
			"valid-comment list with its code evidence, out_of_scope is the invalid comments (named explicitly), repro_status is the " +
			"code-path confirmation used to classify each comment, and open_questions is empty once every thread is classified.",
		parameters: AnalysisSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state || state.phase !== "analyze") {
				throw new Error(`submit_analysis is only valid in the Analyze phase (current: ${state ? state.phase : "no active run"}).`);
			}
			try {
				const next = applyAnalysis(state, params);
				setState(next, ctx);
				const formatted = next.analysis ? formatAnalysis(next.analysis) : "";
				return {
					content: [{ type: "text", text: `Analysis submitted. Phase is now ${PHASE_LABEL[next.phase]}.\n\n${formatted}` }],
					details: next.analysis,
					terminate: true,
				};
			} catch (err) {
				if (err instanceof ArtifactError) throw new Error(err.message);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "submit_plan",
		label: "Submit plan",
		description:
			"Submit the task list to end the Plan phase. Every sub-agent task needs `paths`; independent tasks with overlapping paths are rejected. merge_plan is optional.",
		parameters: PlanSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state || state.phase !== "plan") {
				throw new Error(`submit_plan is only valid in the Plan phase (current: ${state ? state.phase : "no active run"}).`);
			}
			try {
				let next = applyPlan(state, params);
				next = { ...next, packets: buildPackets(next.plan!) };
				setState(next, ctx);
				const formatted = next.plan ? formatPlan(next.plan) : "";
				return {
					content: [{ type: "text", text: `Plan submitted with ${next.plan?.tasks.length ?? 0} task(s). Phase is now ${PHASE_LABEL[next.phase]}.\n\n${formatted}` }],
					details: next.plan,
					terminate: true,
				};
			} catch (err) {
				if (err instanceof ArtifactError) throw new Error(err.message);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "run_delegation",
		label: "Run delegation",
		description:
			"Dispatch the plan's tasks to sub-agents (independent tasks with non-overlapping paths run in parallel in worktrees, capped by maxParallel; the rest run in the main tree), then merge worktree branches back in.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, signal, onUpdate, ctx) {
			if (!state || state.phase !== "delegate") {
				throw new Error(`run_delegation is only valid in the Delegate phase (current: ${state ? state.phase : "no active run"}).`);
			}
			const plan = state.plan;
			if (!plan) {
				throw new Error("run_delegation: no plan on record.");
			}

			const config = loadTierConfig(ctx.cwd);
			const capturedState = state;
			const { runs, mergeLog } = await runDelegation(plan, capturedState.packets, {
				cwd: ctx.cwd,
				runId: capturedState.id,
				resolveModel: (tier) => resolveTierModel(ctx.modelRegistry, config, tierForExecutor(tier), undefined).ref,
				signal,
				maxParallel: loadMaxParallel(ctx.cwd),
				onProgress: (progress) => {
					if (!state) return;
					state = { ...state, runs: progress };
					persist();
					updateStatus(ctx);
					onUpdate?.({ content: [{ type: "text", text: `Delegation progress: ${progress.map((r) => `${r.task_id}=${r.status}`).join(", ")}` }], details: progress });
				},
			});

			if (!state) throw new Error("run_delegation: run was aborted mid-flight.");
			let next = transition({ ...state, runs }, "supervise");

			// escalate.md: a task whose implementer repeated a spec gap is escalated automatically,
			// right after delegation -- not only on a later resume_task.
			const escalationNotes: string[] = [];
			for (const run of runs) {
				if (!needsSpecGapEscalation(run)) continue;
				try {
					const { state: escalatedState, decision } = await escalateSpecGaps(run, next, { escalate: runResumeEscalation }, ctx, signal);
					next = escalatedState;
					escalationNotes.push(`- ${run.task_id}: ${decision}`);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					escalationNotes.push(`- ${run.task_id}: escalation failed (${message})`);
				}
			}

			setState(next, ctx);

			const summary = [
				`Delegation complete: ${runs.map((r) => `${r.task_id}=${r.status}`).join(", ")}.`,
				mergeLog.length > 0 ? `Merge log:\n${mergeLog.map((l) => `- ${l}`).join("\n")}` : "Nothing to merge.",
				escalationNotes.length > 0 ? `Spec-gap escalation(s):\n${escalationNotes.join("\n")}` : "",
			]
				.filter((s) => s.length > 0)
				.join("\n\n");
			return { content: [{ type: "text", text: summary }], details: { runs: next.runs, mergeLog }, terminate: true };
		},
	});

	pi.registerTool(
		createResumeTaskTool({
			getState: () => state,
			commit: (nextState, ctx) => setState(nextState, ctx),
			resolveModel: (tier, ctx) => {
				const config = loadTierConfig(ctx.cwd);
				return resolveTierModel(ctx.modelRegistry, config, tierForExecutor(tier), undefined).ref;
			},
			escalate: runResumeEscalation,
		} satisfies ResumeDeps),
	);

	pi.registerTool({
		name: "submit_review",
		label: "Submit review",
		description: "Submit the Supervise-phase review (overrides, tests_kept, tests_cut) to end the phase. The merged diff is computed from git, not supplied.",
		parameters: ReviewSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state || state.phase !== "supervise") {
				throw new Error(`submit_review is only valid in the Supervise phase (current: ${state ? state.phase : "no active run"}).`);
			}
			try {
				const diff = await mergedDiff(ctx.cwd, state.baseRef);
				const next = applyReview(state, params, diff);
				setState(next, ctx);
				return { content: [{ type: "text", text: `Review submitted. Phase is now ${PHASE_LABEL[next.phase]}.` }], details: next.review, terminate: true };
			} catch (err) {
				if (err instanceof ArtifactError) throw new Error(err.message);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "run_gates",
		label: "Run gates",
		description: "Run one or more quality gate commands sequentially in the repo root and record their results for Verify. Re-running a command overwrites its previous result.",
		parameters: Type.Object({ commands: Type.Array(Type.String(), { description: "Shell commands to run, in order." }) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!state || state.phase !== "verify") {
				throw new Error(`run_gates is only valid in the Verify phase (current: ${state ? state.phase : "no active run"}).`);
			}
			const results: GateResult[] = [];
			for (const command of params.commands) {
				results.push(await runShell(command, ctx.cwd, { signal }));
			}
			const byCommand = new Map<string, GateResult>();
			for (const g of state.lastGates) byCommand.set(g.command, g);
			for (const g of results) byCommand.set(g.command, g);
			const merged = [...byCommand.values()];
			state = { ...state, lastGates: merged };
			persist();

			const table = results
				.map((r) => `| ${r.command} | ${r.exit_code} | ${r.duration_ms}ms |`)
				.join("\n");
			const failing = results.filter((r) => r.exit_code !== 0);
			const failingOutputs = failing.map((r) => `## ${r.command} (exit ${r.exit_code})\n${r.output}`).join("\n\n");
			const text = [
				"| command | exit | duration |",
				"| --- | --- | --- |",
				table,
				failingOutputs ? `\n${failingOutputs}` : "",
			]
				.filter((s) => s.length > 0)
				.join("\n");
			return { content: [{ type: "text", text }], details: results };
		},
	});

	pi.registerTool({
		name: "submit_verification",
		label: "Submit verification",
		description: "Report the Verify-phase outcome (pass/fail). A pass requires every required gate command to have been run through run_gates and be green.",
		parameters: VerificationSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!state || state.phase !== "verify") {
				throw new Error(`submit_verification is only valid in the Verify phase (current: ${state ? state.phase : "no active run"}).`);
			}

			// A pass requires stop hooks to have run on the final state: run them fresh right now
			// (never with stop_hook_active, this isn't a stop-loop) and fold both the hook results
			// and their pass/fail into the gate evidence Verify will report.
			if (params.outcome === "pass" && hooksCache && hooksCache.hooks.length > 0) {
				const hookResults = await runStopHooks(hooksCache.hooks, { repoRoot: hooksCache.repoRoot, stopHookActive: false, signal });
				const hookGates: GateResult[] = hookResults.map((r) => ({
					command: `hook(${r.source}): ${r.command}`,
					exit_code: r.blocked ? 1 : 0,
					output: r.reason,
					duration_ms: r.duration_ms,
				}));
				const byCommand = new Map<string, GateResult>();
				for (const g of state.lastGates) byCommand.set(g.command, g);
				for (const g of hookGates) byCommand.set(g.command, g);
				state = { ...state, lastGates: [...byCommand.values()], lastHooks: hookResults };
				persist();
			}

			let outcome;
			try {
				outcome = applyVerification(state, params);
			} catch (err) {
				if (err instanceof ArtifactError) throw new Error(err.message);
				throw err;
			}

			if (outcome.kind === "deliver" || outcome.kind === "retry") {
				setState(outcome.state, ctx);
				return {
					content: [{ type: "text", text: outcome.kind === "deliver" ? "Verification passed. Phase is now Deliver." : `Verification failed; routed back to ${PHASE_LABEL[outcome.state.phase]}.` }],
					details: outcome.kind === "retry" ? outcome.failure : undefined,
					terminate: true,
				};
			}

			if (outcome.kind === "stop") {
				setState(outcome.state, ctx);
				return { content: [{ type: "text", text: outcome.report }], details: undefined, terminate: true };
			}

			// kind === "escalate": run the escalation side-call now.
			const config = loadTierConfig(ctx.cwd);
			const resolved = resolveTierModel(ctx.modelRegistry, config, "escalation", ctx.model);
			if (!resolved.model) {
				const stopped = transition({ ...outcome.state, stopReason: "Escalation model could not be resolved after a second Verify failure." }, "stopped");
				setState(stopped, ctx);
				return { content: [{ type: "text", text: `Escalation could not run: no model resolved for the escalation tier. Run stopped.` }], details: undefined, terminate: true };
			}

			const failingGates = outcome.state.lastGates.filter((g) => g.exit_code !== 0);
			const evidence = [
				outcome.state.failures.map((f) => `- Attempt ${f.attempt_number}: ${f.failure_class} -> ${f.destination}. ${f.summary}`).join("\n"),
				failingGates.length > 0 ? `Failing gates:\n${failingGates.map((g) => `- ${g.command} (exit ${g.exit_code}):\n${g.output}`).join("\n")}` : "",
				outcome.state.review ? `Reviewed merged diff (truncated):\n${outcome.state.review.merged_diff.slice(0, 8000)}` : "",
			]
				.filter((s) => s.length > 0)
				.join("\n\n");

			try {
				const { decision } = await runEscalation(
					ctx.modelRegistry,
					resolved.model,
					{
						phase: "verify",
						question:
							"Verify has failed twice for the same task. Why is the fix not landing / is the root cause wrong? What should the next attempt do?",
						evidence,
						hypothesis: params.hypothesis ?? "",
					},
					signal,
				);
				const escalation = { phase: "verify" as Phase, question: "Verify has failed twice for the same task. Why is the fix not landing / is the root cause wrong? What should the next attempt do?", evidence, hypothesis: params.hypothesis ?? "", model: modelRef(resolved.model), decision };
				const withEscalation = { ...outcome.state, escalations: [...outcome.state.escalations, escalation] };
				const resolvedState = resolveEscalatedFailure(withEscalation, decision);
				setState(resolvedState, ctx);
				return { content: [{ type: "text", text: `Escalation decision: ${decision}\n\nRouted to ${PHASE_LABEL[resolvedState.phase]}.` }], details: escalation, terminate: true };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const stopped = transition({ ...outcome.state, stopReason: `Escalation call failed: ${message}` }, "stopped");
				setState(stopped, ctx);
				return { content: [{ type: "text", text: `Escalation call failed: ${message}. Run stopped.` }], details: undefined, terminate: true };
			}
		},
	});

	pi.registerTool({
		name: "submit_delivery",
		label: "Submit delivery",
		description: "Report delivery (outcome-first report, plus no_commit_reason if nothing was committed) to end the workflow.",
		parameters: DeliverySchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!state || state.phase !== "deliver") {
				throw new Error(`submit_delivery is only valid in the Deliver phase (current: ${state ? state.phase : "no active run"}).`);
			}
			let commitSubjects: string[] = [];
			if (state.baseRef) {
				const log = await git(["log", "--format=%s", `${state.baseRef}..HEAD`], ctx.cwd);
				if (log.code === 0) {
					commitSubjects = log.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
				}
			}
			// A PR may already be on record from detection during Deliver (a push or `gh pr create`
			// picked up by the tool_result/input handlers); otherwise resolve one for the current branch.
			const pr = state.pr ?? (await resolvePr(ctx.cwd, undefined, signal));
			try {
				const next = applyDelivery(state, params, commitSubjects, pr);
				setState(next, ctx);
				await cleanupWorktrees(next.runs, ctx.cwd);
				if (next.phase === "ci") {
					await enterCiPhase(ctx);
					return {
						content: [{ type: "text", text: `${next.delivery?.report ?? "Delivered."}\n\nWatching CI for PR #${next.pr?.number}.` }],
						details: next.delivery,
						terminate: true,
					};
				}
				return { content: [{ type: "text", text: next.delivery?.report ?? "Delivered." }], details: next.delivery, terminate: true };
			} catch (err) {
				if (err instanceof ArtifactError) throw new Error(err.message);
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "escalate",
		label: "Escalate",
		description: "Ask the escalation-tier model one bounded question when stuck on a judgment call (Analyze, Supervise, or Verify only). Does not end the phase.",
		parameters: Type.Object({
			question: Type.String({ description: "The specific judgment call." }),
			evidence: Type.String({ description: "The relevant code/evidence." }),
			hypothesis: Type.String({ description: "The working hypothesis so far." }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!state || (state.phase !== "analyze" && state.phase !== "supervise" && state.phase !== "verify")) {
				throw new Error(`escalate is only valid in Analyze, Supervise, or Verify (current: ${state ? state.phase : "no active run"}).`);
			}
			const config = loadTierConfig(ctx.cwd);
			const resolved = resolveTierModel(ctx.modelRegistry, config, "escalation", ctx.model);
			if (!resolved.model) {
				throw new Error("escalate: no model resolved for the escalation tier.");
			}
			const { decision } = await runEscalation(ctx.modelRegistry, resolved.model, { phase: state.phase, ...params }, signal);
			const escalation = { phase: state.phase, question: params.question, evidence: params.evidence.slice(0, 2000), hypothesis: params.hypothesis, model: modelRef(resolved.model), decision };
			state = { ...state, escalations: [...state.escalations, escalation] };
			persist();
			return { content: [{ type: "text", text: decision }], details: escalation };
		},
	});

	// -------------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------------

	pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
		const decision = decideToolCall(state, event.toolName, event.input as Record<string, unknown>, extraReadOnlyTools);
		if (decision) return { block: true, reason: decision.reason };
		return undefined;
	});

	// CI detection: a push or `gh pr create` in a bash/powershell call, or a PR URL in its output.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const outputText = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const fromText = detectPrFromText(outputText);
		if (!fromText && !isPushCommand(command)) return undefined;
		const pr = await resolvePr(ctx.cwd, fromText?.url);
		if (pr) await handlePrDetected(pr, ctx);
		return undefined;
	});

	// CI detection: a PR URL pasted into a user message.
	pi.on("input", async (event, ctx): Promise<InputEventResult> => {
		const detected = detectPrFromText(event.text);
		if (detected) {
			const pr = await resolvePr(ctx.cwd, detected.url);
			if (pr) await handlePrDetected(pr, ctx);
		}
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (_event, _ctx): Promise<BeforeAgentStartEventResult | undefined> => {
		if (!isActive(state)) return undefined;
		return { message: { customType: "code-changes-reminder", content: phaseReminder(state), display: false } };
	});

	// A tool that moves the run to the next phase can do so mid-run (the model keeps going after a
	// follow-up turn, or batched another call with it), so agent_end is not guaranteed to fire
	// before the model acts in the new phase. Hand over the next phase's instructions right after
	// the tool batch that changed the phase, and ask pi for the next model request.
	pi.on("turn_end", async (_event, ctx): Promise<TurnEndEventResult | undefined> => {
		if (!isActive(state) || state.phasePromptSent || !MODEL_DRIVEN_PHASES.has(state.phase)) return undefined;
		const message = await takePhasePrompt(ctx);
		return { entries: [{ type: "custom_message", ...message }], continue: true };
	});

	pi.on("agent_end", async (_event, ctx) => {
		// The approval gate (awaiting_approval) and the final done/stopped report are handled from
		// agent_settled instead: sendMessage(..., {triggerTurn:false}) called here, while the
		// session can still be streaming, only queues to _pendingCustomMessages and isn't rendered
		// until the turn ends -- too late for ctx.ui.select, which would already be open by then.
		// agent_settled fires once the session is truly idle, so the same call appends and renders
		// immediately (see the agent_settled handler below).
		if (state !== undefined && (state.phase === "done" || state.phase === "stopped")) return;
		if (!isActive(state)) return;
		if (state.phase === "awaiting_approval" || state.phase === "awaiting_plan_approval") return;

		if (!state.phasePromptSent) {
			await enterPhase(ctx);
			return;
		}
		// Phase unchanged and its prompt was already sent, but the model stopped without
		// submitting the artifact: do nothing. The user can prompt again; the reminder will
		// be re-injected via before_agent_start.
	});

	// Fires once the session has fully settled (idle, no automatic retry/compaction/continuation
	// queued): the right place for the approval-gate dialog and the final done/stopped report, both
	// of which append a display message the user must actually see before (or instead of) any
	// further prompt -- see the comment in the agent_end handler above.
	pi.on("agent_settled", async (_event, ctx) => {
		if (state !== undefined && (state.phase === "done" || state.phase === "stopped")) {
			if (!state.phasePromptSent) await enterPhase(ctx);
			return;
		}

		if (!isActive(state)) return;
		if (state.phase !== "awaiting_approval" && state.phase !== "awaiting_plan_approval") {
			// Last resort: the run went idle in a model-driven phase whose prompt was never delivered.
			if (!state.phasePromptSent && MODEL_DRIVEN_PHASES.has(state.phase)) await enterPhase(ctx);
			return;
		}
		if (state.phasePromptSent) return; // gate already asked for this awaiting period
		const gatePhase = state.phase;
		state = { ...state, phasePromptSent: true };
		persist();
		if (gatePhase === "awaiting_approval") await openApprovalGate(ctx);
		else await openPlanApprovalGate(ctx);
	});

	// Stop hooks: enforced on every settling turn, active whether or not a /change run is running.
	pi.on("agent_before_settle", async (event, ctx): Promise<AgentBeforeSettleEventResult | undefined> => {
		// Transient provider errors pi's own agent-level retry didn't cover (e.g. "499 status code
		// (no body)"): only while a /change run owns a model-driven phase, and only up to a bounded
		// number of harness-owned retries. Must run before the stop-hook logic below, which already
		// skips outcome "error" outright.
		if (event.outcome === "error" && isActive(state) && MODEL_DRIVEN_PHASES.has(state.phase)) {
			const messages = event.context.contextMessages ?? event.context.llmMessages ?? [];
			let lastErrorMessage: string | undefined;
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
				if (m && m.role === "assistant" && m.stopReason === "error") {
					lastErrorMessage = m.errorMessage;
					break;
				}
			}

			const retries = state.transientRetries ?? 0;
			if (isTransientProviderError(lastErrorMessage) && retries < MAX_TRANSIENT_RETRIES) {
				const attempt = retries + 1;
				state = { ...state, transientRetries: attempt };
				persist();
				ctx.ui.notify(`code-changes: provider error '${lastErrorMessage}'; retrying (${attempt}/${MAX_TRANSIENT_RETRIES}).`, "info");
				try {
					await retryBackoff(attempt, ctx.signal);
				} catch {
					return undefined; // aborted while waiting: fall through to normal settlement
				}
				// An error always settles on an assistant-role entry, which the harness alone treats as
				// non-continuable (BoundaryContextPreview.canContinue): appending our own retry-feedback
				// message is what actually makes the requested continuation valid, exactly like the
				// stop-hook feedback loop below does for a blocked stop.
				return {
					entries: [
						{
							type: "custom_message",
							customType: "code-changes-retry",
							content: `code-changes: a transient provider error interrupted this turn ('${lastErrorMessage}'); retrying automatically (${attempt}/${MAX_TRANSIENT_RETRIES}). Continue the ${PHASE_LABEL[state.phase]} phase from where it stopped; do not redo finished work.`,
							display: true,
						},
					],
					continue: true,
				};
			}

			ctx.ui.notify(
				`code-changes: provider error${lastErrorMessage ? ` '${lastErrorMessage}'` : ""} could not be retried automatically. Run /change resume to continue this phase.`,
				"warning",
			);
			return undefined;
		}

		if (event.outcome === "aborted" || event.outcome === "error") return undefined;
		// No code changed in a read-only phase (analyze/awaiting_approval/plan/delegate/ci): nothing to check.
		if (isActive(state) && READ_ONLY_PHASES.includes(state.phase)) return undefined;

		await discoverHooks(ctx.cwd);
		if (!hooksCache || hooksCache.hooks.length === 0) return undefined;

		const inCheckedPhase = isActive(state) && (state.phase === "supervise" || state.phase === "verify" || state.phase === "deliver");
		if (!inCheckedPhase) {
			const statusResult = await git(["status", "--porcelain"], ctx.cwd);
			if (statusResult.stdout.trim() === "") return undefined; // nothing to check
		}

		const results = await runStopHooks(hooksCache.hooks, { repoRoot: hooksCache.repoRoot, stopHookActive: stopHookGuard.stopHookActive });

		if (isActive(state)) {
			state = { ...state, lastHooks: results };
			persist();
		}

		const decision = stopHookGuard.next(hooksBlocked(results).length > 0);

		if (decision.action === "continue") {
			return {
				entries: [{ type: "custom_message", customType: "code-changes-hook", content: formatHookFeedback(results), display: true }],
				continue: true,
			};
		}

		if (decision.action === "give_up") {
			ctx.ui.notify(`code-changes: stop hooks kept blocking after repeated attempts; giving up.\n${formatHookFeedback(results)}`, "warning");
			return undefined; // inside a run, Verify's pass check will still refuse this state
		}

		// action === "allow": surface any non-blocking systemMessage/error output, quietly.
		for (const r of results) {
			if (!r.blocked && r.reason.trim().length > 0) {
				ctx.ui.notify(`code-changes: ${r.source} stop hook: ${r.reason}`, "info");
			}
		}
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		state = restoreState(ctx.sessionManager.getBranch() as unknown as ReadonlyArray<{ type: string; customType?: string; data?: unknown }>);
		hooksDiscovered = false;
		stopHookGuard.reset();
		await discoverHooks(ctx.cwd);
		refreshReadOnlyTools(ctx.cwd);
		if (isActive(state)) {
			// A finished (done/stopped) run must not overwrite the user's current tools on every
			// session start; only an in-progress run's phase tools should apply.
			applyPhaseTools();
			if (state.phase === "ci" && state.pr) startWatch(ctx, state.pr);
		} else {
			// No active run: the workflow tools would otherwise sit active (and visible to the
			// model) for no reason. Deactivate them, leaving whatever else was already active.
			pi.setActiveTools(pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.includes(name)));
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		// Worktrees are intentionally kept: a run resumes with `pi -e ...` in the same repo later.
		ciWatcher.stopAll();
	});
}
