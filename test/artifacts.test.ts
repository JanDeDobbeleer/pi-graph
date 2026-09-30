import { describe, it, expect } from "vitest";
import { newState, migrateState, restoreState, STATE_ENTRY, type WorkflowState, type PlanTask, type GateResult, type CiFailure, type HookResult, type PullRequestRef } from "../extensions/code-changes/state.ts";
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
	analysisHeadings,
	analysisGateChoices,
	optionIdFromChoice,
	hasProposedChange,
	selectOption,
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
		kind: "bug",
		findings: "the bug is here",
		proposed_change: "fix it",
		out_of_scope: "nothing",
		evidence: "reproduced",
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
		paths: [`src/${overrides.id ?? "t1"}/`],
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
		expect(() => applyAnalysis(baseState(), analysis({ findings: "  " }))).toThrow(ArtifactError);
	});

	it("folds prior analyze escalations into findings", () => {
		const s = baseState({
			escalations: [{ phase: "analyze", question: "Q?", evidence: "e", hypothesis: "h", model: "m", decision: "use approach B" }],
		});
		const result = applyAnalysis(s, analysis());
		expect(result.analysis!.findings).toContain("Escalation decisions");
		expect(result.analysis!.findings).toContain("use approach B");
	});
});

function report(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
	return {
		kind: "bug",
		findings: "greeting.txt says Hello instead of Hi",
		proposed_change: "change the greeting text to Hi",
		out_of_scope: "nothing else",
		evidence: "reproduced: read greeting.txt",
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
		expect(md.startsWith("# Analysis — bug\nKind: bug")).toBe(true);
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
		expect(parsed.findings).toBe(a.findings);
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
		expect(() => parseAnalysisMarkdown("# Analysis\n\nno sections at all")).toThrow(/Root cause.*Reproduction.*Proposed change/s);
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
		expect(parsed.findings).toBe("rc");
		expect(parsed.evidence).toBe("rs");
		expect(parsed.kind).toBe("bug");
	});
});

function featureReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
	return {
		kind: "feature",
		findings: "The cache is process-local; a shared cache would fit in src/cache.ts.",
		proposed_change: "",
		out_of_scope: "Eviction policy.",
		evidence: "src/session.ts already uses a similar store.",
		open_questions: [],
		options: [
			{ id: "A", title: "Redis-backed cache", summary: "Add a Redis client behind the cache interface.", tradeoffs: "Shared across nodes; adds an ops dependency." },
			{ id: "B", title: "File cache", summary: "Persist entries to disk.", tradeoffs: "No new service; not shared between machines." },
		],
		recommendation: "A",
		...overrides,
	};
}

describe("analysisHeadings", () => {
	it("maps every kind to its findings/evidence headings", () => {
		expect(analysisHeadings("bug")).toEqual({ findings: "Root cause", evidence: "Reproduction" });
		expect(analysisHeadings("feature")).toEqual({ findings: "Current behavior and where it fits", evidence: "Prior art" });
		expect(analysisHeadings("refactor")).toEqual({ findings: "What the current code does", evidence: "Evidence" });
		expect(analysisHeadings("question")).toEqual({ findings: "Answer", evidence: "Sources" });
		expect(analysisHeadings("investigation")).toEqual({ findings: "Findings", evidence: "Evidence" });
		expect(analysisHeadings("chore")).toEqual({ findings: "What needs doing", evidence: "Evidence" });
	});
});

