/**
 * Gate advisor: asks TypeSafe's Jev (a System One model -- typed decisions with probabilities, no
 * text generation) which action the human is likely to take at an approval gate, and turns the
 * answer into a suggestion shown in the gate dialog. The human still decides; the suggestion and
 * the decision are both written to the gate-decision log (gatelog.ts) so its accuracy can be
 * measured before it is ever trusted to skip a gate.
 *
 * Off unless configured (`gateAdvisor` in code-changes.json) and the API key is in the
 * environment. Any error or timeout yields no suggestion; it never blocks a gate.
 *
 * Wire format (POST /v1/systemone): { model, state, questions: { <name>: { type: "choice",
 * instructions, criteria: { <key>: <description> } } } } -> { model, answers: { <name>: { type:
 * "choice", choice, confidence, probabilities } } }. Parsed defensively: a response that does not
 * name one of the offered keys is dropped.
 */

import { formatAnalysis, formatPlan } from "./artifacts.ts";
import { type GateAdvice, type GateChoice, type GateKind, fingerprint, gateArtifact, gateChoices, gateRound } from "./gatelog.ts";
import type { WorkflowState } from "./state.ts";

export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_KEY_ENV = "TYPESAFE_API_KEY";
export const DEFAULT_ADVISOR_TIMEOUT_MS = 4000;
/** Jev's context is 64k tokens with ~32k for state + longest question; stay well inside it. */
export const MAX_STATE_CHARS = 60_000;

export interface GateAdvisorConfig {
	provider: "jev";
	endpoint: string;
	model: string;
	apiKeyEnv: string;
	timeoutMs: number;
	gates: GateKind[];
}

export type GateAdvisorSetup = { config: GateAdvisorConfig; apiKey: string } | { config: undefined; reason?: string };

/**
 * Validate the raw `gateAdvisor` block. Absent (or `enabled: false`) means off with no reason;
 * a present but unusable block (unknown provider, missing key) is off with a reason to warn about.
 */
export function resolveGateAdvisor(raw: unknown, env: Record<string, string | undefined>): GateAdvisorSetup {
	if (raw === undefined || raw === null || raw === false) return { config: undefined };
	if (typeof raw !== "object") return { config: undefined, reason: "gateAdvisor must be an object." };
	const r = raw as Record<string, unknown>;
	if (r.enabled === false) return { config: undefined };
	if (r.provider !== "jev") return { config: undefined, reason: `gateAdvisor.provider must be "jev" (got ${JSON.stringify(r.provider)}).` };
	const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
	const timeout = typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs >= 250 && r.timeoutMs <= 30_000 ? r.timeoutMs : DEFAULT_ADVISOR_TIMEOUT_MS;
	const gates = Array.isArray(r.gates) ? r.gates.filter((g): g is GateKind => g === "analysis" || g === "plan") : ["analysis", "plan"];
	const config: GateAdvisorConfig = {
		provider: "jev",
		endpoint: str(r.endpoint, JEV_DEFAULT_ENDPOINT),
		model: str(r.model, JEV_DEFAULT_MODEL),
		apiKeyEnv: str(r.apiKeyEnv, JEV_DEFAULT_KEY_ENV),
		timeoutMs: timeout,
		gates: gates as GateKind[],
	};
	const apiKey = env[config.apiKeyEnv]?.trim();
	if (!apiKey) return { config: undefined, reason: `gateAdvisor is configured but ${config.apiKeyEnv} is not set; no gate suggestions.` };
	return { config, apiKey };
}

/** A choice the advisor may suggest, with the key it is offered under. */
export interface OfferedChoice extends GateChoice {
	key: string;
	description: string;
}

/**
 * The choices an advisor may suggest. Never "approve and allow push/PR" (an outward-facing
 * permission, not a judgment about the artifact); never approve/choose while the analysis still
 * has open questions; never "edit" without a UI to edit in.
 */
