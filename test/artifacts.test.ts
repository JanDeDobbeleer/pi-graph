import { describe, it, expect } from "vitest";
import { newState, type WorkflowState, type PlanTask, type GateResult, type CiFailure, type HookResult, type PullRequestRef } from "../extensions/code-changes/state.ts";
import {
	applyAnalysis,
	validatePlan,
	applyPlan,
	topologicalWaves,
	applyReview,
	requiredGateCommands,
	applyVerification,
	resolveEscalatedFailure,
	validateCommitSubjects,
	applyDelivery,
	buildPackets,
	summarizeState,
	formatAnalysis,
	formatPlan,
	parseAnalysisMarkdown,
	parseEditablePlan,
	planToEditable,
	ArtifactError,
	type PlanParams,
	type AnalysisParams,
} from "../extensions/code-changes/artifacts.ts";
import type { AnalysisReport, TaskList } from "../extensions/code-changes/state.ts";

function baseState(overrides: Partial<WorkflowState> = {}): WorkflowState {
	return { ...newState("do the thing", [], "deadbeef"), ...overrides };
}

function analysis(overrides: Partial<AnalysisParams> = {}): AnalysisParams {
	return {
		root_cause: "the bug is here",
		proposed_change: "fix it",
		out_of_scope: "nothing",
		repro_status: "reproduced",
		open_questions: [],
		...overrides,
	};
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
	return {
		id: "t1",
		spec: "do the work",
		verification_commands: ["npm test"],
		executor_tier: "implementer",
		workspace: "main",
		dependencies: [],
		...overrides,
	};
}

describe("applyAnalysis", () => {
	it("goes to awaiting_approval when not preApproved", () => {
		const s = applyAnalysis(baseState({ preApproved: false }), analysis());
		expect(s.phase).toBe("awaiting_approval");
	});

	it("goes straight to plan when preApproved and no open questions", () => {
		const s = applyAnalysis(baseState({ preApproved: true }), analysis({ open_questions: [] }));
		expect(s.phase).toBe("plan");
	});

	it("goes to awaiting_approval when preApproved but open questions remain", () => {
		const s = applyAnalysis(baseState({ preApproved: true }), analysis({ open_questions: ["what about X?"] }));
		expect(s.phase).toBe("awaiting_approval");
	});

	it("re-arms the stop gate when preApproved but re-entering analyze after a Verify failure", () => {
		const s = applyAnalysis(
			baseState({
				preApproved: true,
				failures: [{ attempt_number: 1, failure_class: "wrong_root_cause", destination: "analyze", summary: "diagnosis was wrong" }],
			}),
			analysis({ open_questions: [] }),
		);
		expect(s.phase).toBe("awaiting_approval");
	});

	it("rejects when not in analyze phase", () => {
		expect(() => applyAnalysis(baseState({ phase: "plan" }), analysis())).toThrow(ArtifactError);
	});

	it("rejects empty required fields", () => {
		expect(() => applyAnalysis(baseState(), analysis({ root_cause: "  " }))).toThrow(ArtifactError);
	});

	it("folds prior analyze escalations into root_cause", () => {
		const s = baseState({
			escalations: [{ phase: "analyze", question: "Q?", evidence: "e", hypothesis: "h", model: "m", decision: "use approach B" }],
		});
		const result = applyAnalysis(s, analysis());
		expect(result.analysis!.root_cause).toContain("Escalation decisions");
		expect(result.analysis!.root_cause).toContain("use approach B");
	});
});

function report(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
	return {
		root_cause: "greeting.txt says Hello instead of Hi",
		proposed_change: "change the greeting text to Hi",
		out_of_scope: "nothing else",
		repro_status: "reproduced: read greeting.txt",
		open_questions: [],
		...overrides,
	};
}