describe("formatAnalysis for each kind", () => {
	it("renders a feature analysis with options, marking the recommended one", () => {
		const md = formatAnalysis(featureReport());
		expect(md).toContain("# Analysis — feature");
		expect(md).toContain("Kind: feature");
		expect(md).toContain("## Current behavior and where it fits");
		expect(md).toContain("## Prior art");
		expect(md).toContain("_No change proposed._");
		expect(md).toContain("### A — Redis-backed cache (recommended)");
		expect(md).toContain("### B — File cache\n");
		expect(md).toContain("Trade-offs: Shared across nodes; adds an ops dependency.");
	});

	it("marks the chosen option", () => {
		const md = formatAnalysis(selectOption(featureReport(), "B"));
		expect(md).toContain("### B — File cache (chosen)");
		expect(md).toContain("### A — Redis-backed cache (recommended)");
	});

	const cases: AnalysisReport[] = [
		report(),
		featureReport(),
		featureReport({ chosen_option: "B", proposed_change: "Chosen option B — File cache: Persist entries to disk." }),
		{ kind: "refactor", findings: "- parses input\n- validates it", proposed_change: "split parse and validate", out_of_scope: "", evidence: "src/x.ts", open_questions: ["keep the old export?"] },
		{ kind: "question", findings: "It lives in greeting.txt.", proposed_change: "", out_of_scope: "", evidence: "greeting.txt", open_questions: [] },
		{ kind: "investigation", findings: "Startup takes 3s, mostly module loading.", proposed_change: "", out_of_scope: "", evidence: "profile run", open_questions: [] },
		{ kind: "chore", findings: "Bump typebox in package.json.", proposed_change: "npm i typebox@latest", out_of_scope: "", evidence: "npm outdated", open_questions: [] },
	];
	for (const a of cases) {
		it(`round-trips a ${a.kind} analysis${a.options ? " with options" : ""}${a.chosen_option ? " (chosen)" : ""}`, () => {
			expect(parseAnalysisMarkdown(formatAnalysis(a))).toEqual(a);
			expect(parseAnalysisMarkdown(formatAnalysis(a, { edited: true }))).toEqual(a);
		});
	}

	it("takes the kind from the title when the Kind line is missing", () => {
		const md = formatAnalysis({ ...report(), kind: "chore" }).replace("Kind: chore\n", "");
		expect(parseAnalysisMarkdown(md).kind).toBe("chore");
	});

	it("honours an edited Kind line and accepts the other kinds' headings", () => {
		const md = formatAnalysis(report()).replace("Kind: bug", "Kind: question").replace("# Analysis — bug", "# Analysis");
		const parsed = parseAnalysisMarkdown(md);
		expect(parsed.kind).toBe("question");
		expect(parsed.findings).toBe(report().findings);
		expect(parsed.evidence).toBe(report().evidence);
	});

	it("accepts the neutral Findings/Evidence headings for any kind", () => {
		const md = ["# Analysis", "Kind: feature", "## Findings", "f", "## Evidence", "e", "## Proposed change", "p"].join("\n");
		expect(parseAnalysisMarkdown(md)).toEqual({ kind: "feature", findings: "f", evidence: "e", proposed_change: "p", out_of_scope: "", open_questions: [] });
	});

	it("infers the kind from a kind-specific heading when neither Kind nor title say", () => {
		const md = ["# Analysis", "## Answer", "a", "## Sources", "s"].join("\n");
		const parsed = parseAnalysisMarkdown(md);
		expect(parsed.kind).toBe("question");
		expect(parsed.proposed_change).toBe("");
	});

	it("does not require a proposed change for a question, or for options without one", () => {
		expect(() => parseAnalysisMarkdown(formatAnalysis({ ...report(), kind: "question", proposed_change: "" }))).not.toThrow();
		expect(() => parseAnalysisMarkdown(formatAnalysis(featureReport()))).not.toThrow();
	});

	it("requires a proposed change for a bug without options", () => {
		const md = formatAnalysis({ ...report(), proposed_change: "" });
		expect(() => parseAnalysisMarkdown(md)).toThrow(/Proposed change/);
	});

	it("rejects an unknown kind", () => {
		expect(() => parseAnalysisMarkdown(formatAnalysis(report()).replace("Kind: bug", "Kind: wish"))).toThrow(ArtifactError);
	});

	it("parses multi-line option summaries and trade-offs", () => {
		const md = [
			"# Analysis — feature",
			"## Findings",
			"f",
			"## Evidence",
			"e",
			"## Options",
			"### x — First",
			"line one",
			"line two",
			"Trade-offs: costs a lot",
			"and more",
			"### y - Second (recommended)",
			"only summary",
		].join("\n");
		const parsed = parseAnalysisMarkdown(md);
		expect(parsed.options).toEqual([
			{ id: "x", title: "First", summary: "line one\nline two", tradeoffs: "costs a lot\nand more" },
			{ id: "y", title: "Second", summary: "only summary", tradeoffs: "" },
		]);
		expect(parsed.recommendation).toBe("y");
	});
});