export function offeredChoices(gate: GateKind, state: Pick<WorkflowState, "analysis">, opts: { hasUI: boolean }): OfferedChoice[] {
	const openQuestions = gate === "analysis" && (state.analysis?.open_questions.length ?? 0) > 0;
	const offered: OfferedChoice[] = [];
	let optionIndex = 0;
	for (const c of gateChoices(gate, state)) {
		if (c.decision === "approve_push") continue;
		if (c.decision === "edit" && !opts.hasUI) continue;
		if (openQuestions && (c.decision === "approve" || c.decision === "choose_option")) continue;
		if (c.decision === "choose_option") {
			optionIndex++;
			const option = state.analysis?.options?.find((o) => o.id === c.optionId);
			offered.push({ ...c, key: `option_${optionIndex}`, description: `Pick option "${c.optionId}" (${option?.title ?? ""}) and plan it: ${option?.summary ?? ""}`.trim() });
			continue;
		}
		offered.push({ ...c, key: c.decision, description: describe(gate, c.decision) });
	}
	return offered;
}

function describe(gate: GateKind, decision: GateChoice["decision"]): string {
	const what = gate === "analysis" ? "analysis" : "plan";
	switch (decision) {
		case "approve":
			return gate === "analysis"
				? "The analysis is right and complete as written: approve it and plan the proposed change."
				: "The plan is right as written: approve it and start running the tasks.";
		case "edit":
			return `The ${what} is mostly right; the developer fixes details in the text themselves before approving.`;
		case "revise":
			return `Something in the ${what} is wrong or missing (${gate === "analysis" ? "root cause, scope, evidence" : "tasks, scope, verification commands"}): send it back to the agent with feedback.`;
		case "done":
			return "The analysis itself answers the request; nothing should be implemented.";
		case "stop":
			return "The run should not continue at all.";
		default:
			return decision;
	}
}

/** The text Jev judges: what the gate is, the run so far, and the artifact exactly as the human sees it. */
export function buildAdvisorState(gate: GateKind, state: WorkflowState): string {
	const round = gateRound(state.gateHistory, gate);
	const lines: string[] = [];
	if (gate === "analysis") {
		lines.push(`Human approval gate: a developer reviews a ${state.analysis?.kind ?? ""} analysis written by a coding agent before any code is changed.`);
	} else {
		lines.push("Human approval gate: a developer reviews the implementation plan written by a coding agent (after approving its analysis) before the tasks run.");
	}
	lines.push(`Request: ${state.task}`);
	lines.push(`Review round at this gate: ${round}${round > 1 ? " (earlier rounds were sent back)" : ""}.`);
	const history = (state.gateHistory ?? []).map((h) => `${h.gate}: ${h.decision}${h.optionId ? ` (${h.optionId})` : ""}`);
	if (history.length > 0) lines.push(`Earlier decisions in this run: ${history.join("; ")}.`);
	lines.push("");
	if (gate === "analysis" && state.analysis) lines.push(formatAnalysis(state.analysis, { edited: state.analysisEditedByHuman }));
	if (gate === "plan" && state.plan) lines.push(formatPlan(state.plan, { edited: state.planEditedByHuman }));
	const text = lines.join("\n");
	return text.length > MAX_STATE_CHARS ? `${text.slice(0, MAX_STATE_CHARS)}\n[truncated]` : text;
}

export const QUESTION_NAME = "decision";

export function buildJevRequest(config: GateAdvisorConfig, gate: GateKind, state: WorkflowState, offered: OfferedChoice[]): Record<string, unknown> {
	const criteria: Record<string, string> = {};
	for (const c of offered) criteria[c.key] = c.description;
	return {
		model: config.model,
		state: buildAdvisorState(gate, state),
		questions: {
			[QUESTION_NAME]: {
				type: "choice",
				instructions: `Which action will the developer take at this ${gate} approval gate?`,
				criteria,
			},
		},
	};
}