describe("formatAnalysis / parseAnalysisMarkdown", () => {
	it("round-trips a report with no open questions", () => {
		const a = report();
		expect(parseAnalysisMarkdown(formatAnalysis(a))).toEqual(a);
	});

	it("round-trips a report with open questions, listed first", () => {
		const a = report({ open_questions: ["what about X?", "and Y?"] });
		const md = formatAnalysis(a);
		expect(md.indexOf("Open questions")).toBeLessThan(md.indexOf("Root cause"));
		expect(parseAnalysisMarkdown(md)).toEqual(a);
	});

	it("marks the edited-by-you note without breaking the round trip", () => {
		const a = report();
		const md = formatAnalysis(a, { edited: true });
		expect(md).toContain("edited by you");
		expect(parseAnalysisMarkdown(md)).toEqual(a);
	});

	it("tolerates reordered sections", () => {
		const a = report({ open_questions: ["Q1"] });
		const md = formatAnalysis(a);
		const sections = md.split(/(?=^## )/m).map((s) => s.replace(/\s+$/, ""));
		const reordered = [sections[0], ...sections.slice(1).reverse()].join("\n\n");
		expect(parseAnalysisMarkdown(reordered)).toEqual(a);
	});

	it("tolerates a missing optional section (out_of_scope)", () => {
		const a = report({ out_of_scope: "" });
		const md = formatAnalysis(a).replace(/## Out of scope\n?/, "").replace("nothing else", "");
		const parsed = parseAnalysisMarkdown(md);
		expect(parsed.out_of_scope).toBe("");
		expect(parsed.root_cause).toBe(a.root_cause);
	});

	it("throws ArtifactError naming a missing required section", () => {
		const md = formatAnalysis(report()).replace(/## Root cause\n[\s\S]*?(?=\n## )/, "");
		expect(() => parseAnalysisMarkdown(md)).toThrow(ArtifactError);
		try {
			parseAnalysisMarkdown(md);
			throw new Error("expected parseAnalysisMarkdown to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(ArtifactError);
			expect((err as ArtifactError).message).toContain("Root cause");
		}
	});

	it("throws ArtifactError naming all missing required sections", () => {
		expect(() => parseAnalysisMarkdown("# Analysis\n\nno sections at all")).toThrow(/Root cause.*Proposed change.*Repro status/s);
	});

	it("ignores prose outside any section and parses only '- ' bullets as open questions", () => {
		const md = [
			"# Analysis",
			"",
			"Some free-form note the human left here.",
			"",
			"## Open questions",
			"- real question",
			"not a bullet, ignored",
			"",
			"## Root cause",
			"rc",
			"## Proposed change",
			"pc",
			"## Repro status",
			"rs",
		].join("\n");
		const parsed = parseAnalysisMarkdown(md);
		expect(parsed.open_questions).toEqual(["real question"]);
		expect(parsed.root_cause).toBe("rc");
	});
});

describe("validatePlan", () => {
	it("accepts a simple valid plan", () => {
		const plan: PlanParams = { tasks: [task()] };
		expect(validatePlan(plan)).toEqual([]);
	});

	it("flags an empty task list", () => {
		expect(validatePlan({ tasks: [] })).not.toEqual([]);
	});

	it("flags duplicate ids", () => {
		const plan: PlanParams = { tasks: [task({ id: "a" }), task({ id: "a" })] };
		expect(validatePlan(plan).some((p) => /duplicate/i.test(p))).toBe(true);
	});

	it("flags unknown dependency", () => {
		const plan: PlanParams = { tasks: [task({ id: "a", dependencies: ["ghost"] })] };
		expect(validatePlan(plan).some((p) => /unknown task/i.test(p))).toBe(true);
	});

	it("flags a dependency cycle", () => {
		const plan: PlanParams = { tasks: [task({ id: "a", dependencies: ["b"] }), task({ id: "b", dependencies: ["a"] })] };
		expect(validatePlan(plan).some((p) => /cycle/i.test(p))).toBe(true);
	});

	it("requires merge_plan when more than one worktree task exists", () => {
		const plan: PlanParams = {
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
		};
		expect(validatePlan(plan).some((p) => /merge_plan is required/i.test(p))).toBe(true);
	});

	it("accepts two worktree tasks with a valid merge_plan", () => {
		const plan: PlanParams = {
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
			merge_plan: { order: ["a", "b"], conflict_owner: "coordinator" },
		};
		expect(validatePlan(plan)).toEqual([]);
	});

	it("flags a task with no verification commands", () => {
		const plan: PlanParams = { tasks: [task({ verification_commands: [] })] };
		expect(validatePlan(plan).some((p) => /verification_commands/i.test(p))).toBe(true);
	});
});

describe("applyPlan", () => {
	it("throws listing all problems", () => {
		const plan: PlanParams = { tasks: [] };
		try {
			applyPlan(baseState({ phase: "plan" }), plan);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ArtifactError);
			expect((e as Error).message).toContain("at least one task");
		}
	});

	it("transitions to awaiting_plan_approval on success when not preApproved", () => {
		const s = applyPlan(baseState({ phase: "plan", preApproved: false }), { tasks: [task()] });
		expect(s.phase).toBe("awaiting_plan_approval");
		expect(s.plan?.tasks.length).toBe(1);
	});

	it("transitions straight to delegate on success when preApproved", () => {
		const s = applyPlan(baseState({ phase: "plan", preApproved: true }), { tasks: [task()] });
		expect(s.phase).toBe("delegate");
		expect(s.plan?.tasks.length).toBe(1);
	});
});

describe("formatPlan / planToEditable / parseEditablePlan", () => {
	function plan(overrides: Partial<TaskList> = {}): TaskList {
		return { tasks: [task()], ...overrides };
	}

	it("formatPlan includes id, tier, workspace, dependencies, spec, and verification commands", () => {
		const p = plan({ tasks: [task({ id: "t1", executor_tier: "implementer", workspace: "worktree", dependencies: ["t0"] })] });
		const md = formatPlan(p);
		expect(md).toContain("Task t1");
		expect(md).toContain("implementer");
		expect(md).toContain("worktree");
		expect(md).toContain("t0");
		expect(md).toContain("do the work");
		expect(md).toContain("npm test");
	});

	it("formatPlan includes the merge plan when present", () => {
		const p = plan({
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
			merge_plan: { order: ["a", "b"], conflict_owner: "coordinator" },
		});
		const md = formatPlan(p);
		expect(md).toContain("a -> b");
		expect(md).toContain("coordinator");
	});

	it("marks the edited-by-you note", () => {
		const md = formatPlan(plan(), { edited: true });
		expect(md).toContain("edited by you");
	});

	it("planToEditable / parseEditablePlan round-trips a plan", () => {
		const p = plan();
		const editable = planToEditable(p);
		expect(editable).toContain("```json");
		expect(parseEditablePlan(editable)).toEqual(p);
	});

	it("parseEditablePlan parses bare JSON with no fence", () => {
		const p = plan();
		expect(parseEditablePlan(JSON.stringify(p))).toEqual(p);
	});

	it("parseEditablePlan throws ArtifactError on invalid JSON", () => {
		expect(() => parseEditablePlan("not json at all")).toThrow(ArtifactError);
	});

	it("parseEditablePlan throws ArtifactError listing validation problems", () => {
		const bad = JSON.stringify({ tasks: [] });
		try {
			parseEditablePlan(bad);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(ArtifactError);
			expect((e as Error).message).toContain("at least one task");
		}
	});
});

describe("buildPackets", () => {
	it("includes standing instructions", () => {
		const packets = buildPackets({ tasks: [task()] });
		expect(packets[0].standing_instructions).toMatch(/do not commit/i);
		expect(packets[0].spec).toBe("do the work");
	});
});

describe("topologicalWaves", () => {
	it("groups independent tasks into one wave", () => {
		const waves = topologicalWaves([task({ id: "a" }), task({ id: "b" })]);
		expect(waves.length).toBe(1);
		expect(waves[0].map((t) => t.id).sort()).toEqual(["a", "b"]);
	});

	it("separates dependent tasks into successive waves", () => {
		const waves = topologicalWaves([task({ id: "a" }), task({ id: "b", dependencies: ["a"] })]);
		expect(waves.length).toBe(2);
		expect(waves[0].map((t) => t.id)).toEqual(["a"]);
		expect(waves[1].map((t) => t.id)).toEqual(["b"]);
	});
});

describe("applyReview", () => {
	it("rejects an empty merged diff", () => {
		expect(() => applyReview(baseState({ phase: "supervise" }), { overrides: [], tests_kept: [], tests_cut: [] }, "")).toThrow(
			ArtifactError,
		);
	});

	it("stores review and transitions to verify", () => {
		const s = applyReview(baseState({ phase: "supervise" }), { overrides: [], tests_kept: ["t1"], tests_cut: [] }, "diff --git a b");
		expect(s.phase).toBe("verify");
		expect(s.review?.merged_diff).toBe("diff --git a b");
	});
});

describe("requiredGateCommands", () => {
	it("de-duplicates across tasks in order", () => {
		const plan = { tasks: [task({ id: "a", verification_commands: ["npm test", "npm lint"] }), task({ id: "b", verification_commands: ["npm test"] })] };
		expect(requiredGateCommands(baseState({ plan }))).toEqual(["npm test", "npm lint"]);
	});
});

function gate(command: string, exit_code: number): GateResult {
	return { command, exit_code, output: "", duration_ms: 1 };
}

describe("applyVerification - pass", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test"] })] };

	it("rejects pass with no gates run", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [] });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "it works" })).toThrow(ArtifactError);
	});

	it("rejects pass with a failing gate", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 1)] });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "it works" })).toThrow(ArtifactError);
	});

	it("rejects pass missing a required command", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm lint", 0)] });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "it works" })).toThrow(ArtifactError);
	});

	it("accepts pass with all required commands green", () => {
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0)] });
		const outcome = applyVerification(s, { outcome: "pass", functional_proof: "it works" });
		expect(outcome.kind).toBe("deliver");
		if (outcome.kind === "deliver") {
			expect(outcome.state.phase).toBe("deliver");
			expect(outcome.state.evidence?.functional_proof).toBe("it works");
		}
	});

	it("rejects pass while a CI failure is on record", () => {
		const ciFailure: CiFailure = {
			pr: { number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: "abc123" },
			failed: [{ name: "build", bucket: "fail", link: "" }],
			logs: "boom",
		};
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0)], ciFailure });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "it works" })).toThrow(ArtifactError);
	});

	it("rejects pass when a stop hook blocked", () => {
		const blockedHook: HookResult = { source: "claude", command: "go run main.go", exit_code: 2, blocked: true, reason: "lint failed", duration_ms: 10 };
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0)], lastHooks: [blockedHook] });
		expect(() => applyVerification(s, { outcome: "pass", functional_proof: "it works" })).toThrow(ArtifactError);
	});

	it("accepts pass when stop hooks ran and none blocked", () => {
		const okHook: HookResult = { source: "claude", command: "go run main.go", exit_code: 0, blocked: false, reason: "", duration_ms: 10 };
		const s = baseState({ phase: "verify", plan, lastGates: [gate("npm test", 0)], lastHooks: [okHook] });
		const outcome = applyVerification(s, { outcome: "pass", functional_proof: "it works" });
		expect(outcome.kind).toBe("deliver");
	});
});

