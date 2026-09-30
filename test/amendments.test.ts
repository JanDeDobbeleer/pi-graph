import { describe, expect, it } from "vitest";
import {
	applyGateAmendment,
	applyVerification,
	ArtifactError,
	buildPreviousRunSummary,
	requiredGateCommands,
	resumeTargetFor,
	summarizeState,
} from "../extensions/code-changes/artifacts.ts";
import { phasePrompt } from "../extensions/code-changes/prompts.ts";
import { newState, type GateResult, type PlanTask, type WorkflowState } from "../extensions/code-changes/state.ts";

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return { ...newState("do the thing", ["read", "edit", "bash"], "deadbeef"), ...overrides };
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
	return {
		id: "t1",
		spec: "do the work",
		verification_commands: ["npm test"],
		executor_tier: "implementer",
		workspace: "main",
		dependencies: [],
		paths: ["src/t1/"],
		...overrides,
	};
}

function gate(command: string, exit_code: number): GateResult {
	return { command, exit_code, output: "", duration_ms: 1 };
}

function notRunnable(command: string): GateResult {
	return { command, exit_code: 1, runnable: false, output: "'grep' is not recognized as an internal or external command", duration_ms: 1 };
}

const amendment = (old: string, replacement?: string) => ({ old, new: replacement, reason: "r", phase: "verify" as const, approved_at: "2026-01-01T00:00:00Z" });

describe("requiredGateCommands with amendments", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test", "grep -c x dist/a.js || true"] })] };

	it("replaces a gate in place", () => {
		const s = baseState({ plan, gateAmendments: [amendment("grep -c x dist/a.js || true", "node scripts/check.mjs")] });
		expect(requiredGateCommands(s)).toEqual(["npm test", "node scripts/check.mjs"]);
	});

	it("removes a gate when the amendment has no replacement", () => {
		const s = baseState({ plan, gateAmendments: [amendment("npm test")] });
		expect(requiredGateCommands(s)).toEqual(["grep -c x dist/a.js || true"]);
	});

	it("applies amendments in order and ignores ones whose gate is gone", () => {
		const s = baseState({ plan, gateAmendments: [amendment("npm test", "npm run t"), amendment("npm run t", "npm run t2"), amendment("nothing", "x")] });
		expect(requiredGateCommands(s)).toEqual(["npm run t2", "grep -c x dist/a.js || true"]);
	});

	it("does not duplicate a gate the replacement already matches", () => {
		const s = baseState({ plan, gateAmendments: [amendment("grep -c x dist/a.js || true", "npm test")] });
		expect(requiredGateCommands(s)).toEqual(["npm test"]);
	});
});

describe("applyGateAmendment", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test", "grep x y"] })] };

	it("records the amendment and drops the stale result of the amended gate", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0), notRunnable("grep x y")] });
		const next = applyGateAmendment(s, { gate: "grep x y", replacement: "node check.mjs", reason: "grep is missing in cmd" }, "2026-01-01T00:00:00Z");
		expect(next.gateAmendments).toEqual([
			{ old: "grep x y", new: "node check.mjs", reason: "grep is missing in cmd", phase: "verify", approved_at: "2026-01-01T00:00:00Z" },
		]);
		expect(next.lastGates.map((g) => g.command)).toEqual(["npm test"]);
		expect(requiredGateCommands(next)).toEqual(["npm test", "node check.mjs"]);
	});

	it("rejects a gate that is not required, an empty reason, and a no-op replacement", () => {
		const s = baseState({ phase: "verify", plan });
		expect(() => applyGateAmendment(s, { gate: "nope", reason: "r" }, "t")).toThrow(/not a required gate/);
		expect(() => applyGateAmendment(s, { gate: "npm test", reason: " " }, "t")).toThrow(/reason/);
		expect(() => applyGateAmendment(s, { gate: "npm test", replacement: "npm test", reason: "r" }, "t")).toThrow(/identical/);
		expect(() => applyGateAmendment(baseState({ phase: "plan", plan }), { gate: "npm test", reason: "r" }, "t")).toThrow(/Supervise or Verify/);
	});

	it("lets Verify pass once the amended gate is green", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0), notRunnable("grep x y")] });
		const amended = applyGateAmendment(s, { gate: "grep x y", replacement: "node check.mjs", reason: "r" }, "t");
		const withRun = { ...amended, lastGates: [...amended.lastGates, gate("node check.mjs", 0)] };
		expect(applyVerification(withRun, { outcome: "pass", functional_proof: "ok" }).kind).toBe("deliver");
	});
});

describe("applyVerification - not runnable gates", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test", "grep x y"] })] };

	it("rejects a pass whose required gate is not runnable", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0), { ...gate("grep x y", 0), runnable: false }] });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "ok" })).toThrow(ArtifactError);
	});

	it("records a harness failure that does not count toward the retry cap and routes to supervise", () => {
		let s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0), notRunnable("grep x y")] });
		for (let i = 0; i < 4; i++) {
			const outcome = applyVerification(s, { outcome: "fail", failure_class: "wrong_root_cause", failure_summary: "grep is not recognized", functional_proof: "" });
			expect(outcome.kind).toBe("retry");
			if (outcome.kind !== "retry") return;
			expect(outcome.failure.harness).toBe(true);
			expect(outcome.state.phase).toBe("supervise");
			s = { ...outcome.state, phase: "verify" };
		}
		// A real failure afterwards is still attempt 1.
		const real = applyVerification({ ...s, lastGates: [gate("npm test", 1), gate("grep x y", 0)] }, { outcome: "fail", failure_class: "gate_failure", failure_summary: "tests fail", functional_proof: "" });
		expect(real.kind).toBe("retry");
		if (real.kind === "retry") {
			expect(real.failure.attempt_number).toBe(1);
			expect(real.failure.harness).toBeUndefined();
		}
	});

	it("is a normal failure when a runnable gate also fails", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 1), notRunnable("grep x y")] });
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "x", functional_proof: "" });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind === "retry") expect(outcome.failure.harness).toBeUndefined();
	});
});

