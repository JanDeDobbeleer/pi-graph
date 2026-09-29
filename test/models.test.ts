import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_READ_ONLY_TOOLS,
	DEFAULT_TIERS,
	loadReadOnlyTools,
	loadTierConfig,
	modelRef,
	parseModelRef,
	resolveTierModel,
	tierForExecutor,
} from "../extensions/code-changes/models.ts";

describe("parseModelRef", () => {
	it("splits provider and id on the first slash", () => {
		expect(parseModelRef("anthropic/claude-sonnet-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });
	});

	it("keeps the remainder intact when the id itself contains slashes", () => {
		expect(parseModelRef("openai/gpt-5/high")).toEqual({ provider: "openai", id: "gpt-5/high" });
	});

	it("returns undefined for a malformed ref", () => {
		expect(parseModelRef("no-slash-here")).toBeUndefined();
		expect(parseModelRef("/leading-slash")).toBeUndefined();
		expect(parseModelRef("trailing-slash/")).toBeUndefined();
	});
});

describe("loadTierConfig", () => {
	let homeDir: string;
	let cwdDir: string;

	beforeEach(() => {
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"));
		cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
	});

	afterEach(() => {
		fs.rmSync(homeDir, { recursive: true, force: true });
		fs.rmSync(cwdDir, { recursive: true, force: true });
	});

	it("falls back to defaults when no config files exist", () => {
		expect(loadTierConfig(cwdDir, homeDir)).toEqual(DEFAULT_TIERS);
	});

	it("merges user config over defaults", () => {
		fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(homeDir, ".pi", "agent", "code-changes.json"), JSON.stringify({ tiers: { trivial: "openai/gpt-4.1-mini" } }));

		const config = loadTierConfig(cwdDir, homeDir);
		expect(config.trivial).toBe("openai/gpt-4.1-mini");
		expect(config.escalation).toBe(DEFAULT_TIERS.escalation);
	});

	it("merges project config over user config over defaults", () => {
		fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(homeDir, ".pi", "agent", "code-changes.json"),
			JSON.stringify({ tiers: { trivial: "openai/gpt-4.1-mini", implementer: "openai/gpt-5" } }),
		);
		fs.mkdirSync(path.join(cwdDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, ".pi", "code-changes.json"), JSON.stringify({ tiers: { trivial: "google/gemini-flash-lite" } }));

		const config = loadTierConfig(cwdDir, homeDir);
		expect(config.trivial).toBe("google/gemini-flash-lite");
		expect(config.implementer).toBe("openai/gpt-5");
		expect(config.escalation).toBe(DEFAULT_TIERS.escalation);
	});

	it("ignores invalid JSON instead of throwing", () => {
		fs.mkdirSync(path.join(cwdDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, ".pi", "code-changes.json"), "{ not json");

		expect(() => loadTierConfig(cwdDir, homeDir)).not.toThrow();
		expect(loadTierConfig(cwdDir, homeDir)).toEqual(DEFAULT_TIERS);
	});
});

