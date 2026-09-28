import { describe, expect, it } from "vitest";
import { newState, type WorkflowState } from "../extensions/code-changes/state.ts";
import { PHASE_REFERENCE, phasePrompt, phaseReminder, readReference, SKILL_DIR } from "../extensions/code-changes/prompts.ts";

function stateInPhase(phase: WorkflowState["phase"], overrides: Partial<WorkflowState> = {}): WorkflowState {
	const s = newState("fix the thing", ["read", "edit", "bash"], "deadbeef", false);
	return { ...s, phase, ...overrides };
}

describe("SKILL_DIR", () => {
	it("resolves to the bundled skill directory", () => {
		expect(SKILL_DIR.replace(/\\/g, "/")).toMatch(/skills\/code-changes$/);
	});
});

describe("readReference", () => {
	it("reads an existing reference file", () => {
		const text = readReference("artifacts");
		expect(text).toContain("Artifact contract between phases");
	});

	it("is cached across calls", () => {
		expect(readReference("plan")).toBe(readReference("plan"));
	});

	it("returns a warning comment for a missing reference file", () => {
		const text = readReference("does-not-exist");
		expect(text).toContain("not found");
	});
});

describe("PHASE_REFERENCE", () => {
	it("maps each model-driven phase to its reference files", () => {
		expect(PHASE_REFERENCE.analyze).toEqual(["analyze", "escalate"]);
		expect(PHASE_REFERENCE.plan).toEqual(["plan"]);
		expect(PHASE_REFERENCE.delegate).toEqual(["delegate"]);
		expect(PHASE_REFERENCE.supervise).toEqual(["supervise", "escalate"]);
		expect(PHASE_REFERENCE.verify).toEqual(["verify", "escalate"]);
		expect(PHASE_REFERENCE.deliver).toEqual(["deliver"]);
	});
});

describe("phasePrompt", () => {
	it("includes the phase header, task, references, artifacts, state summary, tools, and exit instruction", () => {
		const state = stateInPhase("analyze");
		const text = phasePrompt(state);
		expect(text).toContain(`[code-changes] Phase: Analyze (run ${state.id})`);
		expect(text).toContain(state.task);
		expect(text).toContain("Reference: analyze.md");
		expect(text).toContain("Reference: escalate.md");
		expect(text).toContain("Artifact contract between phases");
		expect(text).toContain("Prior state");
		expect(text).toContain("submit_analysis");
		expect(text).toContain("This phase ends only when you call `submit_analysis`.");
		expect(text).toContain("Edit and write are blocked");
	});

	it("includes the additional context extra when provided", () => {
		const state = stateInPhase("analyze");
		const text = phasePrompt(state, "the human wants more detail on X");
		expect(text).toContain("Additional context");
		expect(text).toContain("the human wants more detail on X");
	});

	it("mentions run_delegation for the delegate phase", () => {
		const text = phasePrompt(stateInPhase("delegate"));
		expect(text).toContain("Call run_delegation now");
	});

	it("lists required gate commands and the latest failure for verify", () => {
		const state = stateInPhase("verify", {
			plan: {
				tasks: [
					{ id: "t1", spec: "s", verification_commands: ["npm test"], executor_tier: "implementer", workspace: "main", dependencies: [] },
				],
			},
			failures: [{ attempt_number: 1, failure_class: "gate_failure", destination: "supervise", summary: "tests failed" }],
		});
		const text = phasePrompt(state);
		expect(text).toContain("npm test");
		expect(text).toContain("run_gates");
		expect(text).toContain("tests failed");
	});

	it("mentions conventional commits for deliver", () => {
		const text = phasePrompt(stateInPhase("deliver"));
		expect(text).toContain("conventional commits");
		expect(text).toContain("submit_delivery");
	});
});

describe("phaseReminder", () => {
	it("is short and mentions phase, tools, and the exit tool", () => {
		const state = stateInPhase("plan");
		const text = phaseReminder(state);
		expect(text.split("\n").length).toBeLessThanOrEqual(6);
		expect(text).toContain("Plan");
		expect(text).toContain("submit_plan");
	});

	it("points at the human gate while awaiting approval", () => {
		const text = phaseReminder(stateInPhase("awaiting_approval"));
		expect(text).toContain("/change approve");
	});
});