describe("applyVerification - fail routing", () => {
	const plan = { tasks: [task({ verification_commands: ["npm test"] })] };

	it("attempt 1 with gate_failure retries to supervise", () => {
		const s = baseState({ phase: "verify", plan });
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "test failed", functional_proof: "" });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind === "retry") {
			expect(outcome.state.phase).toBe("supervise");
			expect(outcome.failure.attempt_number).toBe(1);
		}
	});

	it("attempt 1 with wrong_root_cause retries to analyze", () => {
		const s = baseState({ phase: "verify", plan });
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "wrong_root_cause", failure_summary: "diagnosis was wrong", functional_proof: "" });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind === "retry") {
			expect(outcome.state.phase).toBe("analyze");
		}
	});

	it("clears ciFailure and folds check names into the summary when a fail is submitted while it is set", () => {
		const ciFailure: CiFailure = {
			pr: { number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: "abc123" },
			failed: [{ name: "build", bucket: "fail", link: "" }, { name: "test", bucket: "fail", link: "" }],
			logs: "boom",
		};
		const s = baseState({ phase: "verify", plan, ciFailure });
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "the build broke", functional_proof: "" });
		expect(outcome.kind).toBe("retry");
		if (outcome.kind === "retry") {
			expect(outcome.state.ciFailure).toBeUndefined();
			expect(outcome.failure.summary).toContain("build");
			expect(outcome.failure.summary).toContain("test");
			expect(outcome.failure.summary).toContain("the build broke");
		}
	});

	it("attempt 2 escalates and stays in verify until resolved, then resolving routes", () => {
		const s = baseState({
			phase: "verify",
			plan,
			failures: [{ attempt_number: 1, failure_class: "gate_failure", destination: "supervise", summary: "first failure" }],
		});
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "still failing", functional_proof: "" });
		expect(outcome.kind).toBe("escalate");
		if (outcome.kind === "escalate") {
			expect(outcome.state.phase).toBe("verify");
			expect(outcome.failure.attempt_number).toBe(2);
			const resolved = resolveEscalatedFailure(outcome.state, "try approach B");
			expect(resolved.phase).toBe("supervise");
			expect(resolved.failures[resolved.failures.length - 1].escalation_answer).toBe("try approach B");
		}
	});

	it("attempt 3 (after escalation answer recorded) stops", () => {
		const s = baseState({
			phase: "verify",
			plan,
			failures: [
				{ attempt_number: 1, failure_class: "gate_failure", destination: "supervise", summary: "first failure" },
				{ attempt_number: 2, failure_class: "gate_failure", destination: "supervise", summary: "second failure", escalation_answer: "try approach B" },
			],
		});
		const outcome = applyVerification(s, { outcome: "fail", failure_class: "gate_failure", failure_summary: "still failing after escalation", functional_proof: "" });
		expect(outcome.kind).toBe("stop");
		if (outcome.kind === "stop") {
			expect(outcome.state.phase).toBe("stopped");
			expect(outcome.report).toContain("still failing after escalation");
			expect(outcome.report).toContain("try approach B");
		}
	});
});