describe("applyAnalysis by kind", () => {
	it("parks a question with no proposed change at the gate", () => {
		const s = applyAnalysis(baseState(), analysis({ kind: "question", proposed_change: "" }));
		expect(s.phase).toBe("awaiting_approval");
		expect(s.analysis!.kind).toBe("question");
	});

	it("keeps a preApproved question at the gate, even with no open questions", () => {
		const s = applyAnalysis(baseState({ preApproved: true }), analysis({ kind: "question", proposed_change: "" }));
		expect(s.phase).toBe("awaiting_approval");
	});

	it("accepts an investigation with no proposed change", () => {
		expect(applyAnalysis(baseState(), analysis({ kind: "investigation", proposed_change: "" })).phase).toBe("awaiting_approval");
	});

	for (const kind of ["bug", "feature", "refactor", "chore"] as const) {
		it(`rejects a ${kind} with no proposed_change and no options`, () => {
			expect(() => applyAnalysis(baseState(), analysis({ kind, proposed_change: "  " }))).toThrow(/proposed_change/);
		});
	}

	it("accepts options without a proposed_change", () => {
		const params = featureReport();
		const s = applyAnalysis(baseState(), params as AnalysisParams);
		expect(s.phase).toBe("awaiting_approval");
		expect(s.analysis!.options).toHaveLength(2);
	});

	it("rejects a recommendation that is not an option id", () => {
		expect(() => applyAnalysis(baseState(), featureReport({ recommendation: "Z" }) as AnalysisParams)).toThrow(/recommendation/);
		expect(() => applyAnalysis(baseState(), analysis({ recommendation: "A" }))).toThrow(/recommendation/);
	});

	it("rejects duplicate or empty option ids", () => {
		const opt = { id: "A", title: "t", summary: "s", tradeoffs: "x" };
		expect(() => applyAnalysis(baseState(), featureReport({ options: [opt, opt], recommendation: undefined }) as AnalysisParams)).toThrow(/duplicate/);
		expect(() => applyAnalysis(baseState(), featureReport({ options: [{ ...opt, id: " " }], recommendation: undefined }) as AnalysisParams)).toThrow(/non-empty id/);
	});

	it("rejects empty findings and evidence", () => {
		expect(() => applyAnalysis(baseState(), analysis({ evidence: " " }))).toThrow(/evidence/);
	});

	it("rejects an invalid kind", () => {
		expect(() => applyAnalysis(baseState(), analysis({ kind: "wish" as never }))).toThrow(/invalid kind/);
	});

	it("auto-advances a preApproved run that recommends an option, taking the recommendation", () => {
		const s = applyAnalysis(baseState({ preApproved: true }), featureReport() as AnalysisParams);
		expect(s.phase).toBe("plan");
		expect(s.analysis!.chosen_option).toBe("A");
		expect(s.analysis!.proposed_change).toContain("Chosen option A — Redis-backed cache");
	});

	it("keeps a preApproved run with options but no recommendation at the gate", () => {
		const s = applyAnalysis(baseState({ preApproved: true }), featureReport({ recommendation: undefined }) as AnalysisParams);
		expect(s.phase).toBe("awaiting_approval");
	});
});

describe("selectOption", () => {
	it("sets chosen_option and the option as the proposed change when none was proposed", () => {
		const a = selectOption(featureReport(), "B");
		expect(a.chosen_option).toBe("B");
		expect(a.proposed_change).toBe("Chosen option B — File cache: Persist entries to disk.");
	});

	it("keeps the existing proposed change when choosing the recommended option", () => {
		const a = selectOption(featureReport({ proposed_change: "Wire it into src/cache.ts." }), "A");
		expect(a.proposed_change).toBe("Chosen option A — Redis-backed cache: Add a Redis client behind the cache interface.\n\nWire it into src/cache.ts.");
	});

	it("replaces the existing proposed change when choosing a different option than recommended", () => {
		const a = selectOption(featureReport({ proposed_change: "Wire it into src/cache.ts." }), "B");
		expect(a.proposed_change).toBe("Chosen option B — File cache: Persist entries to disk.");
	});

	it("is idempotent for the recommended option", () => {
		const once = selectOption(featureReport({ proposed_change: "Wire it in." }), "A");
		expect(selectOption(once, "A").proposed_change).toBe(once.proposed_change);
	});

	it("does not mutate its input and rejects unknown ids", () => {
		const a = featureReport();
		selectOption(a, "A");
		expect(a.chosen_option).toBeUndefined();
		expect(() => selectOption(a, "nope")).toThrow(ArtifactError);
		expect(() => selectOption(report(), "A")).toThrow(/no options/);
	});
});