describe("loadReadOnlyTools", () => {
	let homeDir: string;
	let cwdDir: string;

	beforeEach(() => {
		homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ro-home-"));
		cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ro-cwd-"));
	});

	afterEach(() => {
		fs.rmSync(homeDir, { recursive: true, force: true });
		fs.rmSync(cwdDir, { recursive: true, force: true });
	});

	it("falls back to the default list when no config files exist", () => {
		expect(loadReadOnlyTools(cwdDir, homeDir)).toEqual(DEFAULT_READ_ONLY_TOOLS);
	});

	it("unions user config into the default list instead of replacing it", () => {
		fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(homeDir, ".pi", "agent", "code-changes.json"), JSON.stringify({ readOnlyTools: ["mcp__docs__*"] }));

		const tools = loadReadOnlyTools(cwdDir, homeDir);
		expect(tools).toEqual(expect.arrayContaining([...DEFAULT_READ_ONLY_TOOLS, "mcp__docs__*"]));
	});

	it("unions project config on top of user config and defaults, preserving glob entries", () => {
		fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(homeDir, ".pi", "agent", "code-changes.json"), JSON.stringify({ readOnlyTools: ["mcp__docs__*"] }));
		fs.mkdirSync(path.join(cwdDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, ".pi", "code-changes.json"), JSON.stringify({ readOnlyTools: ["mcp__notion__*", "web_fetch"] }));

		const tools = loadReadOnlyTools(cwdDir, homeDir);
		expect(tools).toEqual(expect.arrayContaining([...DEFAULT_READ_ONLY_TOOLS, "mcp__docs__*", "mcp__notion__*"]));
		// "web_fetch" is already a default, so the union must not duplicate it.
		expect(tools.filter((t) => t === "web_fetch")).toHaveLength(1);
	});

	it("ignores invalid JSON instead of throwing", () => {
		fs.mkdirSync(path.join(cwdDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, ".pi", "code-changes.json"), "{ not json");

		expect(() => loadReadOnlyTools(cwdDir, homeDir)).not.toThrow();
		expect(loadReadOnlyTools(cwdDir, homeDir)).toEqual(DEFAULT_READ_ONLY_TOOLS);
	});

	it("ignores a non-array readOnlyTools value", () => {
		fs.mkdirSync(path.join(cwdDir, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwdDir, ".pi", "code-changes.json"), JSON.stringify({ readOnlyTools: "not-an-array" }));

		expect(loadReadOnlyTools(cwdDir, homeDir)).toEqual(DEFAULT_READ_ONLY_TOOLS);
	});
});

describe("resolveTierModel", () => {
	const sessionModel = { provider: "anthropic", id: "claude-sonnet-5" } as any;
	const fakeRegistry = {
		find(provider: string, id: string) {
			if (provider === "anthropic" && id === "claude-fable-5-1") {
				return { provider, id } as any;
			}
			return undefined;
		},
	};

	it("keeps the session model for 'session'", () => {
		const result = resolveTierModel(fakeRegistry, { coordinator: "session" }, "coordinator", sessionModel);
		expect(result).toEqual({ model: sessionModel, ref: undefined, fellBack: false });
	});

	it("keeps the session model when the tier is unset", () => {
		const result = resolveTierModel(fakeRegistry, {}, "coordinator", sessionModel);
		expect(result).toEqual({ model: sessionModel, ref: undefined, fellBack: false });
	});

	it("resolves a configured model that exists in the registry", () => {
		const result = resolveTierModel(fakeRegistry, { escalation: "anthropic/claude-fable-5-1" }, "escalation", sessionModel);
		expect(result.fellBack).toBe(false);
		expect(result.model).toEqual({ provider: "anthropic", id: "claude-fable-5-1" });
		expect(result.ref).toBe("anthropic/claude-fable-5-1");
	});

	it("falls back to the session model when the configured model is not found", () => {
		const result = resolveTierModel(fakeRegistry, { escalation: "anthropic/does-not-exist" }, "escalation", sessionModel);
		expect(result).toEqual({ model: sessionModel, ref: "anthropic/does-not-exist", fellBack: true });
	});

	it("falls back when the ref is malformed", () => {
		const result = resolveTierModel(fakeRegistry, { trivial: "not-a-ref" }, "trivial", sessionModel);
		expect(result.fellBack).toBe(true);
		expect(result.model).toBe(sessionModel);
	});
});

describe("tierForExecutor", () => {
	it("maps executor tiers to model tiers", () => {
		expect(tierForExecutor("trivial")).toBe("trivial");
		expect(tierForExecutor("implementer")).toBe("implementer");
		expect(tierForExecutor("coordinator-direct")).toBe("coordinator");
	});
});

describe("modelRef", () => {
	it("formats provider/id", () => {
		expect(modelRef({ provider: "anthropic", id: "claude-sonnet-5" } as any)).toBe("anthropic/claude-sonnet-5");
	});
});
