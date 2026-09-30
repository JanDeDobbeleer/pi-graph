import { describe, expect, it } from "vitest";
import {
	adviceCommand,
	askGateAdvisor,
	buildAdvisorState,
	buildJevRequest,
	DEFAULT_ADVISOR_TIMEOUT_MS,
	JEV_DEFAULT_ENDPOINT,
	offeredChoices,
	parseJevResponse,
	resolveGateAdvisor,
	withSuggestion,
	type GateAdvisorConfig,
} from "../extensions/code-changes/gateadvisor.ts";
import { fingerprint, gateChoices, PLAN_GATE_LABELS } from "../extensions/code-changes/gatelog.ts";
import { analysisGateChoices } from "../extensions/code-changes/artifacts.ts";
import { newState, type AnalysisReport, type TaskList, type WorkflowState } from "../extensions/code-changes/state.ts";

const analysis: AnalysisReport = {
	kind: "bug",
	findings: "greeting.txt says Hello",
	proposed_change: "say Hi",
	out_of_scope: "nothing",
	evidence: "read the file",
	open_questions: [],
	options: [
		{ id: "small", title: "Small fix", summary: "edit one line", tradeoffs: "none" },
		{ id: "big", title: "Rewrite", summary: "rewrite the module", tradeoffs: "risky" },
	],
	recommendation: "small",
};

const plan: TaskList = {
	tasks: [{ id: "t1", spec: "Change it", verification_commands: ["true"], executor_tier: "coordinator-direct", workspace: "main", dependencies: [] }],
};

function atGate(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return { ...newState("fix the greeting", [], undefined), phase: "awaiting_approval", analysis, ...overrides };
}

const config: GateAdvisorConfig = {
	provider: "jev",
	endpoint: JEV_DEFAULT_ENDPOINT,
	model: "jev-latest",
	apiKeyEnv: "TYPESAFE_API_KEY",
	timeoutMs: 1000,
	gates: ["analysis", "plan"],
};

describe("resolveGateAdvisor", () => {
	it("is off without a config block, silently", () => {
		expect(resolveGateAdvisor(undefined, {})).toEqual({ config: undefined });
		expect(resolveGateAdvisor({ provider: "jev", enabled: false }, { TYPESAFE_API_KEY: "k" })).toEqual({ config: undefined });
	});

	it("is off with a reason when the key or provider is wrong", () => {
		expect(resolveGateAdvisor({ provider: "jev" }, {}).config).toBeUndefined();
		expect((resolveGateAdvisor({ provider: "jev" }, {}) as { reason: string }).reason).toContain("TYPESAFE_API_KEY");
		expect((resolveGateAdvisor({ provider: "other" }, { TYPESAFE_API_KEY: "k" }) as { reason: string }).reason).toContain("provider");
	});

	it("fills defaults and honours overrides", () => {
		const setup = resolveGateAdvisor({ provider: "jev", apiKeyEnv: "MY_KEY", timeoutMs: 5, gates: ["plan", "bogus"] }, { MY_KEY: " secret " });
		expect(setup.config).toMatchObject({ endpoint: JEV_DEFAULT_ENDPOINT, model: "jev-latest", apiKeyEnv: "MY_KEY", timeoutMs: DEFAULT_ADVISOR_TIMEOUT_MS, gates: ["plan"] });
		expect((setup as { apiKey: string }).apiKey).toBe("secret");
	});
});

describe("offeredChoices", () => {
	it("never offers approve-and-push, and offers options under stable keys", () => {
		const offered = offeredChoices("analysis", atGate(), { hasUI: true });
		expect(offered.map((c) => c.key)).toEqual(["option_1", "option_2", "approve", "edit", "revise", "done", "stop"]);
		expect(offered[1]).toMatchObject({ decision: "choose_option", optionId: "big" });
	});

	it("drops approve/choose while questions are open, and edit without a UI", () => {
		const offered = offeredChoices("analysis", atGate({ analysis: { ...analysis, open_questions: ["which file?"] } }), { hasUI: false });
		expect(offered.map((c) => c.key)).toEqual(["revise", "done", "stop"]);
	});

	it("offers the plan gate choices", () => {
		expect(offeredChoices("plan", atGate(), { hasUI: true }).map((c) => c.key)).toEqual(["approve", "edit", "revise", "stop"]);
	});
});

describe("buildJevRequest", () => {
	it("sends the artifact as state and one choice question over the offered keys", () => {
		const state = atGate({ gateHistory: [{ gate: "analysis", decision: "revise" }] });
		const offered = offeredChoices("analysis", state, { hasUI: true });
		const body = buildJevRequest(config, "analysis", state, offered) as any;
		expect(body.model).toBe("jev-latest");
		expect(body.state).toContain("greeting.txt says Hello");
		expect(body.state).toContain("round at this gate: 2");
		expect(body.state).toContain("analysis: revise");
		expect(body.questions.decision.type).toBe("choice");
		expect(Object.keys(body.questions.decision.criteria)).toEqual(offered.map((c) => c.key));
	});

	it("truncates very large artifacts", () => {
		const huge = atGate({ analysis: { ...analysis, findings: "x".repeat(100_000) } });
		expect(buildAdvisorState("analysis", huge).length).toBeLessThan(61_000);
	});
});