describe("analysis gate helpers", () => {
	it("offers Approve only when a change is proposed", () => {
		expect(analysisGateChoices(report())).toEqual([
			"Approve",
			"Approve and allow push/PR",
			"Edit the analysis myself",
			"Send feedback to revise",
			"Done — no implementation",
			"Stop the run",
		]);
		const noChange = analysisGateChoices({ ...report(), kind: "question", proposed_change: "" });
		expect(noChange).not.toContain("Approve");
		expect(noChange).toContain("Done — no implementation");
	});

	it("lists one entry per option, marking the recommended one, and no Approve until one is chosen", () => {
		const choices = analysisGateChoices(featureReport());
		expect(choices.slice(0, 2)).toEqual(["Go with A — Redis-backed cache (recommended)", "Go with B — File cache"]);
		expect(choices).not.toContain("Approve");
		expect(analysisGateChoices(selectOption(featureReport(), "B"))).toContain("Approve");
	});

	it("maps a Go with entry back to its option id", () => {
		const a = featureReport();
		const choices = analysisGateChoices(a);
		expect(optionIdFromChoice(a, choices[0])).toBe("A");
		expect(optionIdFromChoice(a, choices[1])).toBe("B");
		expect(optionIdFromChoice(a, "Approve")).toBeUndefined();
	});

	it("hasProposedChange is true for a proposed change or a chosen option", () => {
		expect(hasProposedChange(featureReport())).toBe(false);
		expect(hasProposedChange(featureReport({ chosen_option: "A" }))).toBe(true);
		expect(hasProposedChange(report())).toBe(true);
	});
});