describe("commit subjects and delivery", () => {
	it("flags non-conventional subjects", () => {
		const offending = validateCommitSubjects(["fix: good one", "did some stuff"]);
		expect(offending).toEqual(["did some stuff"]);
	});

	it("requires no_commit_reason when there are no commits", () => {
		const s = baseState({ phase: "deliver" });
		expect(() => applyDelivery(s, { report: "nothing shipped" }, [])).toThrow(ArtifactError);
	});

	it("succeeds with no_commit_reason and no commits", () => {
		const s = baseState({ phase: "deliver" });
		const result = applyDelivery(s, { report: "nothing shipped", no_commit_reason: "investigation only" }, []);
		expect(result.phase).toBe("done");
	});

	it("succeeds with valid conventional commits", () => {
		const s = baseState({ phase: "deliver" });
		const result = applyDelivery(s, { report: "shipped the fix" }, ["fix(core): correct off-by-one"]);
		expect(result.phase).toBe("done");
		expect(result.delivery?.commits).toEqual(["fix(core): correct off-by-one"]);
	});

	it("rejects non-conventional commit subjects", () => {
		const s = baseState({ phase: "deliver" });
		expect(() => applyDelivery(s, { report: "shipped" }, ["oops i broke it"])).toThrow(ArtifactError);
	});

	it("routes to ci and records the PR when one is known", () => {
		const pr: PullRequestRef = { number: 7, url: "https://github.com/acme/widgets/pull/7", headSha: "abc123" };
		const s = baseState({ phase: "deliver" });
		const result = applyDelivery(s, { report: "shipped the fix" }, ["fix(core): correct off-by-one"], pr);
		expect(result.phase).toBe("ci");
		expect(result.pr).toEqual(pr);
	});

	it("routes to done, unchanged, when no PR is known", () => {
		const s = baseState({ phase: "deliver" });
		const result = applyDelivery(s, { report: "shipped the fix" }, ["fix(core): correct off-by-one"]);
		expect(result.phase).toBe("done");
		expect(result.pr).toBeUndefined();
	});
});

describe("summarizeState", () => {
	it("produces a compact markdown summary under 4000 chars", () => {
		const s = baseState({
			analysis: analysis(),
			plan: { tasks: [task()] },
			failures: [{ attempt_number: 1, failure_class: "gate_failure", destination: "supervise", summary: "broke" }],
		});
		const summary = summarizeState(s);
		expect(summary.length).toBeLessThanOrEqual(4000);
		expect(summary).toContain("## Analysis");
		expect(summary).toContain("## Plan");
		expect(summary).toContain("## Failures");
	});
});
