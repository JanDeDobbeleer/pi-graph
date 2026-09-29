/**
 * Tool gating for the code-changes workflow.
 *
 * Pure functions only — no pi runtime calls. `index.ts` wires `decideToolCall` into the
 * `tool_call` event handler and uses `toolsForPhase` to drive `pi.setActiveTools(...)` on
 * every phase transition.
 */

import { PHASE_LABEL, type Phase, type WorkflowState } from "./state.ts";

/** Extension tools registered elsewhere (artifacts.ts / delegate.ts / index.ts). */
export const WORKFLOW_TOOLS: string[] = [
	"submit_analysis",
	"submit_plan",
	"run_delegation",
	"submit_review",
	"run_gates",
	"submit_verification",
	"submit_delivery",
	"escalate",
	"resume_task",
];

/** Tools the model may call while in each phase. */
export const PHASE_TOOLS: Record<Phase, string[]> = {
	analyze: ["read", "grep", "find", "ls", "bash", "powershell", "escalate", "submit_analysis"],
	awaiting_approval: ["read", "grep", "find", "ls"],
	plan: ["read", "grep", "find", "ls", "bash", "powershell", "submit_plan"],
	awaiting_plan_approval: ["read", "grep", "find", "ls"],
	delegate: ["read", "run_delegation"],
	supervise: ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "escalate", "resume_task", "submit_review"],
	verify: ["read", "grep", "find", "ls", "bash", "powershell", "run_gates", "escalate", "submit_verification"],
	deliver: ["read", "grep", "ls", "bash", "powershell", "submit_delivery"],
	// CI checks are running for the PR opened/pushed to in Deliver; the model is idle while the
	// harness watches, so only read-only inspection tools are available.
	ci: ["read", "grep", "find", "ls"],
	done: [],
	stopped: [],
};

/** The artifact tool that ends each phase (undefined where the exit is not a tool call). */
export const PHASE_ARTIFACT_TOOL: Record<Phase, string | undefined> = {
	analyze: "submit_analysis",
	awaiting_approval: undefined,
	plan: "submit_plan",
	awaiting_plan_approval: undefined,
	delegate: "run_delegation",
	supervise: "submit_review",
	verify: "submit_verification",
	deliver: "submit_delivery",
	// No tool ends "ci": the harness's CI watcher transitions the run when checks resolve.
	ci: undefined,
	done: undefined,
	stopped: undefined,
};

/** Phases where bash/powershell are restricted to read-only commands. */
export const READ_ONLY_PHASES: Phase[] = ["analyze", "awaiting_approval", "plan", "awaiting_plan_approval", "delegate", "ci"];

/**
 * Phases where extra read-only tools from other extensions (web fetch/search, MCP bridges, ...)
 * are activated on top of PHASE_TOOLS: Analyze and Plan need external context (analyze.md's
 * `gh issue view`/`gh pr view` guidance extends to non-shell tools too), and Supervise/Verify may
 * legitimately need to read documentation while implementing/checking. Delegate, CI, and
 * awaiting_approval are deliberately excluded: Delegate/CI are non-interactive, and
 * awaiting_approval is a human gate, not a phase where the model should be doing research.
 */
const EXTRA_READ_ONLY_PHASES: Phase[] = ["analyze", "plan", "supervise", "verify"];

/** Names an extra-read-only-tools entry may never refer to, however it's spelled or globbed. */
const SHADOW_FORBIDDEN_NAMES = new Set<string>(["edit", "write", "bash", "powershell", ...WORKFLOW_TOOLS]);