describe("migrateState / restoreState", () => {
	function legacy(): WorkflowState {
		const s = baseState({ phase: "awaiting_approval" });
		return {
			...s,
			analysis: {
				root_cause: "old root cause",
				proposed_change: "old change",
				out_of_scope: "old scope",
				repro_status: "old repro",
				open_questions: ["q"],
			} as unknown as AnalysisReport,
		};
	}

	it("upgrades a persisted root_cause/repro_status analysis to a bug", () => {
		const migrated = migrateState(legacy())!;
		expect(migrated.analysis).toEqual({
			kind: "bug",
			findings: "old root cause",
			evidence: "old repro",
			proposed_change: "old change",
			out_of_scope: "old scope",
			open_questions: ["q"],
		});
		expect("root_cause" in (migrated.analysis as object)).toBe(false);
	});

	it("restoreState migrates old entries and leaves new ones alone", () => {
		const restored = restoreState([{ type: "custom", customType: STATE_ENTRY, data: legacy() }]);
		expect(restored!.analysis!.kind).toBe("bug");
		expect(restored!.analysis!.findings).toBe("old root cause");

		const current = baseState({ analysis: featureReport() });
		expect(restoreState([{ type: "custom", customType: STATE_ENTRY, data: current }])!.analysis).toEqual(featureReport());
	});

	it("passes through a state without an analysis", () => {
		expect(migrateState(undefined)).toBeUndefined();
		const s = baseState();
		expect(migrateState(s)).toBe(s);
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

	it("does not require merge_plan when more than one worktree task exists", () => {
		const plan: PlanParams = {
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
		};
		expect(validatePlan(plan)).toEqual([]);
	});

	it("rejects a merge_plan that omits a task the harness moves to a worktree", () => {
		// a and b are independent "main" tasks in different folders: both end up in worktrees.
		const plan: PlanParams = {
			tasks: [task({ id: "a" }), task({ id: "b" })],
			merge_plan: { order: ["a"], conflict_owner: "coordinator" },
		};
		const problems = validatePlan(plan);
		expect(problems.some((p) => /missing worktree task\(s\): b/.test(p))).toBe(true);
		expect(validatePlan({ ...plan, merge_plan: { order: ["a", "b"], conflict_owner: "coordinator" } })).toEqual([]);
	});

	it("rejects a merge_plan that lists a task that stays in the main tree", () => {
		const plan: PlanParams = {
			tasks: [task({ id: "a" }), task({ id: "b", requires_main_tree: true })],
			merge_plan: { order: ["a", "b"], conflict_owner: "coordinator" },
		};
		expect(validatePlan(plan).some((p) => /non-worktree task\(s\): b/.test(p))).toBe(true);
	});

	it("rejects independent sub-agent tasks whose paths overlap", () => {
		const plan: PlanParams = {
			tasks: [task({ id: "a", paths: ["src/segments/"] }), task({ id: "b", paths: ["src/segments/gcp.go"] })],
		};
		const problems = validatePlan(plan);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/tasks a and b may change the same files/);
		expect(problems[0]).toMatch(/add a dependency between them or merge them/);
	});

	it("accepts overlapping paths once one task depends on the other", () => {
		const plan: PlanParams = {
			tasks: [
				task({ id: "a", paths: ["src/segments/"] }),
				task({ id: "b", paths: ["src/segments/gcp.go"], dependencies: ["a"] }),
			],
		};
		expect(validatePlan(plan)).toEqual([]);
	});

	it("treats a transitive dependency as ordering too", () => {
		const plan: PlanParams = {
			tasks: [
				task({ id: "a", paths: ["src/"] }),
				task({ id: "b", paths: ["docs/"], dependencies: ["a"] }),
				task({ id: "c", paths: ["src/x.go"], dependencies: ["b"] }),
			],
		};
		expect(validatePlan(plan)).toEqual([]);
	});

	it("exempts coordinator-direct tasks from the overlap check and from needing paths", () => {
		const plan: PlanParams = {
			tasks: [
				task({ id: "a", paths: ["src/"] }),
				task({ id: "b", executor_tier: "coordinator-direct", paths: ["src/"] }),
				task({ id: "c", executor_tier: "coordinator-direct", paths: undefined }),
			],
		};
		expect(validatePlan(plan)).toEqual([]);
	});

	it("requires paths on trivial and implementer tasks", () => {
		for (const executor_tier of ["trivial", "implementer"] as const) {
			const problems = validatePlan({ tasks: [task({ id: "a", executor_tier, paths: undefined })] });
			expect(problems.some((p) => /Task "a" has no paths/.test(p))).toBe(true);
		}
		expect(validatePlan({ tasks: [task({ id: "a", paths: [] })] }).some((p) => /has no paths/.test(p))).toBe(true);
	});

	it("rejects absolute, drive, parent-relative and empty paths", () => {
		for (const bad of ["/etc/passwd", "\\share\\x", "C:\\repo\\src", "c:/repo", "../other", "src/../../x", "", "  "]) {
			const problems = validatePlan({ tasks: [task({ paths: [bad] })] });
			expect(problems.some((p) => /invalid path/.test(p)), `path ${JSON.stringify(bad)}`).toBe(true);
		}
	});

	it("accepts relative folders, files, globs and Windows separators", () => {
		const plan: PlanParams = {
			tasks: [task({ paths: ["src/segments/", "website\\docs\\gcp.mdx", "src/**/*_test.go", "./README.md"] })],
		};
		expect(validatePlan(plan)).toEqual([]);
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

	it("formatPlan shows paths, requires_main_tree and an Execution section", () => {
		const p = plan({
			tasks: [
				task({ id: "a", paths: ["src/a/"] }),
				task({ id: "b", paths: ["src/b/", "docs/b.md"] }),
				task({ id: "c", paths: ["src/c/"], requires_main_tree: true, dependencies: ["a"] }),
				task({ id: "d", executor_tier: "coordinator-direct", paths: undefined, dependencies: ["c"] }),
			],
		});
		const md = formatPlan(p);
		expect(md).toContain("- paths: src/a/");
		expect(md).toContain("- paths: src/b/, docs/b.md");
		expect(md).toContain("requires main tree");
		expect(md).toContain("## Execution");
		expect(md).not.toContain("## Parallelism");
		// a and b are independent in wave 1, c is pinned to the main tree so a cannot move (it must be visible to c).
		expect(md).toContain("| a | implementer | main | `src/a/` |");
		expect(md).toContain("| b | implementer | worktree (moved from main) | `src/b/`, `docs/b.md` |");
		expect(md).toContain("| c | implementer | main (requires main tree) | `src/c/` |");
		expect(md).toContain("| d | coordinator | main (in Supervise) | — |");
		expect(md).toContain("Supervise reviews the diff and implements d");
	});

	it("formatPlan lists parallel worktree tasks and the default merge order", () => {
		const md = formatPlan(plan({ tasks: [task({ id: "a" }), task({ id: "b" })] }));
		expect(md).toContain("### Wave 1 — parallel");
		expect(md).toContain("squash-merge a → b");
	});

	it("formatPlan includes the merge plan when present", () => {
		const p = plan({
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
			merge_plan: { order: ["a", "b"], conflict_owner: "coordinator" },
		});
		const md = formatPlan(p);
		expect(md).toContain("squash-merge a → b (conflicts: coordinator)");
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
