import { describe, it, expect } from "vitest";
import { formatPlan, type PlanExecutionOptions } from "../extensions/code-changes/artifacts.ts";
import { DEFAULT_MAX_PARALLEL } from "../extensions/code-changes/delegate.ts";
import type { PlanTask, TaskList } from "../extensions/code-changes/state.ts";

function task(overrides: Partial<PlanTask> & { id: string }): PlanTask {
	return {
		spec: "do the work",
		verification_commands: ["npm test"],
		executor_tier: "implementer",
		workspace: "main",
		dependencies: [],
		paths: [`src/${overrides.id}/`],
		...overrides,
	};
}

const models: PlanExecutionOptions["models"] = {
	implementer: "anthropic/claude-sonnet-5",
	trivial: "anthropic/claude-haiku-4-5",
};

/** segment (implementer) + docs (trivial) in parallel, then schema by the coordinator. */
function examplePlan(): TaskList {
	return {
		tasks: [
			task({ id: "segment", paths: ["src/segments/"], verification_commands: ["go test ./segments/...", "golangci-lint run"] }),
			task({ id: "docs", executor_tier: "trivial", paths: ["website/docs/segments/"], verification_commands: ["markdownlint"] }),
			task({ id: "schema", executor_tier: "coordinator-direct", paths: ["themes/schema.json"], dependencies: ["segment"], verification_commands: [] }),
		],
	};
}

function section(md: string): string {
	const start = md.indexOf("## Execution");
	const end = md.indexOf("## Task ");
	return md.slice(start, end);
}

describe("formatPlan Execution section", () => {
	it("renders the example plan", () => {
		const md = formatPlan(examplePlan(), { execution: { models, maxParallel: 4 } });
		const exec = section(md);
		expect(exec).toContain("3 tasks · 2 waves · up to 4 at once · 2 in worktrees (2 moved from main) · 1 by the coordinator");
		expect(exec).toContain("### Wave 1 — parallel");
		expect(exec).toContain("| task | runs on | workspace | paths |");
		expect(exec).toContain("| segment | implementer → anthropic/claude-sonnet-5 | worktree (moved from main) | `src/segments/` |");
		expect(exec).toContain("| docs | trivial → anthropic/claude-haiku-4-5 | worktree (moved from main) | `website/docs/segments/` |");
		expect(exec).toContain("### Wave 2 — after segment");
		expect(exec).toContain("| schema | coordinator → session model | main (in Supervise) | `themes/schema.json` |");
		expect(exec).toContain(
			"**Then:** squash-merge segment → docs · Supervise reviews the merged diff and implements schema · Verify runs 3 gates on the merged state (`go test ./segments/...`, `golangci-lint run`, `markdownlint`) · Deliver",
		);
	});

	it("puts Execution before the task details and drops the old sections", () => {
		const md = formatPlan(examplePlan());
		expect(md.indexOf("## Execution")).toBeGreaterThan(-1);
		expect(md.indexOf("## Execution")).toBeLessThan(md.indexOf("## Task segment"));
		expect(md).not.toContain("## Parallelism");
		expect(md).not.toContain("## Merge plan");
	});

	it("shows only tiers and the default cap without execution options", () => {
		const exec = section(formatPlan(examplePlan()));
		expect(exec).toContain(`up to ${DEFAULT_MAX_PARALLEL} at once`);
		expect(exec).toContain("| segment | implementer | worktree (moved from main) |");
		expect(exec).toContain("| schema | coordinator | main (in Supervise) |");
		expect(exec).not.toContain("→ session model");
	});

	it("marks explicit worktrees and shows the merge plan conflict owner", () => {
		const plan: TaskList = {
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", workspace: "worktree" })],
			merge_plan: { order: ["b", "a"], conflict_owner: "coordinator" },
		};
		const exec = section(formatPlan(plan));
		expect(exec).toContain("| a | implementer | worktree | `src/a/` |");
		expect(exec).toContain("2 in worktrees");
		expect(exec).not.toContain("moved from main");
		expect(exec).toContain("squash-merge b → a (conflicts: coordinator)");
	});

	it("says nothing to merge for a single task and lists no worktrees", () => {
		const exec = section(formatPlan({ tasks: [task({ id: "solo" })] }));
		expect(exec).toContain("1 task · 1 wave");
		expect(exec).toContain("nothing to merge");
		expect(exec).toContain("1 in the main tree");
		expect(exec).not.toContain("### Wave 1 —");
	});

	it("adds a concurrency note when a wave exceeds maxParallel", () => {
		const tasks = Array.from({ length: 6 }, (_, i) => task({ id: `t${i}` }));
		const exec = section(formatPlan({ tasks }, { execution: { models, maxParallel: 4 } }));
		expect(exec).toContain("### Wave 1 — parallel");
		expect(exec).toContain("_6 tasks, 4 at a time_");
	});

	it("warns about fallback models and a dirty main tree", () => {
		const exec = section(
			formatPlan(examplePlan(), { execution: { models: { trivial: "x/missing" }, maxParallel: 4, fellBack: ["trivial"], mainTreeDirty: true } }),
		);
		expect(exec).toContain("**Heads-up:**");
		expect(exec).toContain("no API key/login for its provider");
		expect(exec).toContain("`trivial`");
		expect(exec).toContain("| docs | trivial → x/missing (fallback) |");
		expect(exec).toContain("uncommitted changes");
		const clean = section(formatPlan(examplePlan(), { execution: { models, maxParallel: 4, mainTreeDirty: false } }));
		expect(clean).not.toContain("Heads-up");
	});

	it("labels sequential main-tree waves and warns when they are forced", () => {
		const plan: TaskList = {
			tasks: [task({ id: "a", requires_main_tree: true }), task({ id: "b", requires_main_tree: true })],
		};
		const exec = section(formatPlan(plan));
		expect(exec).toContain("### Wave 1 — one after another (main tree)");
		expect(exec).toContain("| a | implementer | main (requires main tree) |");
		expect(exec).toContain("**Heads-up:**");
		expect(exec).toContain("wave 1: a, b stay in the main tree and run one after another");
	});

	it("combines parallel with after-suffix and escapes pipes in cells", () => {
		const plan: TaskList = {
			tasks: [
				task({ id: "root", paths: ["root/"] }),
				task({ id: "x", dependencies: ["root"], paths: ["a|b/"] }),
				task({ id: "y", dependencies: ["root"], paths: ["y/"] }),
			],
		};
		const exec = section(formatPlan(plan));
		expect(exec).toContain("### Wave 2 — parallel, after root");
		expect(exec).toContain("`a\\|b/`");
	});

	it("truncates the gate list after six", () => {
		const plan: TaskList = {
			tasks: [task({ id: "a", verification_commands: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"] })],
		};
		const exec = section(formatPlan(plan));
		expect(exec).toContain("Verify runs 8 gates");
		expect(exec).toContain("`c6`, +2 more");
		expect(exec).not.toContain("`c7`");
	});
});