describe("applyVerification - stop and resume", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test"] })] };
	const failures = [
		{ attempt_number: 1, failure_class: "gate_failure" as const, destination: "supervise" as const, summary: "first failure" },
		{ attempt_number: 2, failure_class: "gate_failure" as const, destination: "supervise" as const, summary: "second failure", escalation_answer: "try B" },
	];

	it("records where the run stopped", () => {
		const outcome = applyVerification(baseState({ phase: "verify", plan, failures }), { outcome: "fail", failure_class: "gate_failure", failure_summary: "again", functional_proof: "" });
		expect(outcome.kind).toBe("stop");
		if (outcome.kind === "stop") expect(outcome.state.stoppedFrom).toBe("verify");
	});

	it("restarts the retry count after a resume (countFrom)", () => {
		const s = baseState({ phase: "verify", plan, failures: [...failures, { attempt_number: 3, failure_class: "gate_failure", destination: "supervise", summary: "third" }] });
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "after resume", functional_proof: "" }, { countFrom: 3 });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind === "retry") expect(outcome.failure.attempt_number).toBe(1);
		// A second failure after the resume escalates again instead of stopping.
		const again = applyVerification(
			{ ...s, failures: [...s.failures, { attempt_number: 1, failure_class: "gate_failure", destination: "supervise", summary: "after resume" }] },
			{ outcome: "fail", failure_class: "gate_failure", failure_summary: "still", functional_proof: "" },
			{ countFrom: 3 },
		);
		expect(again.kind).toBe("escalate");
	});

	it("resumeTargetFor maps stop points onto reopenable phases", () => {
		expect(resumeTargetFor("verify")).toBe("verify");
		expect(resumeTargetFor("awaiting_approval")).toBe("analyze");
		expect(resumeTargetFor("awaiting_plan_approval")).toBe("plan");
		expect(resumeTargetFor("ci")).toBeUndefined();
	});
});

describe("buildPreviousRunSummary", () => {
	it("recaps a finished run compactly", () => {
		const s = baseState({
			phase: "done",
			task: "fix the greeting",
			analysis: { kind: "bug", findings: "F".repeat(900), proposed_change: "change it", out_of_scope: "", evidence: "", open_questions: [] },
			review: { merged_diff: "diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/README.md b/README.md\n+y", overrides: [], tests_kept: [], tests_cut: [] },
			delivery: { commits: ["fix: greeting"], report: "Changed the greeting." },
		});
		const text = buildPreviousRunSummary(s);
		expect(text).toContain("Task: fix the greeting");
		expect(text).toContain("Kind: bug");
		expect(text).toContain("Delivery report: Changed the greeting.");
		expect(text).toContain("Files changed: src/a.ts, README.md");
		expect(text.length).toBeLessThan(1500);
	});

	it("uses the stop reason for a stopped run and is mentioned by summarizeState", () => {
		const stopped = baseState({ phase: "stopped", stopReason: "Verify failed again" });
		expect(buildPreviousRunSummary(stopped)).toContain("Stop reason: Verify failed again");
		const next = baseState({ previousRun: buildPreviousRunSummary(stopped) });
		expect(summarizeState(next)).toContain("Previous run in this session: Task: do the thing");
	});
});

describe("previous run, gate shell and amend_gate guidance in prompts", () => {
	it("adds a previous-run section to the Analyze prompt only when one is carried", () => {
		const withPrev = phasePrompt(baseState({ phase: "analyze", previousRun: "Task: earlier thing\nOutcome: done" }));
		expect(withPrev).toContain("## Previous run in this session");
		expect(withPrev).toContain("Task: earlier thing");
		expect(phasePrompt(baseState({ phase: "analyze" }))).not.toContain("Previous run in this session");
		expect(phasePrompt(baseState({ phase: "plan", previousRun: "Task: earlier thing" }))).not.toContain("## Previous run in this session");
	});

	it("tells the planner that gates run in the bash-tool shell and are checked at submit", () => {
		const text = phasePrompt(baseState({ phase: "plan" }));
		expect(text).toMatch(/Verification commands run in .*same shell as your bash tool/);
		expect(text).toContain("checks that the programs they invoke exist");
	});

	it("mentions amend_gate for not-runnable gates in Verify and lists amendments in Deliver", () => {
		const verify = phasePrompt(baseState({ phase: "verify" }));
		expect(verify).toContain("NOT RUNNABLE");
		expect(verify).toContain("amend_gate");
		const deliver = phasePrompt(baseState({ phase: "deliver", gateAmendments: [amendment("grep x", "node c.mjs")] }));
		expect(deliver).toContain("`grep x` → `node c.mjs`");
	});
});