describe("parseJevResponse", () => {
	const offered = offeredChoices("analysis", atGate(), { hasUI: true });
	const meta = { fingerprint: "fp", latencyMs: 40 };

	it("maps the chosen key back to a decision with confidence and probabilities", () => {
		const advice = parseJevResponse(
			{
				model: "jev-1.13.0",
				answers: { decision: { type: "choice", choice: "option_1", confidence: 0.93, probabilities: { option_1: 0.93, revise: 0.07 } } },
			},
			offered,
			meta,
		);
		expect(advice).toEqual({
			provider: "jev",
			model: "jev-1.13.0",
			decision: "choose_option",
			optionId: "small",
			confidence: 0.93,
			probabilities: { "choose_option:small": 0.93, revise: 0.07 },
			latencyMs: 40,
			fingerprint: "fp",
		});
	});

	it("falls back to the chosen key's probability when confidence is missing", () => {
		const advice = parseJevResponse({ answers: { decision: { choice: "revise", probabilities: { revise: 0.6 } } } }, offered, meta);
		expect(advice?.confidence).toBe(0.6);
	});

	it("rejects answers that are not one of the offered keys, or malformed", () => {
		expect(parseJevResponse({ answers: { decision: { choice: "approve_push", confidence: 1 } } }, offered, meta)).toBeUndefined();
		expect(parseJevResponse({ answers: {} }, offered, meta)).toBeUndefined();
		expect(parseJevResponse("nope", offered, meta)).toBeUndefined();
		expect(parseJevResponse({ answers: { decision: { choice: "revise" } } }, offered, meta)).toBeUndefined();
	});
});

describe("askGateAdvisor", () => {
	const setup = { config, apiKey: "secret" };

	it("posts to the endpoint with the bearer key and returns the advice", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response(JSON.stringify({ answers: { decision: { choice: "approve", confidence: 0.8 } } }), { status: 200 });
		}) as unknown as typeof fetch;
		let t = 100;
		const result = await askGateAdvisor(setup, "plan", atGate({ phase: "awaiting_plan_approval", plan }), { hasUI: true }, { fetch: fakeFetch, now: () => (t += 25) });
		expect(seen?.url).toBe(JEV_DEFAULT_ENDPOINT);
		expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
		expect(result.advice).toMatchObject({ decision: "approve", confidence: 0.8, latencyMs: 25, fingerprint: fingerprint(plan) });
	});

	it("never throws: HTTP errors and network failures come back as a reason", async () => {
		const status = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
		expect(await askGateAdvisor(setup, "analysis", atGate(), { hasUI: true }, { fetch: status })).toEqual({ advice: undefined, reason: "HTTP 429" });
		const boom = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await askGateAdvisor(setup, "analysis", atGate(), { hasUI: true }, { fetch: boom })).toEqual({ advice: undefined, reason: "ECONNREFUSED" });
	});

	it("skips gates it is not enabled for without calling out", async () => {
		const never = (async () => {
			throw new Error("should not be called");
		}) as unknown as typeof fetch;
		const result = await askGateAdvisor({ config: { ...config, gates: ["plan"] }, apiKey: "k" }, "analysis", atGate(), { hasUI: true }, { fetch: never });
		expect(result.advice).toBeUndefined();
	});
});

describe("withSuggestion", () => {
	const labels = analysisGateChoices(analysis);
	const choices = gateChoices("analysis", { analysis });
	const advice = { provider: "jev", decision: "revise" as const, confidence: 0.71, latencyMs: 1, fingerprint: "fp" };

	it("moves the suggested entry to the top, marks it, and resolves back to the original label", () => {
		const s = withSuggestion(labels, choices, advice);
		expect(s.labels[0]).toBe("Send feedback to revise  ◂ suggested by Jev (71%)");
		expect(s.labels).toHaveLength(labels.length);
		expect(s.resolve(s.labels[0])).toBe("Send feedback to revise");
		expect(s.resolve("Approve")).toBe("Approve");
		expect(s.resolve(undefined)).toBeUndefined();
	});

	it("finds the right option entry for choose_option", () => {
		const s = withSuggestion(labels, choices, { ...advice, decision: "choose_option", optionId: "big" });
		expect(s.resolve(s.labels[0])).toBe(labels.find((l) => l.includes("big")));
	});

	it("leaves the labels alone without advice", () => {
		expect(withSuggestion(PLAN_GATE_LABELS, gateChoices("plan", {}), undefined).labels).toBe(PLAN_GATE_LABELS);
	});
});

describe("adviceCommand", () => {
	it("names the slash command for a no-UI gate", () => {
		expect(adviceCommand({ decision: "approve" })).toBe("/change approve");
		expect(adviceCommand({ decision: "choose_option", optionId: "small" })).toBe("/change choose small");
		expect(adviceCommand({ decision: "stop" })).toBe("/change abort");
	});
});
