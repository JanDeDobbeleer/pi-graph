import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { newState, type WorkflowState } from "../extensions/code-changes/state.ts";
import { phasePrompt, phaseReminder, readReference, referencesForPhase, SKILL_DIR, stripEnforced } from "../extensions/code-changes/prompts.ts";

function stateInPhase(phase: WorkflowState["phase"], overrides: Partial<WorkflowState> = {}): WorkflowState {
	const s = newState("fix the thing", ["read", "edit", "bash"], "deadbeef");
	return { ...s, phase, ...overrides };
}

describe("SKILL_DIR", () => {
	it("resolves to the bundled skill directory", () => {
		expect(SKILL_DIR.replace(/\\/g, "/")).toMatch(/skills\/code-changes$/);
	});
});

describe("stripEnforced", () => {
	it("removes a single harness:enforced block", () => {
		const text = "before\n<!-- harness:enforced -->\nenforced content\n<!-- /harness:enforced -->\nafter";
		const out = stripEnforced(text);
		expect(out).not.toContain("enforced content");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("tolerates CRLF line endings", () => {
		const text = "before\r\n<!-- harness:enforced -->\r\nenforced content\r\n<!-- /harness:enforced -->\r\nafter";
		const out = stripEnforced(text);
		expect(out).not.toContain("enforced content");
		expect(out).toContain("before");
		expect(out).toContain("after");
	});

	it("removes multiple blocks and collapses the resulting blank lines", () => {
		const text = ["keep1", "<!-- harness:enforced -->", "drop1", "<!-- /harness:enforced -->", "", "keep2", "<!-- harness:enforced -->", "drop2", "<!-- /harness:enforced -->", "keep3"].join(
			"\n",
		);
		const out = stripEnforced(text);
		expect(out).not.toContain("drop1");
		expect(out).not.toContain("drop2");
		expect(out).toContain("keep1");
		expect(out).toContain("keep2");
		expect(out).toContain("keep3");
		expect(out).not.toMatch(/\n{3,}/);
	});

	it("leaves an unbalanced open marker untouched instead of dropping the rest of the file", () => {
		const text = "keep1\n<!-- harness:enforced -->\nnever closed\nkeep2";
		const out = stripEnforced(text);
		expect(out).toContain("keep1");
		expect(out).toContain("never closed");
		expect(out).toContain("keep2");
	});

	it("still strips a well-formed block that appears before an unbalanced one", () => {
		const text = "keep1\n<!-- harness:enforced -->\ndrop1\n<!-- /harness:enforced -->\nkeep2\n<!-- harness:enforced -->\nnever closed";
		const out = stripEnforced(text);
		expect(out).not.toContain("drop1");
		expect(out).toContain("keep1");
		expect(out).toContain("keep2");
	});
});

describe("readReference", () => {
	it("reads an existing reference file with harness blocks stripped by default", () => {
		const text = readReference("verify");
		expect(text).toContain("On failure");
		expect(text).not.toContain("Retry cap");
	});

	it("reads the raw, unstripped file with harness: false", () => {
		const text = readReference("verify", { harness: false });
		expect(text).toContain("Retry cap");
	});

	it("is cached across calls", () => {
		expect(readReference("plan")).toBe(readReference("plan"));
	});

	it("caches the harness and raw views separately", () => {
		expect(readReference("verify", { harness: true })).not.toBe(readReference("verify", { harness: false }));
	});

	it("returns a warning comment for a missing reference file", () => {
		const text = readReference("does-not-exist");
		expect(text).toContain("not found");
	});
});

describe("referencesForPhase", () => {
	it("uses analyze.md for the default analyze entry", () => {
		expect(referencesForPhase(stateInPhase("analyze"))).toEqual(["analyze", "escalate"]);
	});

	it("uses issue-triage.md for the issue-triage entry", () => {
		expect(referencesForPhase(stateInPhase("analyze", { entry: "issue-triage" }))).toEqual(["issue-triage", "escalate"]);
	});

	it("uses pr-review-comments.md for the pr-review-comments entry", () => {
		expect(referencesForPhase(stateInPhase("analyze", { entry: "pr-review-comments" }))).toEqual(["pr-review-comments", "escalate"]);
	});

	it("includes delegate.md (the executor-choice section) for plan", () => {
		expect(referencesForPhase(stateInPhase("plan"))).toEqual(["plan", "delegate"]);
	});

	it("reads nothing extra for delegate", () => {
		expect(referencesForPhase(stateInPhase("delegate"))).toEqual([]);
	});

	it("maps supervise and verify to their reference plus escalate.md", () => {
		expect(referencesForPhase(stateInPhase("supervise"))).toEqual(["supervise", "escalate"]);
		expect(referencesForPhase(stateInPhase("verify"))).toEqual(["verify", "escalate"]);
	});

	it("adds pr-review-comments.md to deliver only for that entry", () => {
		expect(referencesForPhase(stateInPhase("deliver"))).toEqual(["deliver"]);
		expect(referencesForPhase(stateInPhase("deliver", { entry: "pr-review-comments" }))).toEqual(["deliver", "pr-review-comments"]);
	});
});

describe("phasePrompt", () => {
	it("includes the phase header, task, references, state summary, tools, and exit instruction", () => {
		const state = stateInPhase("analyze");
		const text = phasePrompt(state);
		expect(text).toContain(`[code-changes] Phase: Analyze (run ${state.id})`);
		expect(text).toContain(state.task);
		expect(text).toContain("Reference: analyze.md");
		expect(text).toContain("Reference: escalate.md");
		expect(text).toContain("Prior state");
		expect(text).toContain("submit_analysis");
		expect(text).toContain("This phase ends only when you call `submit_analysis`.");
		expect(text).toContain("Edit and write are blocked");
	});

	it("no longer injects artifacts.md", () => {
		const text = phasePrompt(stateInPhase("analyze"));
		expect(text).not.toContain("Artifact contract between phases");
	});

	it("includes the harness-is-the-flow line", () => {
		for (const phase of ["analyze", "plan", "delegate", "supervise", "verify", "deliver"] as const) {
			const text = phasePrompt(stateInPhase(phase));
			expect(text).toContain("The harness is the flow: do not invoke the code-changes skill or follow its phase order manually");
		}
	});

	it("includes the additional context extra when provided", () => {
		const state = stateInPhase("analyze");
		const text = phasePrompt(state, "the human wants more detail on X");
		expect(text).toContain("Additional context");
		expect(text).toContain("the human wants more detail on X");
	});

	it("notes the issue-triage deliverable-only exit at the analyze gate", () => {
		const text = phasePrompt(stateInPhase("analyze", { entry: "issue-triage" }));
		expect(text).toContain("Reference: issue-triage.md");
		expect(text).toContain("deliverable");
	});

	it("mentions run_delegation for the delegate phase", () => {
		const text = phasePrompt(stateInPhase("delegate"));
		expect(text).toContain("Call run_delegation now");
	});

	it("includes the delegate.md executor-choice guidance in plan but not its enforced sections", () => {
		const text = phasePrompt(stateInPhase("plan"));
		expect(text).toContain("Reference: delegate.md");
		expect(text).toContain("Trivial: mechanical edit, config tweak, typo, doc update");
		expect(text).not.toContain("What is never delegated downward");
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

	it("mentions resume_task and lists runs with spec gaps or stalled for supervise", () => {
		const state = stateInPhase("supervise", {
			runs: [{ task_id: "t1", status: "failed", spec_gaps: ["SPEC GAP: unclear on X"], stalled: false }],
		});
		const text = phasePrompt(state);
		expect(text).toContain("resume_task");
		expect(text).toContain("t1");
		expect(text).toContain("spec gap");
	});

	it("mentions conventional commits for deliver", () => {
		const text = phasePrompt(stateInPhase("deliver"));
		expect(text).toContain("conventional commits");
		expect(text).toContain("submit_delivery");
	});

	it("states push blocked and explicit staging when pushAllowed is false", () => {
		const text = phasePrompt(stateInPhase("deliver", { pushAllowed: false }));
		expect(text).toContain("push, PR creation and PR/issue replies are blocked");
		expect(text).toContain("/change allow-push");
		expect(text).toContain("git add -A");
	});

	it("states push/PR allowed when pushAllowed is true", () => {
		const text = phasePrompt(stateInPhase("deliver", { pushAllowed: true }));
		expect(text).toContain("push/PR allowed");
		expect(text).toContain("--force-with-lease");
	});

	it("includes fixup/autosquash and reply guidance for the pr-review-comments entry in deliver", () => {
		const text = phasePrompt(stateInPhase("deliver", { entry: "pr-review-comments" }));
		expect(text).toContain("Reference: pr-review-comments.md");
		expect(text).toContain("autosquash");
		expect(text).toContain("Draft a reply for every review thread");
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

	it("includes push allowed status for deliver", () => {
		expect(phaseReminder(stateInPhase("deliver", { pushAllowed: true }))).toContain("Push allowed: yes");
		expect(phaseReminder(stateInPhase("deliver", { pushAllowed: false }))).toContain("Push allowed: no");
	});
});

// ---------------------------------------------------------------------------
// Guard: every references/*.md file still contains its standalone content — stripping is only
// applied when the harness injects the file, never to the source file itself.
// ---------------------------------------------------------------------------

describe("reference files stay standalone-complete", () => {
	function raw(name: string): string {
		return fs.readFileSync(path.join(SKILL_DIR, "references", `${name}.md`), "utf8");
	}

	it("verify.md still has its Retry cap heading in the raw file", () => {
		expect(raw("verify")).toContain("## Retry cap");
	});

	it("analyze.md still has its Output-of-this-phase and Stop gate headings", () => {
		const text = raw("analyze");
		expect(text).toContain("## Output of this phase");
		expect(text).toContain("## Stop gate");
	});

	it("plan.md still has its Output-of-this-phase heading and merge-plan bullets", () => {
		const text = raw("plan");
		expect(text).toContain("## Output of this phase");
		expect(text).toContain("merge_plan");
	});

	it("delegate.md still has its full content, including what-is-never-delegated", () => {
		expect(raw("delegate")).toContain("## What is never delegated downward");
	});

	it("supervise.md still has its Integrate-before-reviewing heading", () => {
		expect(raw("supervise")).toContain("## Integrate before reviewing");
	});

	it("escalate.md still lists both automatic-in-the-harness triggers", () => {
		const text = raw("escalate");
		expect(text).toContain("Verify has sent the same task back a second consecutive time");
		expect(text).toContain("implementer has reported a spec gap or contradiction more than once");
	});

	it("deliver.md still has the conventional-commit bullet", () => {
		expect(raw("deliver")).toContain("Use the conventional-commit skill for every commit message.");
	});

	it("artifacts.md still has its full field-list content and Why this matters", () => {
		const text = raw("artifacts");
		expect(text).toContain("## Why this matters");
		expect(text).toContain("attempt_number");
	});

	it("SKILL.md still has the harness note plus its full standalone flow", () => {
		const text = raw("../SKILL");
		expect(text).toContain("re-run this skill's flow manually");
		expect(text).toContain("## The flow");
	});
});

// ---------------------------------------------------------------------------
// Measure: the harness-stripped prompt is shorter than an unstripped one would be, per phase.
// ---------------------------------------------------------------------------

describe("stripping measurably shrinks phase prompts", () => {
	it("logs before/after character counts per phase and asserts stripped <= unstripped", () => {
		const phases = ["analyze", "plan", "delegate", "supervise", "verify", "deliver"] as const;
		const rows: string[] = [];
		for (const phase of phases) {
			const state = stateInPhase(phase);
			const stripped = phasePrompt(state);
			const references = referencesForPhase(state);
			const unstrippedRefs = references.map((name) => readReference(name, { harness: false })).join("\n");
			const strippedRefs = references.map((name) => readReference(name, { harness: true })).join("\n");
			const unstrippedLen = stripped.length - strippedRefs.length + unstrippedRefs.length;
			rows.push(`${phase}: stripped=${stripped.length} chars, unstripped=${unstrippedLen} chars`);
			expect(stripped.length).toBeLessThanOrEqual(unstrippedLen);
		}
		// eslint-disable-next-line no-console
		console.log(`Phase prompt sizes (harness-stripped vs unstripped references):\n${rows.join("\n")}`);
	});
});

describe("parallel delegation guidance", () => {
	it("tells the Plan phase to split work by folder and give every sub-agent task paths", () => {
		const text = phasePrompt(stateInPhase("plan"));
		expect(text).toContain("Split work by folder");
		expect(text).toContain("`paths`");
		expect(text).toContain("requires_main_tree");
		expect(text).toContain("overlapping independent tasks are rejected");
	});

	it("keeps the paths bullet in plan.md for standalone use, and strips only the enforced rejection sentence", () => {
		const raw = readReference("plan", { harness: false });
		expect(raw).toContain("Give each task the `paths` it may change");
		expect(raw).toContain("Independent tasks whose paths overlap are rejected");
		const injected = readReference("plan");
		expect(injected).toContain("Give each task the `paths` it may change");
		expect(injected).not.toContain("Independent tasks whose paths overlap are rejected");
	});

	it("lists runs that changed files outside their declared paths in supervise", () => {
		const state = stateInPhase("supervise", {
			runs: [
				{ task_id: "t1", status: "succeeded", out_of_scope: ["stray.txt", "docs/x.md"] },
				{ task_id: "t2", status: "succeeded" },
			],
		});
		const text = phasePrompt(state);
		expect(text).toContain("outside their declared paths");
		expect(text).toContain("t1 (stray.txt, docs/x.md)");
		expect(text).not.toContain("t2 (");
	});
});
