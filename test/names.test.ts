import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRunLabel, generateRunSlug } from "../extensions/code-changes/names.ts";
import { newState } from "../extensions/code-changes/state.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("generateRunSlug", () => {
	it("derives an ordinary task slug while removing request boilerplate", () => {
		expect(generateRunSlug("Implement friendlier run slugs", "abc123")).toBe("friendlier-run-slugs");
	});

	it("makes the motivating conversational request recognizable", () => {
		expect(
			generateRunSlug("Currently the runs have a really weird name but we should be able to create more interesting slug names for these, no?", "abc123"),
		).toBe("runs-weird-name-interesting-slug");
	});

	it("normalizes mixed case and punctuation", () => {
		expect(generateRunSlug("Fix: LOGIN errors... NOW!", "abc123")).toBe("login-errors-now");
	});

	it("normalizes accented Unicode to lowercase ASCII", () => {
		expect(generateRunSlug("Crème brûlée déjà vu", "abc123")).toBe("creme-brulee-deja-vu");
	});

	it("removes duplicate tokens while preserving their first occurrence", () => {
		expect(generateRunSlug("slug name slug run name", "abc123")).toBe("slug-name-run");
	});

	it("filters filler while retaining run, name, and slug as subject words", () => {
		expect(generateRunSlug("Please can you help me create the run name slug", "abc123")).toBe("run-name-slug");
	});

	it("uses at most five useful tokens", () => {
		expect(generateRunSlug("one two three four five six seven", "abc123")).toBe("one-two-three-four-five");
	});

	it("caps the slug at 48 characters without a trailing hyphen", () => {
		const slug = generateRunSlug("abcdefghijklmnopqrst uvwxyzabcdefghij klmnopqrstuvwx yzabcdefghij", "abc123");
		expect(slug.length).toBe(48);
		expect(slug).not.toMatch(/-$/);
	});

	it.each(["", "!?! ---", "please can you help me implement this"])("falls back for unusable task text %j", (task) => {
		expect(generateRunSlug(task, "abc123xyz")).toBe("run-123xyz");
	});

	it("uses the full ID in the fallback when it is shorter than six characters", () => {
		expect(generateRunSlug("...", "xy9")).toBe("run-xy9");
	});
});

describe("formatRunLabel", () => {
	it("prefers the slug and appends a short ID correlation suffix", () => {
		expect(formatRunLabel({ id: "muprn2y8", slug: "friendlier-run-slugs" })).toBe("friendlier-run-slugs · n2y8");
	});

	it("falls back to the complete raw ID for legacy and empty slugs", () => {
		expect(formatRunLabel({ id: "muprn2y8" })).toBe("muprn2y8");
		expect(formatRunLabel({ id: "muprn2y8", slug: "  " })).toBe("muprn2y8");
	});
});

describe("newState run identity", () => {
	it("keeps the timestamp ID and synchronously stores its task-derived slug", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const state = newState("Add friendlier run slugs", ["read"], "deadbeef");
		expect(state.id).toBe((1_700_000_000_000).toString(36));
		expect(state.slug).toBe("friendlier-run-slugs");
	});
});
