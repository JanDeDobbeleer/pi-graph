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
];

/** Tools the model may call while in each phase. */
export const PHASE_TOOLS: Record<Phase, string[]> = {
	analyze: ["read", "grep", "find", "ls", "bash", "powershell", "escalate", "submit_analysis"],
	awaiting_approval: ["read", "grep", "find", "ls"],
	plan: ["read", "grep", "find", "ls", "bash", "powershell", "submit_plan"],
	delegate: ["read", "run_delegation"],
	supervise: ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "escalate", "submit_review"],
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
export const READ_ONLY_PHASES: Phase[] = ["analyze", "awaiting_approval", "plan", "delegate", "ci"];

export function toolsForPhase(phase: Phase, registered: string[]): string[] {
	const registeredSet = new Set(registered);
	return PHASE_TOOLS[phase].filter((name) => registeredSet.has(name));
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
]);

const GIT_SIMPLE_SUBCOMMANDS = new Set(["status", "log", "show", "diff", "blame", "grep", "ls-files", "rev-parse", "describe", "shortlog", "cat-file"]);
const GO_SUBCOMMANDS = new Set(["list", "env", "version", "doc"]);
const NPM_SUBCOMMANDS = new Set(["ls", "view"]);

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
		default:
			return SAFE_COMMANDS.has(cmd);
	}
}

// Redirections that are always safe: discarding/merging streams, never capturing output to a file.
const ALLOWED_REDIRECTS = /(2>&1|2>\/dev\/null|>\/dev\/null|>\$null|2>\$null)/gi;

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

	const segments = withoutAllowedRedirects
		.split(/&&|\|\||;|\||\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (segments.length === 0) return false;

	return segments.every((segment) => isSafeSegment(segment));
}

export type GateDecision = { block: true; reason: string } | undefined;

function nextStepReason(phase: Phase, state: WorkflowState): string {
	if (phase === "awaiting_approval") {
		return "wait for the human to approve the analysis (/change approve)";
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
export function decideToolCall(state: WorkflowState | undefined, toolName: string, input: Record<string, unknown>): GateDecision {
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
		const label = PHASE_LABEL[phase];
		return {
			block: true,
			reason: `${label} phase only allows: ${allowed.join(", ")}. To leave this phase, ${nextStepReason(phase, state)}.`,
		};
	}

	if ((toolName === "bash" || toolName === "powershell") && READ_ONLY_PHASES.includes(phase)) {
		const command = typeof input.command === "string" ? input.command : "";
		if (!isReadOnlyCommand(command)) {
			const label = PHASE_LABEL[phase];
			return {
				block: true,
				reason: `${label} is read-only: only inspection commands are allowed until ${nextStepReason(phase, state)}.`,
			};
		}
	}

	return undefined;
}
