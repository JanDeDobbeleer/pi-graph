import { describe, expect, it } from "vitest";
import { decideToolCall, isReadOnlyCommand, PHASE_TOOLS, WORKFLOW_TOOLS } from "../extensions/code-changes/gates.ts";
import { newState, type WorkflowState } from "../extensions/code-changes/state.ts";

function stateInPhase(phase: WorkflowState["phase"]): WorkflowState {
	const s = newState("do a thing", ["read", "edit", "bash"], "deadbeef", false);
	return { ...s, phase };
}

describe("isReadOnlyCommand", () => {
	it.each([
		"git status",
		"git log | head",
		"rg foo",
		"ls 2>/dev/null",
		"git log --oneline 2>&1",
		"cat package.json",
		"npm view left-pad",
		"go env GOPATH",
	])("accepts %s", (command) => {
		expect(isReadOnlyCommand(command)).toBe(true);
	});

	it.each([
		"cat x > y",
		"git commit -m oops",
		"rm -rf /",
		"sed -i s/a/b/ file.txt",
		"echo $(rm -rf /)",
		"git branch -D main",
		"find . -name '*.tmp' -delete",
		"cat x | tee y",
		"echo `rm -rf /`",
		"npm install left-pad",
	])("rejects %s", (command) => {
		expect(isReadOnlyCommand(command)).toBe(false);
	});
});

describe("decideToolCall", () => {
	it("blocks edit in analyze", () => {
		const decision = decideToolCall(stateInPhase("analyze"), "edit", {});
		expect(decision?.block).toBe(true);
	});

	it("allows edit in supervise", () => {
		const decision = decideToolCall(stateInPhase("supervise"), "edit", {});
		expect(decision).toBeUndefined();
	});

	it("blocks every tool in awaiting_approval except read/grep/find/ls", () => {
		const state = stateInPhase("awaiting_approval");
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(decideToolCall(state, tool, {})).toBeUndefined();
		}
		for (const tool of ["edit", "write", "bash", "powershell", "submit_plan", "submit_analysis", "escalate"]) {
			expect(decideToolCall(state, tool, {})?.block).toBe(true);
		}
	});

	it("blocks submit_plan in analyze", () => {
		const decision = decideToolCall(stateInPhase("analyze"), "submit_plan", {});
		expect(decision?.block).toBe(true);
	});

	it("blocks non-read-only bash in plan", () => {
		const decision = decideToolCall(stateInPhase("plan"), "bash", { command: "git commit -m oops" });
		expect(decision?.block).toBe(true);
	});

	it("allows read-only bash in plan", () => {
		const decision = decideToolCall(stateInPhase("plan"), "bash", { command: "git status" });
		expect(decision).toBeUndefined();
	});

	it("allows arbitrary bash in verify", () => {
		const decision = decideToolCall(stateInPhase("verify"), "bash", { command: "npm test && rm -rf dist" });
		expect(decision).toBeUndefined();
	});

	it("blocks workflow tools when no state is active", () => {
		for (const tool of WORKFLOW_TOOLS) {
			expect(decideToolCall(undefined, tool, {})?.block).toBe(true);
		}
	});

	it("allows non-workflow tools when no state is active", () => {
		expect(decideToolCall(undefined, "read", {})).toBeUndefined();
		expect(decideToolCall(undefined, "bash", { command: "rm -rf /" })).toBeUndefined();
	});

	it("blocks workflow tools once the run is done or stopped", () => {
		expect(decideToolCall(stateInPhase("done"), "submit_analysis", {})?.block).toBe(true);
		expect(decideToolCall(stateInPhase("stopped"), "escalate", {})?.block).toBe(true);
	});

	it("ci phase only allows read-only inspection tools", () => {
		const state = stateInPhase("ci");
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(decideToolCall(state, tool, {})).toBeUndefined();
		}
		for (const tool of ["edit", "write", "bash", "powershell", "run_gates", "submit_verification"]) {
			expect(decideToolCall(state, tool, {})?.block).toBe(true);
		}
	});

	it("ci phase block reason names the PR and points at /change status", () => {
		const state = { ...stateInPhase("ci"), pr: { number: 42, url: "https://github.com/acme/widgets/pull/42", headSha: "deadbeef" } };
		const decision = decideToolCall(state, "edit", {});
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("PR #42");
		expect(decision?.reason).toContain("/change status");
	});

	it("ci phase block reason still works without a PR on record", () => {
		const decision = decideToolCall(stateInPhase("ci"), "write", {});
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("/change status");
	});

	it("every phase's PHASE_TOOLS entries are covered by decideToolCall without throwing", () => {
		for (const phase of Object.keys(PHASE_TOOLS) as (keyof typeof PHASE_TOOLS)[]) {
			const state = stateInPhase(phase);
			for (const tool of PHASE_TOOLS[phase]) {
				expect(() => decideToolCall(state, tool, { command: "git status" })).not.toThrow();
			}
		}
	});
});
