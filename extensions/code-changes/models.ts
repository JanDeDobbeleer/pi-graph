/**
 * Tier -> provider/model mapping for the code-changes workflow, configurable per-user and
 * per-project. Pure logic only; index.ts owns the `pi.setModel(...)` calls.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_PARALLEL } from "./delegate.ts";
import type { ExecutorTier, Tier } from "./state.ts";

/** "provider/modelId" strings. "session" (or undefined for coordinator) keeps the current session model. */
export interface TierConfig {
	escalation?: string;
	coordinator?: string;
	implementer?: string;
	trivial?: string;
}

export const DEFAULT_TIERS: TierConfig = {
	escalation: "anthropic/claude-fable-5-1",
	coordinator: "session",
	implementer: "anthropic/claude-sonnet-5",
	trivial: "anthropic/claude-haiku-4-5",
};

/** Extra read-only tools (from other extensions) activated alongside PHASE_TOOLS in Analyze/Plan/Supervise/Verify. `*` globs allowed. */
export const DEFAULT_READ_ONLY_TOOLS: string[] = ["web_fetch", "webfetch", "fetch", "web_search", "websearch", "search"];

/** The full shape of a code-changes.json config file: `tiers` plus the sibling `readOnlyTools` list. */
interface CodeChangesConfig {
	tiers?: TierConfig;
	readOnlyTools?: unknown;
	maxParallel?: unknown;
	gateLog?: unknown;
	gateAdvisor?: unknown;
}

function readConfigFile(file: string): CodeChangesConfig | undefined {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw) as CodeChangesConfig;
		if (parsed && typeof parsed === "object") return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

function userConfigPath(home: string): string {
	return path.join(home, ".pi", "agent", "code-changes.json");
}

function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "code-changes.json");
}

/**
 * Merge DEFAULT_TIERS <- ~/.pi/agent/code-changes.json <- <cwd>/.pi/code-changes.json.
 * Missing or invalid config files are ignored, never thrown.
 */
export function loadTierConfig(cwd: string, home: string = os.homedir()): TierConfig {
	const userConfig = readConfigFile(userConfigPath(home));
	const projectConfig = readConfigFile(projectConfigPath(cwd));
	return {
		...DEFAULT_TIERS,
		...(userConfig?.tiers && typeof userConfig.tiers === "object" ? userConfig.tiers : {}),
		...(projectConfig?.tiers && typeof projectConfig.tiers === "object" ? projectConfig.tiers : {}),
	};
}

function normalizeToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

/**
 * Union DEFAULT_READ_ONLY_TOOLS <- ~/.pi/agent/code-changes.json's `readOnlyTools` <-
 * <cwd>/.pi/code-changes.json's `readOnlyTools`. Entries (names or `*` globs) are merged, never
 * replaced, so a project can add to the user's list without repeating it. Missing or invalid
 * config files are ignored, never thrown.
 */
export function loadReadOnlyTools(cwd: string, home: string = os.homedir()): string[] {
	const userConfig = readConfigFile(userConfigPath(home));
	const projectConfig = readConfigFile(projectConfigPath(cwd));
	const merged = new Set<string>([
		...DEFAULT_READ_ONLY_TOOLS,
		...normalizeToolNames(userConfig?.readOnlyTools),
		...normalizeToolNames(projectConfig?.readOnlyTools),
	]);
	return [...merged];
}

export { DEFAULT_MAX_PARALLEL };

function validMaxParallel(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16 ? value : undefined;
}

/**
 * `maxParallel` (an integer 1..16, default 4) from ~/.pi/agent/code-changes.json, overridden by
 * <cwd>/.pi/code-changes.json. Missing, invalid or out-of-range values are ignored, never thrown.
 */
export function loadMaxParallel(cwd: string, home: string = os.homedir()): number {
	const userConfig = readConfigFile(userConfigPath(home));
	const projectConfig = readConfigFile(projectConfigPath(cwd));
	return validMaxParallel(projectConfig?.maxParallel) ?? validMaxParallel(userConfig?.maxParallel) ?? DEFAULT_MAX_PARALLEL;
}

/** Default gate-decision log: one JSON line per human decision at the analysis/plan gates, across projects. */
export function defaultGateLogPath(home: string = os.homedir()): string {
	return path.join(home, ".pi", "agent", "code-changes", "gate-decisions.jsonl");
}

/**
 * Where gate decisions are appended: `gateLog` from the project file, else the user file, else
 * the default path. `false` turns the file log off (decisions still land in the session). A
 * relative path resolves against the file's own base (cwd for the project file, home for the user file).
 */
export function loadGateLogPath(cwd: string, home: string = os.homedir()): string | undefined {
	const resolve = (value: unknown, base: string): string | false | undefined => {
		if (value === false) return false;
		if (typeof value === "string" && value.trim()) return path.resolve(base, value.trim());
		return undefined;
	};
	const project = resolve(readConfigFile(projectConfigPath(cwd))?.gateLog, cwd);
	const user = resolve(readConfigFile(userConfigPath(home))?.gateLog, home);
	const chosen = project ?? user ?? defaultGateLogPath(home);
	return chosen === false ? undefined : chosen;
}

/** Raw `gateAdvisor` block (project file wins over the user file); gateadvisor.ts validates it. */
export function loadGateAdvisorRaw(cwd: string, home: string = os.homedir()): unknown {
	return readConfigFile(projectConfigPath(cwd))?.gateAdvisor ?? readConfigFile(userConfigPath(home))?.gateAdvisor;
}

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
	const index = ref.indexOf("/");
	if (index <= 0 || index === ref.length - 1) return undefined;
	return { provider: ref.slice(0, index), id: ref.slice(index + 1) };
}

export interface ResolvedTierModel {
	model: Model<any> | undefined;
	ref: string | undefined;
	fellBack: boolean;
}

/**
 * Resolve the configured model for a tier. "session"/undefined falls back to the current
 * session model without treating it as a failed lookup. An unresolvable model reference also
 * falls back, but with `fellBack: true` so callers can warn.
 */
export function resolveTierModel(
	registry: Pick<ModelRegistry, "find">,
	config: TierConfig,
	tier: Tier,
	fallback: Model<any> | undefined,
): ResolvedTierModel {
	const ref = config[tier];
	if (ref === undefined || ref === "session") {
		return { model: fallback, ref: undefined, fellBack: false };
	}

	const parsed = parseModelRef(ref);
	if (!parsed) {
		return { model: fallback, ref, fellBack: true };
	}

	const found = registry.find(parsed.provider, parsed.id);
	if (!found) {
		return { model: fallback, ref, fellBack: true };
	}

	return { model: found, ref, fellBack: false };
}

export function tierForExecutor(t: ExecutorTier): Tier {
	switch (t) {
		case "trivial":
			return "trivial";
		case "implementer":
			return "implementer";
		case "coordinator-direct":
			return "coordinator";
	}
}

export function modelRef(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}