/** Map a Jev response onto one of the offered choices, or undefined when it does not name one. */
export function parseJevResponse(
	body: unknown,
	offered: OfferedChoice[],
	meta: { fingerprint: string; latencyMs: number },
): GateAdvice | undefined {
	if (!body || typeof body !== "object") return undefined;
	const answers = (body as { answers?: unknown }).answers;
	if (!answers || typeof answers !== "object") return undefined;
	const answer = (answers as Record<string, unknown>)[QUESTION_NAME] as { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
	if (!answer || typeof answer.choice !== "string") return undefined;
	const picked = offered.find((c) => c.key === answer.choice);
	if (!picked) return undefined;

	let probabilities: Record<string, number> | undefined;
	if (answer.probabilities && typeof answer.probabilities === "object") {
		probabilities = {};
		for (const c of offered) {
			const p = (answer.probabilities as Record<string, unknown>)[c.key];
			if (typeof p === "number" && Number.isFinite(p)) probabilities[adviceKey(c)] = p;
		}
	}
	const reported = typeof answer.confidence === "number" && Number.isFinite(answer.confidence) ? answer.confidence : probabilities?.[adviceKey(picked)];
	if (reported === undefined) return undefined;
	const model = (body as { model?: unknown }).model;
	return {
		provider: "jev",
		model: typeof model === "string" ? model : undefined,
		decision: picked.decision,
		optionId: picked.optionId,
		confidence: Math.min(1, Math.max(0, reported)),
		probabilities,
		latencyMs: meta.latencyMs,
		fingerprint: meta.fingerprint,
	};
}

function adviceKey(c: Pick<GateChoice, "decision" | "optionId">): string {
	return c.decision === "choose_option" ? `choose_option:${c.optionId}` : c.decision;
}

export interface AskDeps {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	now?: () => number;
}

export type AdviceResult = { advice: GateAdvice } | { advice: undefined; reason: string };

/** One Jev call for the open gate. Never throws: failures come back as a reason (logged, not shown as an error). */
export async function askGateAdvisor(
	setup: { config: GateAdvisorConfig; apiKey: string },
	gate: GateKind,
	state: WorkflowState,
	opts: { hasUI: boolean },
	deps: AskDeps = {},
): Promise<AdviceResult> {
	const { config, apiKey } = setup;
	if (!config.gates.includes(gate)) return { advice: undefined, reason: `not enabled for the ${gate} gate` };
	const artifact = gateArtifact(gate, state);
	if (!artifact) return { advice: undefined, reason: "no artifact" };
	const offered = offeredChoices(gate, state, opts);
	if (offered.length < 2) return { advice: undefined, reason: "fewer than two choices to suggest between" };

	const doFetch = deps.fetch ?? fetch;
	const now = deps.now ?? Date.now;
	const timeout = AbortSignal.timeout(config.timeoutMs);
	const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
	const started = now();
	try {
		const res = await doFetch(config.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(buildJevRequest(config, gate, state, offered)),
			signal,
		});
		if (!res.ok) return { advice: undefined, reason: `HTTP ${res.status}` };
		const body = await res.json();
		const advice = parseJevResponse(body, offered, { fingerprint: fingerprint(artifact), latencyMs: now() - started });
		return advice ? { advice } : { advice: undefined, reason: "response did not name an offered choice" };
	} catch (err) {
		return { advice: undefined, reason: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function adviceNote(advice: GateAdvice): string {
	return `suggested by ${advice.provider === "jev" ? "Jev" : advice.provider} (${Math.round(advice.confidence * 100)}%)`;
}

/**
 * Dialog labels with the suggestion moved to the top and marked, plus a resolver back to the
 * original label so the gate code keeps matching on its own strings. Without advice (or advice
 * that no longer matches a choice) the labels come back unchanged.
 */
export function withSuggestion(labels: string[], choices: GateChoice[], advice: GateAdvice | undefined): { labels: string[]; resolve: (label: string | undefined) => string | undefined } {
	const identity = { labels, resolve: (l: string | undefined) => l };
	if (!advice) return identity;
	const suggested = choices.find((c) => c.decision === advice.decision && c.optionId === advice.optionId);
	if (!suggested || !labels.includes(suggested.label)) return identity;
	const marked = `${suggested.label}  ◂ ${adviceNote(advice)}`;
	return {
		labels: [marked, ...labels.filter((l) => l !== suggested.label)],
		resolve: (l) => (l === marked ? suggested.label : l),
	};
}

/** The slash command matching a suggestion, for gates shown without a UI. */
export function adviceCommand(advice: Pick<GateAdvice, "decision" | "optionId">): string {
	switch (advice.decision) {
		case "approve":
		case "approve_push":
			return "/change approve";
		case "choose_option":
			return `/change choose ${advice.optionId}`;
		case "revise":
			return "/change revise <feedback>";
		case "done":
			return "/change done";
		case "stop":
			return "/change abort";
		case "edit":
			return "/change show";
	}
}
