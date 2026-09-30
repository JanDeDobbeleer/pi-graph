import { describe, expect, it } from "vitest";
import { independent, matchesAnyPath, normalizePath, pathsOverlap } from "../extensions/code-changes/paths.ts";
import { effectiveWorkspace, planWorkspaces, worktreeTaskIds } from "../extensions/code-changes/planning.ts";
import type { PlanTask } from "../extensions/code-changes/state.ts";

function task(overrides: Partial<PlanTask> & Pick<PlanTask, "id">): PlanTask {
	return {
		spec: "s",
		verification_commands: ["true"],
		executor_tier: "implementer",
		workspace: "main",
		dependencies: [],
		paths: [`src/${overrides.id}/`],
		...overrides,
	};
}

describe("normalizePath", () => {
	it("converts backslashes and collapses separators", () => {
		expect(normalizePath("src\\segments\\gcp.go")).toBe("src/segments/gcp.go");
		expect(normalizePath("src//segments///gcp.go")).toBe("src/segments/gcp.go");
	});

	it("drops leading ./, inner ./ segments and trailing slashes", () => {
		expect(normalizePath("./src/a/")).toBe("src/a");
		expect(normalizePath("src/./a")).toBe("src/a");
		expect(normalizePath(" src/a\\ ")).toBe("src/a");
	});

	it("turns . and ./ into the empty (everything) pattern", () => {
		expect(normalizePath(".")).toBe("");
		expect(normalizePath("./")).toBe("");
		expect(normalizePath("")).toBe("");
	});
});

describe("pathsOverlap", () => {
	const table: Array<[string, string[], string[], boolean]> = [
		["equal files", ["src/a.go"], ["src/a.go"], true],
		["directory prefix", ["src/"], ["src/a/"], true],
		["directory prefix (reversed)", ["src/a/"], ["src/"], true],
		["file inside a directory", ["src/segments/"], ["src/segments/gcp.go"], true],
		["directory without slash is still a directory", ["src/segments"], ["src/segments/gcp.go"], true],
		["disjoint siblings", ["src/a/"], ["src/b/"], false],
		["name prefix is not a directory prefix", ["src/a"], ["src/ab"], false],
		["name prefix is not a directory prefix (trailing slash)", ["src/a/"], ["src/ab/"], false],
		["file vs different file in same folder", ["src/a.go"], ["src/b.go"], false],
		["docs vs src", ["website/docs/segments/cloud/gcp.mdx"], ["src/segments/"], false],
		["glob vs directory containing it", ["src/**/*_test.go"], ["src/segments/"], true],
		["glob vs unrelated directory", ["src/**/*_test.go"], ["website/"], false],
		["glob vs file under its prefix", ["src/segments/*.go"], ["src/segments/gcp.go"], true],
		["glob vs file outside its prefix", ["src/segments/*.go"], ["src/other/gcp.go"], false],
		["two globs in different folders", ["src/*.go"], ["docs/*.md"], false],
		["two globs in the same folder", ["src/**/*.go"], ["src/**/*_test.go"], true],
		["partial-name glob keeps the parent as prefix", ["src/a*"], ["src/b/"], true],
		["** means everything", ["**"], ["src/a/"], true],
		["dot means everything", ["."], ["docs/x.md"], true],
		["empty means everything", [""], ["docs/x.md"], true],
		["./ means everything", ["./"], ["docs/x.md"], true],
		["root glob overlaps conservatively", ["*.md"], ["src/a/"], true],
		["Windows backslashes", ["src\\a\\"], ["src/a/file.go"], true],
		["Windows backslashes, disjoint", ["src\\a\\"], ["src/b/file.go"], false],
		["any pair of many overlaps", ["docs/", "src/a/"], ["lib/", "src/a/x.go"], true],
		["no pair of many overlaps", ["docs/", "src/a/"], ["lib/", "src/b/x.go"], false],
		["empty list overlaps nothing", [], ["src/"], false],
	];

	for (const [name, a, b, expected] of table) {
		it(`${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)} -> ${expected}`, () => {
			expect(pathsOverlap(a, b)).toBe(expected);
			expect(pathsOverlap(b, a)).toBe(expected);
		});
	}
});

