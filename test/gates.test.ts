import { describe, expect, it } from "vitest";
import {
	decideToolCall,
	findBroadStagingSegment,
	findForcePushWithoutLease,
	findOutwardSegment,
	isReadOnlyCommand,
	PHASE_TOOLS,
	WORKFLOW_TOOLS,
} from "../extensions/code-changes/gates.ts";
import { newState, type WorkflowState } from "../extensions/code-changes/state.ts";

function stateInPhase(phase: WorkflowState["phase"]): WorkflowState {
	const s = newState("do a thing", ["read", "edit", "bash"], "deadbeef");
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
		"gh issue view 12 --comments",
		"gh pr view 3 --json title,body | jq .title",
		"gh api repos/o/r/issues/1/comments --paginate",
		"gh search issues foo",
		"curl -sL https://x | head",
		"git fetch origin",
		"git ls-remote origin",
		"irm https://x",
		"cd src && grep -ri foo .",
		"pushd src && ls",
		"Set-Location src",
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
		"gh pr create",
		"gh pr merge 1",
		"gh api -X POST repos/o/r/issues",
		"gh api repos/o/r/issues -f title=x",
		"gh issue comment 1 -b x",
		"gh pr checkout 1",
		"curl -o f https://x",
		"curl -d a=b https://x",
		"curl -X DELETE https://x",
		"iwr https://x -OutFile f",
		"git fetch && git reset --hard",
		"cd src && rm x",
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

	it("blocks every tool in awaiting_plan_approval except read/grep/find/ls", () => {
		const state = stateInPhase("awaiting_plan_approval");
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(decideToolCall(state, tool, {})).toBeUndefined();
		}
		for (const tool of ["edit", "write", "bash", "powershell", "submit_plan", "run_delegation", "escalate"]) {
			expect(decideToolCall(state, tool, {})?.block).toBe(true);
		}
	});

	it("names /change approve as the way out of awaiting_plan_approval", () => {
		const decision = decideToolCall(stateInPhase("awaiting_plan_approval"), "bash", { command: "git status" });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("/change approve");
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

	// -------------------------------------------------------------------------
	// Outward actions (push / PR / GitHub replies), force-with-lease, explicit staging
	// -------------------------------------------------------------------------

	describe("findOutwardSegment", () => {
		it.each([
			"git push",
			"git push origin main",
			"gh pr create --title x",
			"gh pr comment 1 --body hi",
			"gh pr review 1 --approve",
			"gh pr merge 1",
			"gh issue comment 1 --body hi",
			"gh issue close 1",
			"gh api repos/acme/widgets/issues/1/comments -f body=hi",
			"gh api -X POST repos/acme/widgets/pulls/1/reviews",
			"gh api --method PATCH repos/acme/widgets/issues/1",
		])("flags %s", (command) => {
			expect(findOutwardSegment(command)).toBeDefined();
		});

		it.each(["git status", "git log", "gh pr view 1", "gh api repos/acme/widgets -X GET", "gh api repos/acme/widgets"])(
			"does not flag %s",
			(command) => {
				expect(findOutwardSegment(command)).toBeUndefined();
			},
		);
	});

	describe("findForcePushWithoutLease", () => {
		it.each(["git push --force", "git push -f origin main", "git push origin main --force"])("flags %s", (command) => {
			expect(findForcePushWithoutLease(command)).toBeDefined();
		});

		it.each(["git push", "git push --force-with-lease", "git push --force --force-with-lease"])("does not flag %s", (command) => {
			expect(findForcePushWithoutLease(command)).toBeUndefined();
		});
	});

	describe("findBroadStagingSegment", () => {
		it.each(["git add -A", "git add --all", "git add .", "git add :/", "git commit -a -m x", "git commit -am x", "git commit --all -m x"])(
			"flags %s",
			(command) => {
				expect(findBroadStagingSegment(command)).toBeDefined();
			},
		);

		it.each(["git add file.txt", "git commit -m x", "git status"])("does not flag %s", (command) => {
			expect(findBroadStagingSegment(command)).toBeUndefined();
		});
	});

	describe("push/PR/reply gate", () => {
		it("blocks git push in deliver when pushAllowed is false", () => {
			const state = { ...stateInPhase("deliver"), pushAllowed: false };
			const decision = decideToolCall(state, "bash", { command: "git push origin main" });
			expect(decision?.block).toBe(true);
			expect(decision?.reason).toContain("allow-push");
		});

		it("allows git push in deliver when pushAllowed is true", () => {
			const state = { ...stateInPhase("deliver"), pushAllowed: true };
			const decision = decideToolCall(state, "bash", { command: "git push origin main" });
			expect(decision).toBeUndefined();
		});

		it("blocks gh pr create in deliver when pushAllowed is false", () => {
			const state = { ...stateInPhase("deliver"), pushAllowed: false };
			const decision = decideToolCall(state, "powershell", { command: "gh pr create --title x --body y" });
			expect(decision?.block).toBe(true);
		});

		it("blocks force push without --force-with-lease even when pushAllowed", () => {
			const state = { ...stateInPhase("deliver"), pushAllowed: true };
			const decision = decideToolCall(state, "bash", { command: "git push --force origin main" });
			expect(decision?.block).toBe(true);
			expect(decision?.reason).toContain("force-with-lease");
		});

		it("allows force-with-lease push when pushAllowed", () => {
			const state = { ...stateInPhase("deliver"), pushAllowed: true };
			const decision = decideToolCall(state, "bash", { command: "git push --force-with-lease origin main" });
			expect(decision).toBeUndefined();
		});

		it("blocks explicit broad staging in supervise/verify/deliver", () => {
			for (const phase of ["supervise", "verify", "deliver"] as const) {
				const state = stateInPhase(phase);
				expect(decideToolCall(state, "bash", { command: "git add -A" })?.block).toBe(true);
				expect(decideToolCall(state, "bash", { command: 'git commit -am "wip"' })?.block).toBe(true);
			}
		});

		it("allows explicit staging by filename in supervise/verify/deliver", () => {
			for (const phase of ["supervise", "verify", "deliver"] as const) {
				const state = stateInPhase(phase);
				expect(decideToolCall(state, "bash", { command: "git add greeting.txt" })).toBeUndefined();
			}
		});

		it("does not apply the push/staging gates when no run is active", () => {
			expect(decideToolCall(undefined, "bash", { command: "git push --force origin main" })).toBeUndefined();
			expect(decideToolCall(undefined, "bash", { command: "git add -A" })).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Extra read-only tools from other extensions
	// -------------------------------------------------------------------------

	describe("extra read-only tools", () => {
		it("allows a configured extra read-only tool in analyze", () => {
			const decision = decideToolCall(stateInPhase("analyze"), "web_fetch", {}, ["web_fetch"]);
			expect(decision).toBeUndefined();
		});

		it("blocks a configured extra read-only tool in awaiting_approval", () => {
			const decision = decideToolCall(stateInPhase("awaiting_approval"), "web_fetch", {}, ["web_fetch"]);
			expect(decision?.block).toBe(true);
		});

		it("ignores an extra read-only entry that shadows a built-in tool name", () => {
			const decision = decideToolCall(stateInPhase("analyze"), "edit", {}, ["edit"]);
			expect(decision?.block).toBe(true);
		});

		it("supports glob patterns", () => {
			const decision = decideToolCall(stateInPhase("plan"), "mcp__docs__fetch", {}, ["mcp__docs__*"]);
			expect(decision).toBeUndefined();
		});

		it("does not affect phases without extra read-only tools when none are configured", () => {
			const decision = decideToolCall(stateInPhase("analyze"), "web_fetch", {});
			expect(decision?.block).toBe(true);
		});
	});
});
