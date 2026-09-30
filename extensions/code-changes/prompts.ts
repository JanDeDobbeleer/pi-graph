/**
 * Prompt assembly for the code-changes workflow: resolves the bundled skill directory, reads
 * per-phase reference files, and builds the instruction text sent into the conversation on every
 * phase transition (`phasePrompt`) and on every user prompt while a run is active (`phaseReminder`).
 *
 * No pi runtime calls here — this module only reads files under `skills/code-changes/` and formats
 * strings from `WorkflowState`. `index.ts` calls into it and owns actually sending the message.
 *
 * Reference files under `skills/code-changes/references/` stay fully usable standalone (Claude
 * Code, GitHub Copilot, other agents reading the Markdown directly, without this extension). Parts
 * of that Markdown describe flow this harness now enforces in code — the human approval gate, gate
 * evidence, the retry cap, conventional-commit validation, and so on. Those sections are wrapped in
 * `<!-- harness:enforced -->` … `<!-- /harness:enforced -->` markers: a standalone reader's Markdown
 * viewer ignores HTML comments, so the guidance still reads normally there, but `stripEnforced`
 * removes those blocks before this extension injects the file into a phase prompt, so the harness
 * doesn't hand the model instructions that duplicate (or drift from) what the code already does.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatGateAmendments, requiredGateCommands, summarizeState } from "./artifacts.ts";
import { PHASE_ARTIFACT_TOOL, PHASE_TOOLS } from "./gates.ts";
import { knownGateShellLabel } from "./shell.ts";
import { PHASE_LABEL, type AnalysisKind, type Phase, type WorkflowState } from "./state.ts";

// ---------------------------------------------------------------------------
// Skill directory resolution
// ---------------------------------------------------------------------------

function resolveSkillDir(): string {
	let here: string;
	try {
		here = path.dirname(fileURLToPath(import.meta.url));
	} catch {
		// import.meta.url can be unavailable under some loaders (e.g. jiti in certain configs).
		// eslint-disable-next-line no-undef
		here = typeof __dirname !== "undefined" ? __dirname : process.cwd();
	}
	return path.resolve(here, "../../skills/code-changes");
}

export const SKILL_DIR = resolveSkillDir();

// ---------------------------------------------------------------------------
// harness:enforced marker stripping
// ---------------------------------------------------------------------------

const ENFORCED_OPEN = "<!-- harness:enforced -->";
const ENFORCED_CLOSE = "<!-- /harness:enforced -->";
// Non-greedy: each OPEN pairs with the nearest following CLOSE. An OPEN with no CLOSE anywhere
// after it simply never matches, so that block (and everything after it, up to the next balanced
// pair) is left in place instead of being silently dropped.
const ENFORCED_BLOCK = /<!-- harness:enforced -->[\s\S]*?<!-- \/harness:enforced -->/g;

/**
 * Removes `<!-- harness:enforced -->` … `<!-- /harness:enforced -->` blocks from `markdown`
 * (tolerating CRLF line endings) and collapses runs of 3+ blank lines left behind to 2. An
 * unbalanced marker (an OPEN with no matching CLOSE) is left untouched rather than stripped —
 * never lose text silently.
 */