function escapeRegExpLiteral(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `name` against a glob pattern where `*` means "any run of characters". */
function matchesGlob(name: string, pattern: string): boolean {
	if (pattern === name) return true;
	if (!pattern.includes("*")) return false;
	const regex = new RegExp(`^${pattern.split("*").map(escapeRegExpLiteral).join(".*")}$`);
	return regex.test(name);
}

/** Drops entries that would shadow a built-in edit/write/bash/powershell or workflow tool name. */
function sanitizeExtraReadOnly(extraReadOnly: string[]): string[] {
	return extraReadOnly.filter((pattern) => !SHADOW_FORBIDDEN_NAMES.has(pattern));
}

export function toolsForPhase(phase: Phase, registered: string[], extraReadOnly: string[] = []): string[] {
	const registeredSet = new Set(registered);
	const base = PHASE_TOOLS[phase].filter((name) => registeredSet.has(name));
	if (!EXTRA_READ_ONLY_PHASES.includes(phase)) return base;

	const patterns = sanitizeExtraReadOnly(extraReadOnly);
	if (patterns.length === 0) return base;

	const baseSet = new Set(base);
	const extras = registered.filter((name) => !baseSet.has(name) && patterns.some((p) => matchesGlob(name, p)));
	return [...base, ...extras];
}

// First-word allowlist for bash/powershell segments. Subcommand-sensitive tools
// (git, go, node, npm) are validated separately in `isSafeSegment`.
const SAFE_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"ls",
	"dir",
	"pwd",
	"echo",
	"wc",
	"grep",
	"rg",
	"find",
	"fd",
	"tree",
	"file",
	"stat",
	"which",
	"where",
	"type",
	"sort",
	"uniq",
	"cut",
	"diff",
	"jq",
	"get-content",
	"get-childitem",
	"select-string",
	"get-item",
	"test-path",
	"resolve-path",
	"gci",
	"gc",
	"sls",
	"cd",
	"pushd",
	"popd",
	"set-location",
	"sl",
	"push-location",
	"pop-location",
]);

// `fetch`/`ls-remote` only update remote-tracking refs or query a remote; neither writes to the
// working tree or a branch a push could reach, so they're as read-only as `log`/`status`.
const GIT_SIMPLE_SUBCOMMANDS = new Set([
	"status",
	"log",
	"show",
	"diff",
	"blame",
	"grep",
	"ls-files",
	"rev-parse",
	"describe",
	"shortlog",
	"cat-file",
	"fetch",
	"ls-remote",
]);
const GO_SUBCOMMANDS = new Set(["list", "env", "version", "doc"]);
const NPM_SUBCOMMANDS = new Set(["ls", "view"]);

// gh subcommands whose top-level verb is read-only. `search` and `api` are validated separately
// (search takes anything after it; api needs the method/field-flag check below).
const GH_READONLY_SUBCOMMANDS: Record<string, string[]> = {
	issue: ["view", "list", "status"],
	pr: ["view", "list", "diff", "checks", "status"],
	run: ["view", "list"],
	workflow: ["view", "list"],
	release: ["view", "list"],
};

const MUTATING_GH_API_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** `gh api ...`: read-only only with no explicit mutating method and no field flags (which default gh api to POST). */
function isSafeGhApi(args: string[]): boolean {
	if (args.length === 0) return false;
	for (let i = 0; i < args.length; i++) {
		const tok = args[i];
		if (tok === "-X" || tok === "--method") {
			const method = (args[i + 1] ?? "").toUpperCase();
			if (MUTATING_GH_API_METHODS.has(method) || method === "") return false;
			i++;
			continue;
		}
		if (tok.startsWith("-X") && tok.length > 2) {
			if (MUTATING_GH_API_METHODS.has(tok.slice(2).toUpperCase())) return false;
			continue;
		}
		if (tok.startsWith("--method=")) {
			if (MUTATING_GH_API_METHODS.has(tok.slice("--method=".length).toUpperCase())) return false;
			continue;
		}
		if (tok === "-f" || tok === "-F" || tok === "--field" || tok === "--raw-field" || tok === "--input" || tok.startsWith("--input=")) {
			return false;
		}
	}
	return true;
}

/** `gh ...`: read subcommands only (issue/pr/run/workflow/release view|list, pr diff|checks, repo view, search, label list, read-only api). Never `--web` (opens a browser, not read-only in a headless sense). */
function isSafeGh(args: string[]): boolean {
	const top = args[0];
	if (top === undefined) return false;
	if (args.includes("--web")) return false;
	const rest = args.slice(1);
	const readonlySubs = GH_READONLY_SUBCOMMANDS[top];
	if (readonlySubs) return rest[0] !== undefined && readonlySubs.includes(rest[0]);
	if (top === "repo") return rest[0] === "view";
	if (top === "search") return true;
	if (top === "label") return rest[0] === "list";
	if (top === "api") return isSafeGhApi(rest);
	return false;
}

