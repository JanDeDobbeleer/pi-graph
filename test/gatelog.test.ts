import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	adviceFollowed,
	appendDecisionLog,
	buildDecisionRecord,
	fingerprint,
	gateChoices,
	gateRound,
	withDecisionRecorded,
	type GateAdvice,
} from "../extensions/code-changes/gatelog.ts";
import { defaultGateLogPath, loadGateLogPath } from "../extensions/code-changes/models.ts";
import { newState, type AnalysisReport, type TaskList, type WorkflowState } from "../extensions/code-changes/state.ts";

const analysis: AnalysisReport = {
	kind: "bug",
	findings: "greeting.txt says Hello",
	proposed_change: "say Hi",
	out_of_scope: "nothing",
	evidence: "read the file",
	open_questions: [],
};

const plan: TaskList = {
	tasks: [{ id: "t1", spec: "Change it", verification_commands: ["true"], executor_tier: "coordinator-direct", workspace: "main", dependencies: [] }],
};

function atGate(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return { ...newState("fix the greeting", [], undefined), phase: "awaiting_approval", analysis, ...overrides };
}

function advice(overrides: Partial<GateAdvice> = {}): GateAdvice {
	return { provider: "jev", decision: "approve", confidence: 0.9, latencyMs: 12, fingerprint: fingerprint(analysis), ...overrides };
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gatelog-"));
	dirs.push(d);
	return d;
}

describe("gateChoices", () => {
	it("maps every analysis gate label to a decision, options first", () => {
		const withOptions: AnalysisReport = {
			...analysis,
			options: [
				{ id: "a", title: "Small fix", summary: "s", tradeoffs: "t" },
				{ id: "b", title: "Rewrite", summary: "s", tradeoffs: "t" },
			],
			recommendation: "a",
		};
		const choices = gateChoices("analysis", { analysis: withOptions });
		expect(choices.map((c) => c.decision)).toEqual(["choose_option", "choose_option", "approve", "approve_push", "edit", "revise", "done", "stop"]);
		expect(choices[0].optionId).toBe("a");
		expect(choices[1].optionId).toBe("b");
	});

	it("maps the plan gate labels", () => {
		expect(gateChoices("plan", {}).map((c) => c.decision)).toEqual(["approve", "edit", "revise", "stop"]);
	});
});

describe("fingerprint", () => {
	it("ignores key order and undefined fields", () => {
		expect(fingerprint({ a: 1, b: [1, { c: 2 }] })).toBe(fingerprint({ b: [1, { c: 2 }], a: 1, d: undefined }));
		expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
	});
});

describe("buildDecisionRecord", () => {
	it("captures the artifact the human saw, the round and the decision", () => {
		const record = buildDecisionRecord(atGate(), { gate: "analysis", decision: "revise", feedback: "  wrong file ", via: "dialog", cwd: "/repo", now: new Date(0) })!;
		expect(record).toMatchObject({
			version: 1,
			gate: "analysis",
			round: 1,
			decision: "revise",
			feedback: "wrong file",
			via: "dialog",
			kind: "bug",
			artifact: analysis,
			editedByHuman: false,
			openQuestions: 0,
			proposedChange: true,
			decidedAt: "1970-01-01T00:00:00.000Z",
		});
		expect(record.advice).toBeUndefined();
	});

	it("attaches advice computed for the same artifact and says whether it was followed", () => {
		const state = atGate({ gateAdvice: { gate: "analysis", advice: advice() } });
		const approved = buildDecisionRecord(state, { gate: "analysis", decision: "approve", via: "command", cwd: "/repo" })!;
		expect(approved.advice).toMatchObject({ decision: "approve", followed: true });
		const revised = buildDecisionRecord(state, { gate: "analysis", decision: "revise", via: "command", cwd: "/repo" })!;
		expect(revised.advice?.followed).toBe(false);
	});

	it("drops advice computed for a different artifact (e.g. before a human edit)", () => {
		const state = atGate({ gateAdvice: { gate: "analysis", advice: advice({ fingerprint: "stale" }) } });
		expect(buildDecisionRecord(state, { gate: "analysis", decision: "approve", via: "dialog", cwd: "/r" })!.advice).toBeUndefined();
	});

	it("records the plan gate with the plan as artifact and no analysis fields", () => {
		const record = buildDecisionRecord(atGate({ phase: "awaiting_plan_approval", plan, planEditedByHuman: true }), {
			gate: "plan",
			decision: "approve",
			via: "dialog",
			cwd: "/r",
		})!;
		expect(record.artifact).toBe(plan);
		expect(record.editedByHuman).toBe(true);
		expect(record.kind).toBeUndefined();
		expect(record.openQuestions).toBeUndefined();
	});

	it("returns undefined when the gate has no artifact", () => {
		expect(buildDecisionRecord(atGate(), { gate: "plan", decision: "approve", via: "dialog", cwd: "/r" })).toBeUndefined();
	});
});

describe("withDecisionRecorded / gateRound", () => {
	it("appends history, counts rounds per gate and clears cached advice", () => {
		let state = atGate({ gateAdvice: { gate: "analysis", advice: advice() } });
		const first = buildDecisionRecord(state, { gate: "analysis", decision: "revise", via: "dialog", cwd: "/r" })!;
		state = withDecisionRecorded(state, first);
		expect(state.gateAdvice).toBeUndefined();
		expect(gateRound(state.gateHistory, "analysis")).toBe(2);
		expect(gateRound(state.gateHistory, "plan")).toBe(1);
		const second = buildDecisionRecord(state, { gate: "analysis", decision: "approve", via: "dialog", cwd: "/r" })!;
		expect(second.round).toBe(2);
	});
});

describe("adviceFollowed", () => {
	it("requires the same option for choose_option", () => {
		expect(adviceFollowed({ decision: "choose_option", optionId: "a" }, "choose_option", "a")).toBe(true);
		expect(adviceFollowed({ decision: "choose_option", optionId: "a" }, "choose_option", "b")).toBe(false);
		expect(adviceFollowed({ decision: "approve" }, "approve")).toBe(true);
	});
});

describe("appendDecisionLog", () => {
	it("appends one JSON line per record, creating the directory", () => {
		const file = path.join(tmp(), "nested", "log.jsonl");
		const record = buildDecisionRecord(atGate(), { gate: "analysis", decision: "approve", via: "dialog", cwd: "/r" })!;
		expect(appendDecisionLog(file, record)).toBeUndefined();
		expect(appendDecisionLog(file, record)).toBeUndefined();
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).decision).toBe("approve");
	});

	it("reports an error instead of throwing", () => {
		const dir = tmp();
		const blocker = path.join(dir, "file");
		fs.writeFileSync(blocker, "");
		const record = buildDecisionRecord(atGate(), { gate: "analysis", decision: "approve", via: "dialog", cwd: "/r" })!;
		expect(appendDecisionLog(path.join(blocker, "log.jsonl"), record)).toBeTypeOf("string");
	});
});

describe("loadGateLogPath", () => {
	it("defaults to the user agent dir, lets the project override, and false turns it off", () => {
		const home = tmp();
		const cwd = tmp();
		expect(loadGateLogPath(cwd, home)).toBe(defaultGateLogPath(home));

		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(home, ".pi", "agent", "code-changes.json"), JSON.stringify({ gateLog: "logs/gates.jsonl" }));
		expect(loadGateLogPath(cwd, home)).toBe(path.join(home, "logs", "gates.jsonl"));

		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "code-changes.json"), JSON.stringify({ gateLog: false }));
		expect(loadGateLogPath(cwd, home)).toBeUndefined();
	});
});