export function stripEnforced(markdown: string): string {
	const stripped = markdown.replace(ENFORCED_BLOCK, "");
	return stripped.replace(/(\r?\n){3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// kind section selection (analyze.md)
// ---------------------------------------------------------------------------

// `<!-- kind:bug -->` … `<!-- /kind:bug -->`: the per-kind guidance in analyze.md. Standalone readers
// see all of it (HTML comments are invisible); the harness narrows it once the kind is known.
const KIND_BLOCK = /<!-- kind:(\w+) -->\r?\n?([\s\S]*?)<!-- \/kind:\1 -->\r?\n?/g;

/**
 * Resolves the `<!-- kind:<name> -->` blocks of `markdown`. With `kind` undefined every block is
 * kept and only its marker comments are removed; with a kind, only that kind's block is kept and
 * the others are dropped. Runs of 3+ blank lines left behind collapse to 2.
 */
export function selectKindSections(markdown: string, kind: AnalysisKind | undefined): string {
	const resolved = markdown.replace(KIND_BLOCK, (_match, name: string, body: string) => (kind === undefined || kind === name ? body : ""));
	return resolved.replace(/(\r?\n){3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Reference file loading
// ---------------------------------------------------------------------------

const referenceCache = new Map<string, string>();

export interface ReadReferenceOptions {
	/** Strip `harness:enforced` blocks (the harness-injected view). Defaults to true. */
	harness?: boolean;
}

/**
 * Reads `references/<name>.md` from the skill directory. Cached per (name, harness) pair; missing
 * files return a warning comment. With `harness: true` (the default), `harness:enforced` blocks are
 * stripped — that's the view injected into phase prompts. Pass `harness: false` for the raw,
 * standalone content (used by tests that guard the source file itself).
 */
export function readReference(name: string, options: ReadReferenceOptions = {}): string {
	const harness = options.harness ?? true;
	const cacheKey = `${name}::${harness ? "harness" : "raw"}`;
	const cached = referenceCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const filePath = path.join(SKILL_DIR, "references", `${name}.md`);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		content = `<!-- code-changes: reference file "${name}.md" not found at ${filePath} -->`;
	}
	const result = harness ? stripEnforced(content) : content;
	referenceCache.set(cacheKey, result);
	return result;
}

/**
 * Which reference files back each model-driven phase's instructions, for this run's state.
 *
 * - `analyze` depends on `state.entry` (SKILL.md "Special cases"): the issue-triage and
 *   pr-review-comments entry points read their own reference file instead of analyze.md.
 * - `plan` also reads `delegate.md`: once `harness:enforced` blocks are stripped, everything left
 *   in delegate.md IS the executor-choice guidance (which tier fits which task) — the rest of that
 *   file describes flow the harness enforces at delegation and supervision time, not something Plan
 *   needs to re-derive.
 * - `delegate` reads nothing: the phase prompt just tells the model to call `run_delegation`.
 * - `deliver` additionally reads `pr-review-comments.md` for that entry, whose "Valid comments" /
 *   "Reply to every thread" guidance (post-strip) still applies once code changes are ready to ship.
 * - `artifacts.md` is intentionally not listed here: the artifact shapes are now TypeBox tool
 *   schemas (see artifacts.ts), so injecting the Markdown contract would duplicate it.
 */
export function referencesForPhase(state: WorkflowState): string[] {
	switch (state.phase) {
		case "analyze":
			switch (state.entry) {
				case "issue-triage":
					return ["issue-triage", "escalate"];
				case "pr-review-comments":
					return ["pr-review-comments", "escalate"];
				default:
					return ["analyze", "escalate"];
			}
		case "plan":
			return ["plan", "delegate"];
		case "delegate":
			return [];
		case "supervise":
			return ["supervise", "escalate"];
		case "verify":
			return ["verify", "escalate"];
		case "deliver":
			return state.entry === "pr-review-comments" ? ["deliver", "pr-review-comments"] : ["deliver"];
		default:
			return [];
	}
}

// ---------------------------------------------------------------------------
// Phase prompt
// ---------------------------------------------------------------------------

const HARNESS_IS_THE_FLOW =
	"The harness is the flow: do not invoke the code-changes skill or follow its phase order manually; this prompt already contains the relevant guidance.";

function toolsLine(phase: Phase): string {
	return PHASE_TOOLS[phase].join(", ");
}

function pushPolicyLines(state: WorkflowState): string[] {
	const lines: string[] = [];
	lines.push(
		state.pushAllowed
			? "push/PR allowed; use --force-with-lease for rewritten branches; after push the harness watches PR checks."
			: "push, PR creation and PR/issue replies are blocked by the harness; commit only. The user can allow them with /change allow-push.",
	);
	lines.push("Stage files explicitly; `git add -A`/`git add .`/`git commit -a` are blocked.");
	if (state.entry === "pr-review-comments") {
		lines.push(
			"Fixup + autosquash flow: `git commit --fixup <sha>` per valid comment, then `git rebase --autosquash`. " +
				"Draft a reply for every review thread; only post them once written, and only when pushAllowed.",
		);
	}
	return lines;
}

const EXTERNAL_CONTEXT_LINE =
	"Read-only external context is available: `gh` (issue/pr/run/workflow/release view|list, pr diff|checks, repo view, search, label list, read-only api), " +
	"`curl`/`Invoke-WebRequest` GETs, `git fetch`/`git ls-remote`, and any configured read-only tools (see README's `readOnlyTools`).";

const PLAN_PARALLELISM_LINE =
	"Split work by folder: give every sub-agent task `paths` (the folders/files/globs it may change). Independent tasks with non-overlapping paths run in parallel in separate worktrees automatically; overlapping independent tasks are rejected — add a dependency or merge them. Set requires_main_tree only when the task needs uncommitted local changes.";

function gateShellPhrase(): string {
	const label = knownGateShellLabel();
	return label ? `${label} (the same shell as your bash tool)` : "the same shell as your bash tool";
}

function phaseExtra(state: WorkflowState): string | undefined {
	switch (state.phase) {
		case "analyze": {
			const lines: string[] = [
				"Edit and write are blocked in this phase. When the analysis report is submitted, a human must approve it (or revise it) before Plan begins.",
				EXTERNAL_CONTEXT_LINE,
			];
			lines.push(
				"Classify the request first — bug, feature, refactor, question, investigation, or chore — set `kind` accordingly, and follow that kind's section of the reference. " +
					"When there is a real design choice (feature and refactor especially), offer `options` with trade-offs and recommend one; otherwise leave them out. " +
					"`proposed_change` may be empty for a question or investigation: the human can end the run at the approval gate with the analysis itself as the deliverable, no implementation required.",
			);
			if (state.analysis) {
				lines.push(`The previous analysis was classified as "${state.analysis.kind}"; keep that kind unless the feedback changes what is being asked.`);
			}
			if (state.entry === "issue-triage") {
				lines.push("This is bare triage: the analysis itself is the expected deliverable.");
			}
			return lines.join("\n");
		}
		case "plan":
			return [
				EXTERNAL_CONTEXT_LINE,
				PLAN_PARALLELISM_LINE,
				`Verification commands run in ${gateShellPhrase()}; write them for that shell. The harness checks that the programs they invoke exist there when you submit the plan and rejects the plan otherwise.`,
			].join("\n");
		case "delegate":
			return "Call run_delegation now; it dispatches the plan's tasks.";
		case "supervise": {
			const lines: string[] = [];
			const coordinatorTasks = state.runs.filter((r) => r.status === "coordinator");
			if (coordinatorTasks.length > 0) {
				lines.push(
					`Coordinator-direct task(s) the coordinator must implement itself: ${coordinatorTasks.map((r) => r.task_id).join(", ")}.`,
				);
			}
			const outOfScope = state.runs.filter((r) => r.out_of_scope && r.out_of_scope.length > 0);
			if (outOfScope.length > 0) {
				lines.push(
					`Run(s) that changed files outside their declared paths (review these first; revert the stray changes or justify them in submit_review overrides): ${outOfScope
						.map((r) => `${r.task_id} (${(r.out_of_scope ?? []).join(", ")})`)
						.join("; ")}.`,
				);
			}
			const conflicts = state.runs.filter((r) => r.conflict);
			if (conflicts.length > 0) {
				lines.push(`Run(s) with an unresolved merge conflict that must be resolved before review: ${conflicts.map((r) => r.task_id).join(", ")}.`);
			}
			const needsAttention = state.runs.filter((r) => (r.spec_gaps && r.spec_gaps.length > 0) || r.stalled);
			if (needsAttention.length > 0) {
				lines.push(
					`Run(s) needing a decision: ${needsAttention
						.map((r) => {
							const reasons: string[] = [];
							if (r.spec_gaps && r.spec_gaps.length > 0) reasons.push(`${r.spec_gaps.length} spec gap(s)`);
							if (r.stalled) reasons.push("stalled (killed for exceeding its time budget)");
							return `${r.task_id} (${reasons.join(", ")})`;
						})
						.join("; ")}. Use resume_task (task_id, answer) to hand the implementer a decision and let it continue in its own workspace. A second spec gap on the same task is escalated automatically.`,
				);
			}
			lines.push("The implementer report for each dispatched task is in the run_delegation result above.");
			return lines.join("\n");
		}
		case "verify": {
			const lines: string[] = [];
			const required = requiredGateCommands(state);
			lines.push(
				required.length > 0
					? `Required gate commands (run them through run_gates, not through bash directly): ${required.join(", ")}`
					: "This plan listed no verification_commands; running run_gates with an empty list is not valid — report the gap instead.",
			);
			lines.push("Bash results do not count as gate evidence. A pass is rejected unless every required gate is green in the latest run_gates result.");
			lines.push(`Gates run in ${gateShellPhrase()}.`);
			lines.push(
				"A gate reported as NOT RUNNABLE (environment) cannot run in that shell at all: it is a gate-definition problem, not a product failure, and does not count toward the retry cap. " +
					"Fix it with amend_gate (replace the gate with a command that works, or remove it; the user must approve the amendment). Never use amend_gate to weaken a meaningful check.",
			);
			const lastFailure = state.failures[state.failures.length - 1];
			if (lastFailure) {
				lines.push("");
				lines.push(`## Latest failure record (attempt ${lastFailure.attempt_number})`);
				lines.push(`- failure_class: ${lastFailure.failure_class}`);
				lines.push(`- destination: ${lastFailure.destination}`);
				lines.push(`- summary: ${lastFailure.summary}`);
				if (lastFailure.escalation_answer) {
					lines.push(`- escalation_answer: ${lastFailure.escalation_answer}`);
				}
			}
			return lines.join("\n");
		}
		case "deliver": {
			const amendments = formatGateAmendments(state.gateAmendments);
			const lines: string[] = [
				"Commit with conventional commits (subjects are validated against git log since the base ref), then call submit_delivery with an outcome-first report.",
				`Push policy: ${pushPolicyLines(state).join(" ")}`,
			];
			if (amendments.length > 0) {
				lines.push(`Required gates were amended during this run with the user's approval; state this in the report:\n${amendments.map((a) => `- ${a}`).join("\n")}`);
			}
			return lines.join("\n");
		}
		case "ci":
			return state.pr
				? `Waiting on CI checks for PR #${state.pr.number} (${state.pr.url}). No tool call is needed: the harness watches the checks and resumes this run automatically when they finish.`
				: "Waiting on CI checks. No tool call is needed: the harness resumes this run automatically when they finish.";
		default:
			return undefined;
	}
}

/** The full instruction sent on entering a model-driven phase. */
export function phasePrompt(state: WorkflowState, extra?: string): string {
	const lines: string[] = [];
	lines.push(`[code-changes] Phase: ${PHASE_LABEL[state.phase]} (run ${state.id})`);
	lines.push("");
	lines.push(`## Task\n${state.task}`);
	lines.push("");
	lines.push(HARNESS_IS_THE_FLOW);

	if (state.previousRun && state.phase === "analyze") {
		lines.push("");
		lines.push("## Previous run in this session");
		lines.push("Context only: this is a new request; use the previous run's findings and outcome where they are relevant, but check they still hold.");
		lines.push(state.previousRun);
	}

	const references = referencesForPhase(state);
	for (const name of references) {
		lines.push("");
		lines.push(`## Reference: ${name}.md`);
		lines.push(name === "analyze" ? selectKindSections(readReference(name), state.analysis?.kind) : readReference(name));
	}

	lines.push("");
	lines.push("## Prior state");
	lines.push(summarizeState(state));

	lines.push("");
	lines.push(`## Tools available in this phase\n${toolsLine(state.phase)}`);

	const builtinExtra = phaseExtra(state);
	if (builtinExtra) {
		lines.push("");
		lines.push(builtinExtra);
	}
	if (extra?.trim()) {
		lines.push("");
		lines.push(`## Additional context\n${extra.trim()}`);
	}

	const artifactTool = PHASE_ARTIFACT_TOOL[state.phase];
	lines.push("");
	lines.push(
		artifactTool
			? `This phase ends only when you call \`${artifactTool}\`. The harness blocks tools outside this phase.`
			: "This phase ends only when the workflow advances it. The harness blocks tools outside this phase.",
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-turn reminder
// ---------------------------------------------------------------------------

/** Short reminder injected on every user prompt while a run is active. */
export function phaseReminder(state: WorkflowState): string {
	const lines: string[] = [];
	lines.push(`[code-changes] Run ${state.id} — phase: ${PHASE_LABEL[state.phase]}.`);
	lines.push(`Task: ${state.task}`);
	lines.push(`Allowed tools: ${toolsLine(state.phase)}`);
	if (state.phase === "deliver") {
		lines.push(`Push allowed: ${state.pushAllowed ? "yes" : "no"}`);
	}
	if (state.phase === "ci") {
		lines.push(
			state.pr
				? `Waiting on CI checks for PR #${state.pr.number}. The harness resumes this run automatically when they finish; use /change status to check, /change watch to restart watching, or /change abort to stop.`
				: "Waiting on CI checks. Use /change status.",
		);
		return lines.join("\n");
	}
	if (state.phase === "awaiting_plan_approval") {
		lines.push("Plan submitted; waiting for the human to approve it.");
		return lines.join("\n");
	}
	const artifactTool = PHASE_ARTIFACT_TOOL[state.phase];
	lines.push(artifactTool ? `Exit this phase by calling \`${artifactTool}\`.` : "This phase awaits a human decision (/change approve|revise|abort).");
	return lines.join("\n");
}