/** `curl ...`: GETs to stdout only. Anything writing to a file, sending a body, or using a non-GET/HEAD method is rejected. */
function isSafeCurl(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const tok = args[i];
		if (tok === "-o" || tok === "--output" || tok === "-O" || tok.startsWith("--remote-name")) return false;
		if (
			tok === "-d" ||
			tok.startsWith("--data") ||
			tok === "-F" ||
			tok === "--form" ||
			tok === "-T" ||
			tok === "--upload-file" ||
			tok === "--json"
		) {
			return false;
		}
		if (tok === "-K" || tok === "--config") return false;
		if (tok === "-X" || tok === "--request") {
			const method = (args[i + 1] ?? "").toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
			i++;
			continue;
		}
		if (tok.startsWith("--request=")) {
			const method = tok.slice("--request=".length).toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
		}
	}
	return true;
}

/** `Invoke-WebRequest`/`Invoke-RestMethod`/`iwr`/`irm`: same GET-to-stdout constraint as curl, PowerShell-flavored. */
function isSafeInvokeWeb(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const low = args[i].toLowerCase();
		if (low === "-outfile" || low === "-body" || low === "-infile") return false;
		if (low === "-method") {
			const method = (args[i + 1] ?? "").toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
			i++;
			continue;
		}
		if (low.startsWith("-method:")) {
			const method = low.slice("-method:".length).toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
		}
	}
	return true;
}

function isSafeGit(args: string[]): boolean {
	const sub = args[0];
	if (sub === undefined) return false;
	if (GIT_SIMPLE_SUBCOMMANDS.has(sub)) return true;
	if (sub === "branch") return !args.slice(1).some((a) => a === "-d" || a === "-D" || a === "-m" || a === "-M");
	if (sub === "remote") return args[1] === "-v";
	if (sub === "config") return args[1] === "--get" || args[1] === "--list";
	return false;
}

function isSafeGo(args: string[]): boolean {
	return GO_SUBCOMMANDS.has(args[0] ?? "");
}

function isSafeNode(args: string[]): boolean {
	return args[0] === "--version";
}

function isSafeNpm(args: string[]): boolean {
	const sub = args[0];
	return sub !== undefined && (NPM_SUBCOMMANDS.has(sub) || sub === "--version");
}

function isSafeSegment(segment: string): boolean {
	const trimmed = segment.trim();
	if (trimmed.length === 0) return true;
	const tokens = trimmed.split(/\s+/);
	const cmd = (tokens[0] ?? "").toLowerCase();
	switch (cmd) {
		case "git":
			return isSafeGit(tokens.slice(1));
		case "go":
			return isSafeGo(tokens.slice(1));
		case "node":
			return isSafeNode(tokens.slice(1));
		case "npm":
			return isSafeNpm(tokens.slice(1));
		case "gh":
			return isSafeGh(tokens.slice(1));
		case "curl":
			return isSafeCurl(tokens.slice(1));
		case "invoke-webrequest":
		case "invoke-restmethod":
		case "iwr":
		case "irm":
			return isSafeInvokeWeb(tokens.slice(1));
		default:
			return SAFE_COMMANDS.has(cmd);
	}
}

// Redirections that are always safe: discarding/merging streams, never capturing output to a file.
const ALLOWED_REDIRECTS = /(2>&1|2>\/dev\/null|>\/dev\/null|>\$null|2>\$null)/gi;

