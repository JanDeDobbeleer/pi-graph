/**
 * Artifact contract for the code-changes graph: one TypeBox schema per phase edge, plus the pure
 * apply/validate functions that enforce artifacts.md and verify.md against `WorkflowState`.
 *
 * No pi runtime calls and no I/O here — this module is exercised directly by unit tests. The
 * extension's event handlers call into these functions and persist the returned state.
 */

import { Type, type Static } from "typebox";
import { DEFAULT_MAX_PARALLEL } from "./delegate.ts";
import { isSubAgentTask, planWorkspaces, topologicalWaves, worktreeTaskIds } from "./planning.ts";
import { independent, overlappingPatterns } from "./paths.ts";
import { transition, type WorkflowState, type PlanTask, type TaskList, type ExecutorTier, type FailureRecord, type PullRequestRef, type AnalysisReport, type AnalysisKind, type AnalysisOption, ANALYSIS_KINDS } from "./state.ts";
import type { GateAmendment, GateResult, Phase } from "./state.ts";

// ---------------------------------------------------------------------------
// 1. Schemas
// ---------------------------------------------------------------------------

const AnalysisOptionSchema = Type.Object({
	id: Type.String({ description: "Short unique identifier for this option, e.g. 'A' or 'inline-cache'." }),
	title: Type.String({ description: "One-line name of the approach." }),
	summary: Type.String({ description: "What this approach does and which files it touches." }),
	tradeoffs: Type.String({ description: "What it costs and what it buys compared with the other options." }),
	no_change: Type.Optional(
		Type.Boolean({
			description:
				"True when this option needs no repository change (e.g. existing config or docs answer it). Choosing it ends the run with the analysis as the deliverable.",
		}),
	),
});

export const AnalysisSchema = Type.Object({
	kind: Type.Union(
		[
			Type.Literal("bug"),
			Type.Literal("feature"),
			Type.Literal("refactor"),
			Type.Literal("question"),
			Type.Literal("investigation"),
			Type.Literal("chore"),
		],
		{ description: "Classify the request: bug, feature, refactor, question, investigation, or chore." },
	),
	findings: Type.String({
		description:
			"By kind. bug: the root cause, with file references. feature: current behavior and where the change fits. refactor: what the current code does, as a list — it becomes the acceptance criteria. question: the answer. investigation: what was found. chore: what needs doing and where.",
	}),
	proposed_change: Type.String({
		description:
			"The scope of the change, in enough detail to plan tasks from. May be empty for a question or investigation, or when recommending no change; required for bug/feature/refactor/chore unless options are given (the human then picks one).",
	}),
	out_of_scope: Type.String({ description: "What is deliberately left alone." }),
	evidence: Type.String({
		description:
			"By kind. bug: reproduction, or why it could not be reproduced. feature: prior art in the code/docs. question: sources. otherwise: the evidence the findings rest on.",
	}),
	open_questions: Type.Array(Type.String(), {
		description: "Anything still unresolved. Must be empty for the stop gate to clear automatically.",
	}),
	options: Type.Optional(
		Type.Array(AnalysisOptionSchema, {
			description: "Alternative approaches with trade-offs, when there is a real design choice. The human picks one at the gate.",
		}),
	),
	recommendation: Type.Optional(Type.String({ description: "The id of the option you recommend. Omit when there are no options." })),
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
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Repo-relative folders, files or globs this task may change, e.g. "src/segments/", "website/docs/segments/cloud/gcp.mdx", "src/**/*_test.go". Required for trivial/implementer tasks; independent tasks must not overlap.',
		}),
	),
	requires_main_tree: Type.Optional(
		Type.Boolean({
			description: "True when the task needs uncommitted changes in the main tree, so it must not be moved to a worktree.",
		}),
	),
});