describe("matchesAnyPath", () => {
	it("matches a file exactly and by directory subtree", () => {
		expect(matchesAnyPath("src/a.go", ["src/a.go"])).toBe(true);
		expect(matchesAnyPath("src/a/b/c.go", ["src/a/"])).toBe(true);
		expect(matchesAnyPath("src/a/b/c.go", ["src/a"])).toBe(true);
		expect(matchesAnyPath("src/ab/c.go", ["src/a"])).toBe(false);
		expect(matchesAnyPath("src/a.go", ["src/b/"])).toBe(false);
	});

	it("keeps * inside a path segment", () => {
		expect(matchesAnyPath("src/a_test.go", ["src/*_test.go"])).toBe(true);
		expect(matchesAnyPath("src/deep/a_test.go", ["src/*_test.go"])).toBe(false);
		expect(matchesAnyPath("src/a.go", ["src/*_test.go"])).toBe(false);
	});

	it("lets ** cross segments", () => {
		expect(matchesAnyPath("src/a/b/c_test.go", ["src/**/*_test.go"])).toBe(true);
		expect(matchesAnyPath("src/c_test.go", ["src/**/*_test.go"])).toBe(true);
		expect(matchesAnyPath("lib/c_test.go", ["src/**/*_test.go"])).toBe(false);
		expect(matchesAnyPath("src/deep/x.txt", ["src/**"])).toBe(true);
		expect(matchesAnyPath("anything/at/all", ["**"])).toBe(true);
	});

	it("supports ? as one non-separator character", () => {
		expect(matchesAnyPath("src/a1.go", ["src/a?.go"])).toBe(true);
		expect(matchesAnyPath("src/a12.go", ["src/a?.go"])).toBe(false);
	});

	it("treats . and empty patterns as everything", () => {
		expect(matchesAnyPath("x/y.go", ["."])).toBe(true);
		expect(matchesAnyPath("x/y.go", [""])).toBe(true);
	});

	it("normalizes Windows separators on both sides", () => {
		expect(matchesAnyPath("src\\a\\b.go", ["src/a/"])).toBe(true);
		expect(matchesAnyPath("src/a/b.go", ["src\\a\\"])).toBe(true);
	});

	it("does not treat regex metacharacters in patterns specially", () => {
		expect(matchesAnyPath("src/a.b/c.go", ["src/a.b/**"])).toBe(true);
		expect(matchesAnyPath("src/aXb/c.go", ["src/a.b/**"])).toBe(false);
	});

	it("returns false for an empty pattern list", () => {
		expect(matchesAnyPath("src/a.go", [])).toBe(false);
	});
});

describe("independent", () => {
	const tasks = [
		task({ id: "a" }),
		task({ id: "b", dependencies: ["a"] }),
		task({ id: "c", dependencies: ["b"] }),
		task({ id: "d" }),
	];

	it("is false for a direct dependency, either way", () => {
		expect(independent(tasks[0], tasks[1], tasks)).toBe(false);
		expect(independent(tasks[1], tasks[0], tasks)).toBe(false);
	});

	it("is false for a transitive dependency, either way", () => {
		expect(independent(tasks[0], tasks[2], tasks)).toBe(false);
		expect(independent(tasks[2], tasks[0], tasks)).toBe(false);
	});

	it("is true for unrelated tasks, and accepts ids", () => {
		expect(independent(tasks[0], tasks[3], tasks)).toBe(true);
		expect(independent("c", "d", tasks)).toBe(true);
	});
});

describe("effectiveWorkspace", () => {
	it("keeps a lone main task in the main tree", () => {
		const plan = { tasks: [task({ id: "a" })] };
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("main");
	});

	it("moves independent main tasks with disjoint paths into worktrees", () => {
		const plan = { tasks: [task({ id: "a" }), task({ id: "b" })] };
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("worktree");
		expect(effectiveWorkspace(plan.tasks[1], plan)).toBe("worktree");
		expect(planWorkspaces(plan).get("a")?.auto).toBe(true);
		expect(worktreeTaskIds(plan)).toEqual(["a", "b"]);
	});

	it("keeps a requires_main_tree task in the main tree but still moves its peer", () => {
		const plan = { tasks: [task({ id: "a", requires_main_tree: true }), task({ id: "b" })] };
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("main");
		expect(effectiveWorkspace(plan.tasks[1], plan)).toBe("worktree");
	});

	it("never counts a coordinator-direct task as a parallel peer", () => {
		const plan = { tasks: [task({ id: "a" }), task({ id: "b", executor_tier: "coordinator-direct" })] };
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("main");
		expect(worktreeTaskIds(plan)).toEqual([]);
	});

	it("does not move tasks that sit in different waves", () => {
		const plan = { tasks: [task({ id: "a" }), task({ id: "b", dependencies: ["a"] })] };
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("main");
		expect(effectiveWorkspace(plan.tasks[1], plan)).toBe("main");
	});

	it("moves a dependent along with the moved tasks it builds on, so it can merge their branches", () => {
		const plan = {
			tasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c", dependencies: ["a", "b"], paths: ["src/c/"] })],
		};
		expect(effectiveWorkspace(plan.tasks[2], plan)).toBe("worktree");
	});

	it("keeps a chain in the main tree when a later task requires the main tree", () => {
		const plan = {
			tasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c", dependencies: ["a", "b"], requires_main_tree: true })],
		};
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("main");
		expect(effectiveWorkspace(plan.tasks[1], plan)).toBe("main");
	});

	it("leaves an explicit worktree task in a worktree, and does not move a peer with overlapping paths", () => {
		const plan = {
			tasks: [task({ id: "a", workspace: "worktree" }), task({ id: "b", paths: ["src/a/"] })],
		};
		expect(effectiveWorkspace(plan.tasks[0], plan)).toBe("worktree");
		expect(effectiveWorkspace(plan.tasks[1], plan)).toBe("main");
	});
});