/** Splits a shell command into segments the same way for every gate that reasons per-segment. */
function splitSegments(command: string): string[] {
	const withoutAllowedRedirects = command.replace(ALLOWED_REDIRECTS, "");
	return withoutAllowedRedirects
		.split(/&&|\|\||;|\||\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Conservative allowlist for read-only shell commands. When unsure, returns false.
 */
export function isReadOnlyCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;

	// Hard rejects, regardless of position.
	if (/`/.test(trimmed)) return false;
	if (/\$\(/.test(trimmed)) return false;
	if (/\bsed\s+-i\b/i.test(trimmed)) return false;
	if (/\btee\b/i.test(trimmed)) return false;
	if (/\b(rm|mv|cp|xargs)\b/i.test(trimmed)) return false;
	if (/\bfind\b[\s\S]*-(delete|exec|execdir)\b/i.test(trimmed)) return false;

	// Redirection: strip the known-safe forms, then anything left with `>` is a reject.
	const withoutAllowedRedirects = trimmed.replace(ALLOWED_REDIRECTS, "");
	if (/>>?/.test(withoutAllowedRedirects)) return false;

	const segments = splitSegments(trimmed);
	if (segments.length === 0) return false;

	return segments.every((segment) => isSafeSegment(segment));
}

// ---------------------------------------------------------------------------
// Outward actions (push / PR / GitHub replies): blocked unless the user allowed them
// (deliver.md), even outside read-only phases. Force push always needs --force-with-lease.
// Explicit broad staging is blocked in supervise/verify/deliver (deliver.md: stage explicitly).
// ---------------------------------------------------------------------------

const OUTWARD_PATTERNS: RegExp[] = [
	/^git\s+push\b/i,
	/^gh\s+pr\s+create\b/i,
	/^gh\s+pr\s+comment\b/i,
	/^gh\s+pr\s+review\b/i,
	/^gh\s+pr\s+merge\b/i,
	/^gh\s+issue\s+comment\b/i,
	/^gh\s+issue\s+close\b/i,
];

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function isMutatingGhApi(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/);
	if ((tokens[0] ?? "").toLowerCase() !== "gh" || (tokens[1] ?? "").toLowerCase() !== "api") return false;
	let method: string | undefined;
	let hasFieldFlag = false;
	for (let i = 2; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "-X" || tok === "--method") {
			method = tokens[i + 1]?.toUpperCase();
			i++;
			continue;
		}
		if (tok.startsWith("-X") && tok.length > 2) {
			method = tok.slice(2).toUpperCase();
			continue;
		}
		if (tok.startsWith("--method=")) {
			method = tok.slice("--method=".length).toUpperCase();
			continue;
		}
		if (tok === "-f" || tok === "-F" || tok === "--field" || tok === "--raw-field") {
			hasFieldFlag = true;
		}
	}
	if (method) return MUTATING_METHODS.has(method);
	// No explicit method: gh api defaults to POST once -f/-F/--field/--raw-field is used.
	return hasFieldFlag;
}

function isOutwardSegment(segment: string): boolean {
	const trimmed = segment.trim();
	return OUTWARD_PATTERNS.some((re) => re.test(trimmed)) || isMutatingGhApi(trimmed);
}

/** First outward-action segment in `command`, if any (push, PR/issue mutation, mutating `gh api`). */
export function findOutwardSegment(command: string): string | undefined {
	if (typeof command !== "string") return undefined;
	return splitSegments(command).find(isOutwardSegment);
}

function isForcePushWithoutLease(segment: string): boolean {
	if (!/^git\s+push\b/i.test(segment)) return false;
	const tokens = segment.trim().split(/\s+/);
	const hasLease = tokens.some((t) => t === "--force-with-lease" || t.startsWith("--force-with-lease="));
	const hasForce = tokens.some((t) => t === "--force" || t === "-f");
	return hasForce && !hasLease;
}

/** First `git push --force`/`-f` (without `--force-with-lease`) segment in `command`, if any. */
export function findForcePushWithoutLease(command: string): string | undefined {
	if (typeof command !== "string") return undefined;
	return splitSegments(command).find(isForcePushWithoutLease);
}

const BROAD_STAGING_PATTERNS: RegExp[] = [
	/^git\s+add\s+(-A\b|--all\b|\.(\s|$)|:\/(\s|$))/i,
	/^git\s+commit\s+(-a\b|-am\b|--all\b)/i,
];

function isBroadStagingSegment(segment: string): boolean {
	return BROAD_STAGING_PATTERNS.some((re) => re.test(segment.trim()));
}

/** First broad-staging segment (`git add -A`/`.`/`:/`, `git commit -a`/`-am`/`--all`) in `command`, if any. */
export function findBroadStagingSegment(command: string): string | undefined {
	if (typeof command !== "string") return undefined;
	return splitSegments(command).find(isBroadStagingSegment);
}

/** Phases where Supervise/Verify/Deliver's "stage files explicitly" rule (deliver.md) applies. */
export const STAGING_RESTRICTED_PHASES: Phase[] = ["supervise", "verify", "deliver"];

export type GateDecision = { block: true; reason: string } | undefined;

function nextStepReason(phase: Phase, state: WorkflowState): string {
	if (phase === "awaiting_approval") {
		return "wait for the human to approve the analysis (/change approve)";
	}
	if (phase === "awaiting_plan_approval") {
		return "wait for the human to approve the plan (/change approve)";
	}
	if (phase === "ci") {
		const prNumber = state.pr?.number;
		return prNumber !== undefined
			? `wait for CI checks on PR #${prNumber} to finish; the harness resumes the run when they finish (/change status)`
			: "wait for CI checks to finish; the harness resumes the run when they finish (/change status)";
	}
	const artifactTool = PHASE_ARTIFACT_TOOL[phase];
	return artifactTool ? `call ${artifactTool}` : "wait for the workflow to advance";
}

/**
 * Enforcement wired into pi's `tool_call` handler. Blocks tool calls the current phase
 * does not allow, and restricts bash/powershell to read-only commands in read-only phases.
 */
export function decideToolCall(
	state: WorkflowState | undefined,
	toolName: string,
	input: Record<string, unknown>,
	extraReadOnly: string[] = [],
): GateDecision {
	if (state === undefined || state.phase === "done" || state.phase === "stopped") {
		if (WORKFLOW_TOOLS.includes(toolName)) {
			return { block: true, reason: "No /change run is active." };
		}
		return undefined;
	}

	const phase = state.phase;
	const allowed = PHASE_TOOLS[phase];
	if (!allowed.includes(toolName)) {
		if (phase === "ci") {
			const prNumber = state.pr?.number;
			return {
				block: true,
				reason:
					prNumber !== undefined
						? `CI checks are running for PR #${prNumber}; the harness resumes the run when they finish (/change status).`
						: "CI checks are running; the harness resumes the run when they finish (/change status).",
			};
		}
		if (EXTRA_READ_ONLY_PHASES.includes(phase)) {
			const patterns = sanitizeExtraReadOnly(extraReadOnly);
			if (patterns.some((p) => matchesGlob(toolName, p))) {
				return undefined;
			}
		}
		const label = PHASE_LABEL[phase];
		return {
			block: true,
			reason: `${label} phase only allows: ${allowed.join(", ")}. To leave this phase, ${nextStepReason(phase, state)}.`,
		};
	}

	if (toolName === "bash" || toolName === "powershell") {
		const command = typeof input.command === "string" ? input.command : "";

		if (READ_ONLY_PHASES.includes(phase) && !isReadOnlyCommand(command)) {
			const label = PHASE_LABEL[phase];
			return {
				block: true,
				reason: `${label} is read-only: only inspection commands are allowed until ${nextStepReason(phase, state)}.`,
			};
		}

		if (!state.pushAllowed && findOutwardSegment(command)) {
			return {
				block: true,
				reason: "Blocked: pushing / PR / GitHub replies need the user's go. Ask the user to run /change allow-push.",
			};
		}

		// Even when pushAllowed: a rewritten branch must never be force-pushed without --force-with-lease.
		if (findForcePushWithoutLease(command)) {
			return {
				block: true,
				reason: "Blocked: force push without --force-with-lease. A rewritten branch must be pushed with --force-with-lease (deliver.md).",
			};
		}

		if (STAGING_RESTRICTED_PHASES.includes(phase) && findBroadStagingSegment(command)) {
			return {
				block: true,
				reason: "Blocked: stage files explicitly (deliver.md). `git add -A`/`--all`/`.`/`:/` and `git commit -a`/`-am`/`--all` are not allowed here.",
			};
		}
	}

	return undefined;
}