export const PlanSchema = Type.Object({
	tasks: Type.Array(PlanTaskSchema, { description: "One entry per task to delegate." }),
	merge_plan: Type.Optional(
		Type.Object(
			{
				order: Type.Array(Type.String(), { description: "Task IDs in the order their worktrees should be merged." }),
				conflict_owner: Type.String({ description: "Who resolves a merge conflict between worktree tasks." }),
			},
			{
				description:
					"Optional. When given, order must list exactly the tasks that end up in worktrees (the harness moves independent main-tree tasks there); when omitted, worktree branches merge in plan order.",
			},
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

export interface AnalysisHeadings {
	findings: string;
	evidence: string;
}

const ANALYSIS_HEADINGS: Record<AnalysisKind, AnalysisHeadings> = {
	bug: { findings: "Root cause", evidence: "Reproduction" },
	feature: { findings: "Current behavior and where it fits", evidence: "Prior art" },
	refactor: { findings: "What the current code does", evidence: "Evidence" },
	question: { findings: "Answer", evidence: "Sources" },
	investigation: { findings: "Findings", evidence: "Evidence" },
	chore: { findings: "What needs doing", evidence: "Evidence" },
};

/** The section headings `formatAnalysis` uses for the findings and evidence fields of a given kind. */
export function analysisHeadings(kind: AnalysisKind): AnalysisHeadings {
	return ANALYSIS_HEADINGS[kind];
}

const PROPOSED_CHANGE_HEADING = "Proposed change";
const OUT_OF_SCOPE_HEADING = "Out of scope";
const OPTIONS_HEADING = "Options";
const NO_CHANGE_TEXT = "_No change proposed._";
const OPTION_MARKS = /\s*\((recommended|chosen|no code change)\)\s*$/i;

/** Kinds where a change is expected: `proposed_change` (or options to pick from) is required. */
const CHANGE_KINDS: readonly AnalysisKind[] = ["bug", "feature", "refactor", "chore"];

function isAnalysisKind(value: unknown): value is AnalysisKind {
	return typeof value === "string" && (ANALYSIS_KINDS as readonly string[]).includes(value);
}

/** True when the analysis carries something to plan from: a proposed change, or a chosen option. */
export function hasProposedChange(a: AnalysisReport): boolean {
	return a.proposed_change.trim() !== "" || a.chosen_option !== undefined;
}

/**
 * Renders an analysis report as Markdown for the approval-gate transcript message and for the
 * human-editing flow (`ctx.ui.editor`). Open questions come first, when any are unresolved, so
 * they aren't missed below the other sections. `parseAnalysisMarkdown` is the inverse.
 */
export function formatAnalysis(a: AnalysisReport, opts?: { edited?: boolean }): string {
	const headings = analysisHeadings(a.kind);
	const lines: string[] = [];
	lines.push(`# Analysis — ${a.kind}`);
	lines.push(`Kind: ${a.kind}`);
	if (opts?.edited) lines.push("_(edited by you)_");
	if (a.open_questions.length > 0) {
		lines.push("");
		lines.push("## Open questions");
		for (const q of a.open_questions) lines.push(`- ${q}`);
	}
	lines.push("");
	lines.push(`## ${headings.findings}\n${a.findings}`);
	lines.push("");
	lines.push(`## ${headings.evidence}\n${a.evidence}`);
	lines.push("");
	lines.push(`## ${PROPOSED_CHANGE_HEADING}\n${a.proposed_change.trim() ? a.proposed_change : NO_CHANGE_TEXT}`);
	if (a.options && a.options.length > 0) {
		lines.push("");
		lines.push(`## ${OPTIONS_HEADING}`);
		for (const o of a.options) {
			const marks = (a.recommendation === o.id ? " (recommended)" : "") + (a.chosen_option === o.id ? " (chosen)" : "") + (o.no_change ? " (no code change)" : "");
			lines.push(`### ${o.id} — ${o.title}${marks}`);
			lines.push(o.summary);
			lines.push(`Trade-offs: ${o.tradeoffs}`);
			lines.push("");
		}
		while (lines[lines.length - 1] === "") lines.pop();
	}
	lines.push("");
	lines.push(`## ${OUT_OF_SCOPE_HEADING}\n${a.out_of_scope}`);
	return lines.join("\n");
}

function parseOptions(body: string[]): { options: AnalysisOption[]; recommendation?: string; chosen?: string } {
	const options: AnalysisOption[] = [];
	let recommendation: string | undefined;
	let chosen: string | undefined;
	let current: { id: string; title: string; noChange: boolean; lines: string[] } | undefined;
	const flush = () => {
		if (!current) return;
		const text = current.lines.join("\n");
		const split = text.match(/^([\s\S]*?)(?:^|\n)[ \t]*trade-?offs?:[ \t]*([\s\S]*)$/i);
		const summary = (split ? split[1] : text).trim();
		const tradeoffs = (split ? split[2] : "").trim();
		options.push({ id: current.id, title: current.title, summary, tradeoffs, ...(current.noChange ? { no_change: true } : {}) });
		current = undefined;
	};
	for (const line of body) {
		const heading = line.match(/^###\s+(.+?)\s*$/);
		if (heading) {
			flush();
			let text = heading[1];
			const found: string[] = [];
			for (let marks = text.match(OPTION_MARKS); marks; marks = text.match(OPTION_MARKS)) {
				found.push(marks[1].toLowerCase());
				text = text.slice(0, marks.index);
			}
			const m = text.match(/^(\S+)(?:\s+[—–-]+\s+(.*)|\s+(.*))?$/);
			const id = m ? m[1] : text.trim();
			const title = (m ? (m[2] ?? m[3] ?? "") : "").trim();
			if (found.includes("recommended")) recommendation = id;
			if (found.includes("chosen")) chosen = id;
			current = { id, title, noChange: found.includes("no code change"), lines: [] };
			continue;
		}
		if (current) current.lines.push(line);
	}
	flush();
	return { options, recommendation, chosen };
}

/**
 * Parses `formatAnalysis`'s Markdown back into an `AnalysisReport`. Tolerant of the human deleting
 * or reordering sections (matched by heading text, not position), of any kind's heading variants
 * (plus the neutral "Findings"/"Evidence"), and of extra prose outside any `## ` section. The kind
 * comes from the `Kind:` line, else the title, else the headings used, else "bug". `open_questions`
 * are `- ` bullets under "Open questions"; missing entirely means none. Options are the `### `
 * blocks under "Options". Throws `ArtifactError` naming any missing required section (the
 * findings and evidence sections, and Proposed change where the kind expects a change and no
 * options are given — the same rules `applyAnalysis` enforces).
 */
export function parseAnalysisMarkdown(md: string): AnalysisReport {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const sections = new Map<string, string[]>();
	let current: string | undefined;
	let title: string | undefined;
	let kindLine: string | undefined;
	for (const line of lines) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			current = heading[1].trim().toLowerCase();
			if (!sections.has(current)) sections.set(current, []);
			continue;
		}
		if (/^#\s+/.test(line)) {
			current = undefined; // top-level title (or a stray "# ..."): not a section body
			title ??= line.replace(/^#\s+/, "").trim();
			continue;
		}
		if (current) {
			sections.get(current)!.push(line);
		} else {
			const k = line.match(/^\s*kind:\s*(\S+)\s*$/i);
			if (k) kindLine ??= k[1];
		}
	}

	const sectionText = (heading: string): string => {
		const body = sections.get(heading.toLowerCase());
		if (!body) return "";
		return body.join("\n").trim();
	};

	let kind: AnalysisKind | undefined;
	if (kindLine !== undefined) {
		const candidate = kindLine.toLowerCase();
		if (!isAnalysisKind(candidate)) {
			throw new ArtifactError(`Edited analysis has an unknown kind "${kindLine}"; expected one of: ${ANALYSIS_KINDS.join(", ")}.`);
		}
		kind = candidate;
	}
	if (!kind && title) {
		const fromTitle = title.toLowerCase().match(/(?:—|–|-|:)\s*(\w+)\s*$/)?.[1];
		if (isAnalysisKind(fromTitle)) kind = fromTitle;
	}
	if (!kind) {
		// Infer from a kind-specific findings heading; bug is the historical default.
		kind = ANALYSIS_KINDS.find((k) => k !== "investigation" && sections.has(ANALYSIS_HEADINGS[k].findings.toLowerCase())) ?? "bug";
	}
	const resolved: AnalysisKind = kind;

	// Findings/evidence: the kind's own heading first, then any other kind's variant, then the old names.
	const firstText = (field: keyof AnalysisHeadings): string => {
		const candidates = [ANALYSIS_HEADINGS[resolved][field], ...ANALYSIS_KINDS.map((k) => ANALYSIS_HEADINGS[k][field])];
		if (field === "evidence") candidates.push("Repro status");
		for (const h of new Set(candidates)) {
			const text = sectionText(h);
			if (text) return text;
		}
		return "";
	};

	const findings = firstText("findings");
	const evidence = firstText("evidence");
	let proposed = sectionText(PROPOSED_CHANGE_HEADING);
	if (proposed === NO_CHANGE_TEXT) proposed = "";

	const parsedOptions = parseOptions(sections.get(OPTIONS_HEADING.toLowerCase()) ?? []);
	const missing: string[] = [];
	if (!findings) missing.push(analysisHeadings(resolved).findings);
	if (!evidence) missing.push(analysisHeadings(resolved).evidence);
	if (!proposed && CHANGE_KINDS.includes(resolved) && parsedOptions.options.length === 0) missing.push(PROPOSED_CHANGE_HEADING);
	if (missing.length > 0) {
		throw new ArtifactError(`Edited analysis is missing required section(s): ${missing.join(", ")}.`);
	}

	const openQuestionsBody = sections.get("open questions") ?? [];
	const open_questions = openQuestionsBody
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2).trim())
		.filter((l) => l.length > 0);

	const report: AnalysisReport = {
		kind: resolved,
		findings,
		proposed_change: proposed,
		out_of_scope: sectionText(OUT_OF_SCOPE_HEADING),
		evidence,
		open_questions,
	};
	if (parsedOptions.options.length > 0) report.options = parsedOptions.options;
	if (parsedOptions.recommendation !== undefined) report.recommendation = parsedOptions.recommendation;
	if (parsedOptions.chosen !== undefined) report.chosen_option = parsedOptions.chosen;
	return report;
}

/**
 * Records the human's pick of one of `analysis.options`. Sets `chosen_option` and makes
 * `proposed_change` describe the chosen option: prefixed to the existing text only when that text
 * is non-empty and the chosen option is the recommended one; otherwise it replaces it.
 */
export function selectOption(analysis: AnalysisReport, optionId: string): AnalysisReport {
	const option = analysis.options?.find((o) => o.id === optionId);
	if (!option) {
		const known = (analysis.options ?? []).map((o) => o.id);
		throw new ArtifactError(
			`Unknown option "${optionId}"${known.length > 0 ? `; choose one of: ${known.join(", ")}` : "; this analysis has no options"}.`,
		);
	}
	const prefix = `Chosen option ${option.id} — ${option.title}: ${option.summary}`;
	const previous = analysis.proposed_change.trim();
	let proposed = prefix;
	if (previous && analysis.recommendation === option.id) proposed = previous.startsWith(prefix) ? previous : `${prefix}\n\n${previous}`;
	return { ...analysis, chosen_option: option.id, proposed_change: proposed };
}

/** Gate entry for picking an option; the option id follows the prefix. */
const GO_WITH = "Go with ";

/** The entries of the analysis approval gate's select, in display order. Pure, so tests can pin it. */
export function analysisGateChoices(a: AnalysisReport): string[] {
	const choices: string[] = [];
	for (const o of a.options ?? []) {
		choices.push(`${GO_WITH}${o.id} — ${o.title}${a.recommendation === o.id ? " (recommended)" : ""}${o.no_change ? " (no code change, ends the run)" : ""}`);
	}
	if (hasProposedChange(a)) choices.push("Approve", "Approve and allow push/PR");
	choices.push("Edit the analysis myself", "Send feedback to revise", "Done — no implementation", "Stop the run");
	return choices;
}

/** The option id behind a "Go with ..." gate entry, or undefined for any other entry. */
export function optionIdFromChoice(a: AnalysisReport, choice: string): string | undefined {
	if (!choice.startsWith(GO_WITH)) return undefined;
	return a.options?.find((o) => choice.startsWith(`${GO_WITH}${o.id} — `))?.id;
}

// ---------------------------------------------------------------------------
// 3. Analyze -> Plan / Awaiting approval
// ---------------------------------------------------------------------------

export function applyAnalysis(state: WorkflowState, params: AnalysisParams): WorkflowState {
	if (state.phase !== "analyze") {
		throw new ArtifactError(`Cannot submit an analysis report while in phase "${state.phase}"; expected "analyze".`);
	}
	if (!isAnalysisKind(params.kind)) {
		throw new ArtifactError(`Analysis report has an invalid kind "${String(params.kind)}"; expected one of: ${ANALYSIS_KINDS.join(", ")}.`);
	}
	const options = params.options ?? [];
	// An empty recommendation means "none"; with no options there is nothing to recommend.
	const rawRecommendation = typeof params.recommendation === "string" ? params.recommendation.trim() : undefined;
	const recommendation = options.length > 0 && rawRecommendation ? rawRecommendation : undefined;
	const a: AnalysisParams = { ...params, recommendation };
	if (recommendation === undefined) delete a.recommendation;
	const missing: string[] = [];
	if (!a.findings.trim()) missing.push("findings");
	if (!a.evidence.trim()) missing.push("evidence");
	if (!a.proposed_change.trim() && CHANGE_KINDS.includes(a.kind) && options.length === 0) missing.push("proposed_change");
	if (missing.length > 0) {
		const hint = missing.includes("proposed_change") ? ` A ${a.kind} needs a proposed_change, or options for the human to choose from.` : "";
		throw new ArtifactError(`Analysis report is missing required field(s): ${missing.join(", ")}.${hint}`);
	}

	const ids = options.map((o) => o.id.trim());
	if (ids.some((id) => !id)) throw new ArtifactError("Analysis options must each have a non-empty id.");
	const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
	if (dupes.length > 0) throw new ArtifactError(`Analysis options have duplicate id(s): ${[...new Set(dupes)].join(", ")}.`);
	if (a.recommendation !== undefined && !options.some((o) => o.id.trim() === a.recommendation)) {
		throw new ArtifactError(
			`Analysis recommendation "${a.recommendation}" does not match an option id${ids.length > 0 ? ` (${ids.join(", ")})` : " (no options were given)"}.`,
		);
	}

	let findings = a.findings;
	const pending = state.escalations.filter((e) => e.phase === "analyze");
	if (pending.length > 0) {
		const folded = pending.map((e) => `- Q: ${e.question} -> A: ${e.decision}`).join("\n");
		findings = `${findings}\n\nEscalation decisions:\n${folded}`;
	}

	let analysis: AnalysisReport = { ...a, findings };
	// A Verify bounce back to Analyze (wrong_root_cause) must re-arm the human stop gate even on a
	// preApproved run: verify.md — "Re-entering Phase 1 re-arms its stop gate." `state.failures`
	// being non-empty means this analysis follows at least one Verify attempt, so it always goes
	// through approval again. A run only auto-advances when there is a change to plan from: a
	// proposed change, or a recommendation to take. Questions and investigations stop at the gate.
	// A recommended option that needs no repository change has nothing to plan: the human confirms it.
	const recommended = options.find((o) => o.id.trim() === a.recommendation);
	const canAdvance = !recommended?.no_change && (a.proposed_change.trim() !== "" || a.recommendation !== undefined);
	const advance = state.preApproved && a.open_questions.length === 0 && state.failures.length === 0 && canAdvance;
	if (advance && a.proposed_change.trim() === "" && a.recommendation !== undefined) {
		analysis = selectOption(analysis, a.recommendation);
	}
	return transition({ ...state, analysis }, advance ? "plan" : "awaiting_approval");
}

// ---------------------------------------------------------------------------
// 4. Plan -> Delegate
// ---------------------------------------------------------------------------

function pathProblem(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return "it is empty";
	if (/^([a-zA-Z]:|[\\/])/.test(trimmed)) return "it must be repo-relative, not absolute";
	if (trimmed.replace(/\\/g, "/").split("/").includes("..")) return 'it must not contain ".."';
	return undefined;
}

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

		if (isSubAgentTask(task) && (task.paths?.length ?? 0) === 0) {
			problems.push(
				`Task "${task.id}" has no paths; list the repo-relative folders, files or globs it may change (required for ${task.executor_tier} tasks).`,
			);
		}
		for (const raw of task.paths ?? []) {
			const issue = pathProblem(raw);
			if (issue) problems.push(`Task "${task.id}" has an invalid path "${raw}": ${issue}.`);
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

	if (hasCycle) return problems;

	// Independent sub-agent tasks must not be able to change the same files: they may run at the same
	// time in separate worktrees. Coordinator-direct tasks run later, sequentially, so they are exempt.
	const subAgentTasks = plan.tasks.filter((t) => isSubAgentTask(t) && (t.paths?.length ?? 0) > 0);
	for (let i = 0; i < subAgentTasks.length; i++) {
		for (let j = i + 1; j < subAgentTasks.length; j++) {
			const a = subAgentTasks[i];
			const b = subAgentTasks[j];
			if (!independent(a.id, b.id, plan.tasks)) continue;
			const pairs = overlappingPatterns(a.paths ?? [], b.paths ?? []);
			if (pairs.length === 0) continue;
			const detail = pairs.map(([pa, pb]) => (pa === pb ? `"${pa}"` : `"${pa}" and "${pb}"`)).join(", ");
			problems.push(
				`tasks ${a.id} and ${b.id} may change the same files (${detail}); add a dependency between them or merge them.`,
			);
		}
	}

	// merge_plan is optional (the harness merges in plan order), but when given it must name exactly the
	// tasks that end up in worktrees, which the harness decides (see planning.ts).
	if (plan.merge_plan) {
		const worktreeIds = new Set(worktreeTaskIds(plan));
		const orderCounts = new Map<string, number>();
		for (const id of plan.merge_plan.order) {
			orderCounts.set(id, (orderCounts.get(id) ?? 0) + 1);
		}
		const missingFromOrder = [...worktreeIds].filter((id) => !orderCounts.has(id));
		const extraInOrder = plan.merge_plan.order.filter((id) => !worktreeIds.has(id));
		const duplicated = [...orderCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
		const expected = worktreeIds.size > 0 ? ` (tasks that run in worktrees: ${[...worktreeIds].join(", ")})` : " (no task runs in a worktree)";
		if (missingFromOrder.length > 0) {
			problems.push(`merge_plan.order is missing worktree task(s): ${missingFromOrder.join(", ")}${expected}.`);
		}
		if (extraInOrder.length > 0) {
			problems.push(`merge_plan.order references non-worktree task(s): ${extraInOrder.join(", ")}${expected}.`);
		}
		if (duplicated.length > 0) {
			problems.push(`merge_plan.order lists task(s) more than once: ${duplicated.join(", ")}.`);
		}
		if (!plan.merge_plan.conflict_owner.trim()) {
			problems.push("merge_plan.conflict_owner is required.");
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
	const next = state.preApproved ? "delegate" : "awaiting_plan_approval";
	return transition({ ...state, plan: taskList }, next);
}

// ---------------------------------------------------------------------------
// 4a. Plan <-> Markdown (plan-approval-gate display) and <-> editable JSON (human editing round trip)
// ---------------------------------------------------------------------------

/** How the plan will run: resolved models per tier and the parallelism cap. All optional; used for display only. */
export interface PlanExecutionOptions {
	/** Resolved "provider/model" refs per executor tier; undefined means the session model. */
	models: Partial<Record<ExecutorTier, string>>;
	maxParallel: number;
	/** Tiers whose configured model could not be resolved (they run on the session model instead). */
	fellBack?: ExecutorTier[];
	/** True when the main tree has uncommitted changes (worktrees branch from HEAD and will not see them). */
	mainTreeDirty?: boolean;
}

export interface FormatPlanOptions {
	edited?: boolean;
	execution?: PlanExecutionOptions;
}

const MAX_LISTED_GATES = 6;

function plural(n: number, one: string, many: string = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Escapes a Markdown table cell. */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Renders a task list as Markdown for the plan-approval-gate transcript message: an "Execution"
 * overview first (waves, models, workspaces, parallelism, merge/verify/deliver), then one heading
 * per task with its id, executor tier, workspace, dependencies, full spec, and verification commands.
 */
export function formatPlan(plan: TaskList, opts?: FormatPlanOptions): string {
	const lines: string[] = [];
	lines.push("# Plan");
	if (opts?.edited) lines.push("_(edited by you)_");
	let decisions: ReturnType<typeof planWorkspaces> | undefined;
	try {
		decisions = planWorkspaces(plan);
	} catch {
		decisions = undefined; // cyclic plan: validatePlan reports it; just skip the computed section
	}
	if (decisions) lines.push(...formatExecution(plan, decisions, opts?.execution));
	for (const t of plan.tasks) {
		lines.push("");
		lines.push(`## Task ${t.id}`);
		lines.push(`- executor tier: ${t.executor_tier}`);
		const decision = decisions?.get(t.id);
		lines.push(
			`- workspace: ${t.workspace}${decision?.auto ? " (the harness moves it to a worktree so it can run in parallel)" : ""}`,
		);
		lines.push(`- dependencies: ${t.dependencies.length > 0 ? t.dependencies.join(", ") : "none"}`);
		lines.push(`- paths: ${t.paths && t.paths.length > 0 ? t.paths.join(", ") : "(unspecified)"}`);
		if (t.requires_main_tree) lines.push("- requires main tree: yes (never moved to a worktree)");
		lines.push("");
		lines.push("### Spec");
		lines.push(t.spec);
		lines.push("");
		lines.push("### Verification commands");
		if (t.verification_commands.length > 0) {
			for (const cmd of t.verification_commands) lines.push(`- ${cmd}`);
		} else {
			lines.push("- (none)");
		}
	}
	return lines.join("\n");
}

/** The "## Execution" overview: summary counts, heads-ups, one table per wave, and the merge/verify/deliver line. */
function formatExecution(plan: TaskList, decisions: ReturnType<typeof planWorkspaces>, exec?: PlanExecutionOptions): string[] {
	const maxParallel = exec?.maxParallel ?? DEFAULT_MAX_PARALLEL;
	const waves = topologicalWaves(plan.tasks);
	const subAgent = plan.tasks.filter(isSubAgentTask);
	const direct = plan.tasks.filter((t) => !isSubAgentTask(t));
	const worktreeIds = worktreeTaskIds(plan);
	const moved = worktreeIds.filter((id) => decisions.get(id)?.auto);
	const mainSub = subAgent.filter((t) => decisions.get(t.id)?.workspace !== "worktree");

	const summary = [plural(plan.tasks.length, "task"), plural(waves.length, "wave"), `up to ${maxParallel} at once`];
	if (worktreeIds.length > 0) {
		summary.push(`${worktreeIds.length} in worktrees${moved.length > 0 ? ` (${moved.length} moved from main)` : ""}`);
	}
	if (direct.length > 0) summary.push(`${direct.length} by the coordinator`);
	if (mainSub.length > 0) summary.push(`${mainSub.length} in the main tree`);

	const lines: string[] = ["", "## Execution", summary.join(" · ")];

	const headsUp: string[] = [];
	const fellBack = [...new Set(exec?.fellBack ?? [])];
	if (fellBack.length > 0) {
		headsUp.push(`the configured model for ${fellBack.map((t) => `\`${t}\``).join(", ")} is unavailable (unknown model, or no API key/login for its provider); the session model is used instead`);
	}
	if (exec?.mainTreeDirty && worktreeIds.length > 0) {
		headsUp.push(`the main tree has uncommitted changes; worktree tasks (${worktreeIds.join(", ")}) branch from HEAD and will not see them`);
	}

	const wavesOut: string[] = [];
	const earlier = new Set<string>();
	waves.forEach((wave, index) => {
		const waveSub = wave.filter(isSubAgentTask);
		const waveWorktree = waveSub.filter((t) => decisions.get(t.id)?.workspace === "worktree");
		const waveMain = waveSub.filter((t) => decisions.get(t.id)?.workspace !== "worktree");
		const concurrent = waveWorktree.length + (waveMain.length > 0 ? 1 : 0);
		const suffix: string[] = [];
		if (concurrent >= 2) suffix.push("parallel");
		else if (waveMain.length > 1) suffix.push("one after another (main tree)");
		const waveIds = new Set(wave.map((t) => t.id));
		const deps: string[] = [];
		for (const t of wave) {
			for (const d of t.dependencies) if (earlier.has(d) && !waveIds.has(d) && !deps.includes(d)) deps.push(d);
		}
		if (deps.length > 0) suffix.push(`after ${deps.join(", ")}`);
		for (const t of wave) earlier.add(t.id);

		if (waveMain.length > 1) {
			headsUp.push(`wave ${index + 1}: ${waveMain.map((t) => t.id).join(", ")} stay in the main tree and run one after another`);
		}

		wavesOut.push("");
		wavesOut.push(`### Wave ${index + 1}${suffix.length > 0 ? ` — ${suffix.join(", ")}` : ""}`);
		wavesOut.push("| task | runs on | workspace | paths |");
		wavesOut.push("|---|---|---|---|");
		for (const t of wave) {
			wavesOut.push(`| ${cell(t.id)} | ${cell(runsOn(t, exec))} | ${cell(workspaceLabel(t, decisions.get(t.id)))} | ${cell(pathsLabel(t))} |`);
		}
		if (concurrent > maxParallel) {
			wavesOut.push("");
			wavesOut.push(`_${concurrent} tasks, ${maxParallel} at a time_`);
		}
	});

	if (headsUp.length > 0) {
		lines.push("");
		lines.push("**Heads-up:**");
		for (const h of headsUp) lines.push(`- ${h}`);
	}
	lines.push(...wavesOut);

	const then: string[] = [];
	if (worktreeIds.length > 1) {
		const order = plan.merge_plan?.order ?? worktreeIds;
		then.push(`squash-merge ${order.join(" → ")}${plan.merge_plan ? ` (conflicts: ${plan.merge_plan.conflict_owner})` : ""}`);
	} else {
		then.push("nothing to merge");
	}
	then.push(
		`Supervise reviews the ${worktreeIds.length > 1 ? "merged " : ""}diff${direct.length > 0 ? ` and implements ${direct.map((t) => t.id).join(", ")}` : ""}`,
	);
	const gates: string[] = [];
	for (const t of plan.tasks) for (const c of t.verification_commands) if (!gates.includes(c)) gates.push(c);
	if (gates.length === 0) {
		then.push("Verify runs no gates");
	} else {
		const listed = gates.slice(0, MAX_LISTED_GATES).map((c) => `\`${c}\``);
		if (gates.length > MAX_LISTED_GATES) listed.push(`+${gates.length - MAX_LISTED_GATES} more`);
		then.push(`Verify runs ${plural(gates.length, "gate")} on the ${worktreeIds.length > 1 ? "merged state" : "result"} (${listed.join(", ")})`);
	}
	then.push("Deliver");
	lines.push("");
	lines.push(`**Then:** ${then.join(" · ")}`);
	return lines;
}

function runsOn(t: PlanTask, exec?: PlanExecutionOptions): string {
	const name = isSubAgentTask(t) ? t.executor_tier : "coordinator";
	if (!exec) return name;
	const ref = exec.models[t.executor_tier];
	const fallback = (exec.fellBack ?? []).includes(t.executor_tier);
	return `${name} → ${ref ?? "session model"}${fallback ? " (fallback)" : ""}`;
}

function workspaceLabel(t: PlanTask, decision?: { workspace: "main" | "worktree"; auto: boolean }): string {
	if (!isSubAgentTask(t)) return "main (in Supervise)";
	if (decision?.workspace === "worktree") return decision.auto ? "worktree (moved from main)" : "worktree";
	return t.requires_main_tree ? "main (requires main tree)" : "main";
}

function pathsLabel(t: PlanTask): string {
	return t.paths && t.paths.length > 0 ? t.paths.map((p) => `\`${p}\``).join(", ") : "—";
}

const PLAN_EDIT_COMMENT = [
	"<!--",
	"Edit the task list below, then save. This is the plan JSON the gate parses back on save:",
	'  - tasks[].id: short unique identifier, e.g. "task-1"',
	"  - tasks[].spec: approach, files/entry points, constraints, pinned skill rules, non-goals",
	"  - tasks[].verification_commands: commands the executor must run and pass before reporting done",
	'  - tasks[].executor_tier: "trivial" | "implementer" | "coordinator-direct"',
	'  - tasks[].workspace: "main" | "worktree"',
	"  - tasks[].dependencies: ids of other tasks in this plan that must land first, if any",
	'  - tasks[].paths: repo-relative folders, files or globs the task may change (required for sub-agent tasks; independent tasks must not overlap)',
	"  - tasks[].requires_main_tree: optional; true keeps the task in the main tree (needs uncommitted local changes)",
	"  - merge_plan (optional; when given it must list exactly the tasks that run in worktrees, otherwise plan order is used):",
	"      order: task ids in the order their worktrees should be merged",
	"      conflict_owner: who resolves a merge conflict between worktree tasks",
	"-->",
].join("\n");

/** Renders a task list as the round-trippable editor prefill for the plan-approval-gate edit flow. */
export function planToEditable(plan: TaskList): string {
	const json = JSON.stringify(plan, null, 2);
	return `${PLAN_EDIT_COMMENT}\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/**
 * Parses `planToEditable`'s editor text back into a `TaskList`: extracts the fenced ```json block
 * (or treats the whole text as JSON when there's no fence), `JSON.parse`s it, then runs
 * `validatePlan` and throws `ArtifactError` listing every problem found.
 */
export function parseEditablePlan(text: string): TaskList {
	const fenced = text.match(/```json\s*([\s\S]*?)```/);
	const jsonText = (fenced ? fenced[1] : text).trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ArtifactError(`Edited plan is not valid JSON: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
		throw new ArtifactError('Edited plan is missing a "tasks" array.');
	}

	const plan = parsed as PlanParams;
	const problems = validatePlan(plan);
	if (problems.length > 0) {
		throw new ArtifactError(`Edited plan is invalid:\n- ${problems.join("\n- ")}`);
	}

	return { tasks: plan.tasks, merge_plan: plan.merge_plan };
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

export { topologicalWaves };

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

/**
 * The gates Verify requires: the plan's verification commands with the human-approved
 * amendments applied in order (a replacement swaps the gate in place, a removal drops it).
 */
export function requiredGateCommands(state: WorkflowState): string[] {
	const seen = new Set<string>();
	let commands: string[] = [];
	for (const task of state.plan?.tasks ?? []) {
		for (const cmd of task.verification_commands) {
			if (!seen.has(cmd)) {
				seen.add(cmd);
				commands.push(cmd);
			}
		}
	}
	for (const a of state.gateAmendments ?? []) {
		const at = commands.findIndex((c) => c.trim() === a.old.trim());
		if (at === -1) continue;
		const replacement = a.new?.trim();
		if (!replacement) {
			commands = commands.filter((_, i) => i !== at);
		} else if (commands.some((c, i) => i !== at && c.trim() === replacement)) {
			commands = commands.filter((_, i) => i !== at); // already required: just drop the old one
		} else {
			commands = commands.map((c, i) => (i === at ? replacement : c));
		}
	}
	return commands;
}

/** The amendment to apply: which required gate, what replaces it (omit to remove), and why. */
export interface GateAmendmentRequest {
	gate: string;
	replacement?: string;
	reason: string;
}

/** Checks an amendment request against the current required gates; returns the exact gate it targets. */
export function validateGateAmendment(state: WorkflowState, req: GateAmendmentRequest): string {
	if (state.phase !== "supervise" && state.phase !== "verify") {
		throw new ArtifactError(`amend_gate is only valid in Supervise or Verify (current: ${state.phase}).`);
	}
	const required = requiredGateCommands(state);
	const target = required.find((c) => c.trim() === req.gate.trim());
	if (target === undefined) {
		throw new ArtifactError(
			`"${req.gate}" is not a required gate. Required gates: ${required.length > 0 ? required.map((c) => `\`${c}\``).join(", ") : "(none)"}.`,
		);
	}
	if (!req.reason.trim()) throw new ArtifactError("amend_gate: reason is required.");
	if (req.replacement !== undefined && req.replacement.trim() === "") {
		throw new ArtifactError("amend_gate: replacement is empty; omit it to remove the gate.");
	}
	if (req.replacement !== undefined && req.replacement.trim() === target.trim()) {
		throw new ArtifactError("amend_gate: the replacement is identical to the gate.");
	}
	return target;
}

/**
 * Records a human-approved gate amendment and drops the amended gate's stale result from
 * `lastGates`, so a failing or not-runnable run of the old command cannot block the new gate set.
 */
export function applyGateAmendment(state: WorkflowState, req: GateAmendmentRequest, approvedAt: string): WorkflowState {
	const target = validateGateAmendment(state, req);
	const amendment: GateAmendment = {
		old: target,
		new: req.replacement?.trim(),
		reason: req.reason.trim(),
		phase: state.phase,
		approved_at: approvedAt,
	};
	return {
		...state,
		gateAmendments: [...(state.gateAmendments ?? []), amendment],
		lastGates: state.lastGates.filter((g) => g.command.trim() !== target.trim()),
	};
}

/** One line per amendment, for the review / Deliver report. */
export function formatGateAmendments(amendments: GateAmendment[] | undefined): string[] {
	return (amendments ?? []).map((a) => `\`${a.old}\` → ${a.new ? `\`${a.new}\`` : "removed"} (${a.reason}; approved by the user in ${a.phase})`);
}

/** The phase `/change resume` reopens for a run that stopped from `from`, or undefined when it cannot be reopened. */
export function resumeTargetFor(from: Phase): Phase | undefined {
	switch (from) {
		case "analyze":
		case "plan":
		case "supervise":
		case "verify":
		case "deliver":
			return from;
		case "awaiting_approval":
			return "analyze";
		case "awaiting_plan_approval":
		case "delegate":
			return "plan";
		default:
			return undefined;
	}
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
		} else if (result.exit_code !== 0 || result.runnable === false) {
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
		.map((f) =>
			f.harness
				? `- Environment issue (not counted): gate(s) could not run. ${f.summary}`
				: `- Attempt ${f.attempt_number}: ${f.failure_class} -> ${f.destination}. ${f.summary}`,
		)
		.join("\n");
}

export interface VerificationOptions {
	/** Failures before this index were reset by `/change resume`; they no longer count toward the retry cap. */
	countFrom?: number;
}

/** Failures that count toward the retry cap: not environment (harness) failures, and not before the last resume. */
export function countedFailures(state: WorkflowState, countFrom = 0): FailureRecord[] {
	return state.failures.slice(countFrom).filter((f) => !f.harness);
}

export function applyVerification(state: WorkflowState, v: VerificationParams, opts: VerificationOptions = {}): VerifyOutcome {
	const countFrom = opts.countFrom ?? 0;
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
			retry_count: countedFailures(state, countFrom).length,
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

	// Every failing required gate could not run at all (program missing in the gate shell): the
	// environment or the gate definition is broken, not the change. Never counts toward the cap.
	const required = new Set(requiredGateCommands(state).map((c) => c.trim()));
	const failingRequired = state.lastGates.filter((g) => g.exit_code !== 0 && required.has(g.command.trim()));
	if (failingRequired.length > 0 && failingRequired.every((g) => g.runnable === false)) {
		const failure: FailureRecord = {
			attempt_number: countedFailures(state, countFrom).length + 1,
			failure_class: v.failure_class,
			destination: "supervise",
			summary: failureSummary,
			harness: true,
		};
		const next = transition({ ...state, failures: [...state.failures, failure] }, "supervise");
		return { kind: "retry", state: next, failure };
	}

	const counted = countedFailures(state, countFrom);
	const attempt_number = counted.length + 1;
	const destination: "supervise" | "analyze" = v.failure_class === "wrong_root_cause" ? "analyze" : "supervise";
	const failure: FailureRecord = {
		attempt_number,
		failure_class: v.failure_class,
		destination,
		summary: failureSummary,
	};

	const priorEscalated = counted.some((f) => f.escalation_answer !== undefined);

	if (priorEscalated) {
		// Attempt >= 3: stop, do not route further.
		const stopped = { ...state, failures: [...state.failures, failure] };
		const finalState = transition(stopped, "stopped");
		const finalState2 = { ...finalState, stopReason: "Verify failed again after an escalation; stopping for the user.", stoppedFrom: "verify" as Phase };
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

/** Repo-relative paths named in a unified diff's `diff --git` headers, first `max` of them. */
function changedFiles(diff: string, max: number): string[] {
	const files: string[] = [];
	for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)) {
		if (!files.includes(m[1])) files.push(m[1]);
	}
	return files.length > max ? [...files.slice(0, max), `+${files.length - max} more`] : files;
}

/**
 * Compact recap of a finished (done or stopped) run, carried into a follow-up `/change` run in the
 * same session so the model does not start from zero: task, kind, findings, proposed change, the
 * delivery report or stop reason, and the files changed when known.
 */
export function buildPreviousRunSummary(state: WorkflowState): string {
	const lines: string[] = [`Task: ${truncate(state.task, 200)}`];
	lines.push(`Outcome: ${state.phase === "done" ? "done" : `stopped${state.stopReason ? ` (${truncate(state.stopReason, 200)})` : ""}`}`);
	if (state.analysis) {
		lines.push(`Kind: ${state.analysis.kind}`);
		lines.push(`Findings: ${truncate(state.analysis.findings, 600)}`);
		if (state.analysis.proposed_change.trim()) lines.push(`Proposed change: ${truncate(state.analysis.proposed_change, 400)}`);
	}
	if (state.delivery) lines.push(`Delivery report: ${truncate(state.delivery.report, 600)}`);
	else if (state.phase === "stopped" && state.stopReason) lines.push(`Stop reason: ${truncate(state.stopReason, 600)}`);
	const files = state.review ? changedFiles(state.review.merged_diff, 15) : [];
	if (files.length > 0) lines.push(`Files changed: ${files.join(", ")}`);
	return lines.join("\n");
}

export function summarizeState(state: WorkflowState): string {
	const lines: string[] = [];
	lines.push(`# Prior state for "${state.task}"`);
	lines.push(`Phase: ${state.phase}`);
	if (state.previousRun) {
		lines.push(`Previous run in this session: ${truncate(state.previousRun.split("\n")[0], 160)}`);
	}

	if (state.analysis) {
		lines.push("");
		lines.push("## Analysis");
		lines.push(`- kind: ${state.analysis.kind}`);
		lines.push(`- findings: ${truncate(state.analysis.findings, 600)}`);
		lines.push(`- proposed_change: ${truncate(state.analysis.proposed_change, 400) || "(none)"}`);
		lines.push(`- out_of_scope: ${truncate(state.analysis.out_of_scope, 200)}`);
		lines.push(`- evidence: ${truncate(state.analysis.evidence, 200)}`);
		if (state.analysis.options?.length) {
			const { options, recommendation, chosen_option } = state.analysis;
			lines.push(`- options: ${options.map((o) => o.id).join(", ")}${recommendation ? ` (recommended: ${recommendation})` : ""}${chosen_option ? ` (chosen: ${chosen_option})` : ""}`);
		}
		if (state.analysis.open_questions.length > 0) {
			lines.push(`- open_questions: ${state.analysis.open_questions.join("; ")}`);
		}
	}

	if (state.plan) {
		lines.push("");
		lines.push("## Plan");
		for (const t of state.plan.tasks) {
			lines.push(
				`- ${t.id} [${t.executor_tier}/${t.workspace}] deps=${t.dependencies.join(",") || "none"}${t.paths?.length ? ` paths=${t.paths.join(",")}` : ""}${t.requires_main_tree ? " requires_main_tree" : ""}`,
			);
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

	if (state.gateAmendments && state.gateAmendments.length > 0) {
		lines.push("");
		lines.push("## Gate amendments (approved by the user)");
		lines.push(...formatGateAmendments(state.gateAmendments).map((l) => `- ${l}`));
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
