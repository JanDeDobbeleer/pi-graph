/**
 * Discovers and runs the "agent finished its turn" hooks a repository already defines for
 * Claude Code (`.claude/settings*.json` `Stop`) and GitHub Copilot (`.github/hooks/*.json`
 * `agentStop`), emulating each harness's own contract well enough that a repo's existing hook
 * program (see e.g. oh-my-posh's `.agents/hooks/main.go`) behaves the same way it would under
 * the real harness. No proprietary hook format of our own: this only reads config a project
 * already committed for Claude Code / Copilot.
 *
 * Both harnesses share the same result shape: a hook blocks the stop either by exiting 2
 * (reason on stderr) or by exiting 0 and printing `{"decision":"block","reason":...}` on
 * stdout; a `{"systemMessage":...}` on stdout is a non-blocking note to surface; any other
 * non-zero exit is a non-blocking error whose output is still recorded for the model to see.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./runner.ts";
import { resolveBashSync } from "./shell.ts";
import type { HookResult } from "./state.ts";

export { resolveBash, type ResolveBashOptions } from "./shell.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT = 12_000;
const FEEDBACK_TRUNCATE = 8_000;
const TRUNCATE_HEAD = 2_000;

export interface StopHook {
	/** "claude" (.claude/settings*.json Stop) or "copilot" (.github/hooks/*.json agentStop). */
	source: "claude" | "copilot";
	/** Display form of the command/script, for feedback and logs. */
	command: string;
	shell: { file: string; args: string[] };
	cwd: string;
	timeoutMs: number;
	env: Record<string, string>;
	/** Config file this hook was discovered in. */
	configPath: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Case-insensitive lookup of one of several alias keys on a plain object. */
function getAliasKey(obj: Record<string, unknown>, aliases: string[]): unknown {
	for (const key of Object.keys(obj)) {
		if (aliases.some((a) => a.toLowerCase() === key.toLowerCase())) return obj[key];
	}
	return undefined;
}

function readJson(filePath: string, skipped: string[]): Record<string, unknown> | undefined {
	if (!fs.existsSync(filePath)) return undefined;
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (err) {
		skipped.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
	try {
		const data = JSON.parse(raw);
		if (typeof data !== "object" || data === null) {
			skipped.push(`${filePath}: invalid JSON (not an object)`);
			return undefined;
		}
		return data as Record<string, unknown>;
	} catch {
		skipped.push(`${filePath}: invalid JSON`);
		return undefined;
	}
}

/** Scans PATH (synchronously, no spawn) for an executable named `name`. */
function commandExistsSync(name: string, platform: NodeJS.Platform): boolean {
	const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
	const dirs = pathEnv.split(platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
	const exts = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, name + ext.toLowerCase());
			try {
				if (fs.statSync(candidate).isFile()) return true;
			} catch {
				/* not found here */
			}
		}
	}
	return false;
}

function expandClaudeProjectDir(command: string, repoRoot: string): string {
	return command.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, repoRoot).replace(/\$CLAUDE_PROJECT_DIR\b/g, repoRoot);
}

/**
 * Claude Code runs `command` as a shell string through bash when one is available; otherwise it
 * falls back to the platform shell, in which case we expand `$CLAUDE_PROJECT_DIR` /
 * `${CLAUDE_PROJECT_DIR}` ourselves since cmd.exe doesn't understand that syntax.
 */
function claudeShell(command: string, repoRoot: string, platform: NodeJS.Platform, bashPath: string | undefined): { file: string; args: string[] } {
	if (bashPath) return { file: bashPath, args: ["-c", command] };
	if (platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", expandClaudeProjectDir(command, repoRoot)] };
	return { file: "/bin/sh", args: ["-c", command] };
}

function loadClaudeHooks(repoRoot: string, platform: NodeJS.Platform, skipped: string[]): StopHook[] {
	const bashPath = platform === "win32" ? resolveBashSync(platform) : commandExistsSync("bash", platform) ? "bash" : undefined;
	const hooks: StopHook[] = [];

	for (const fileName of ["settings.json", "settings.local.json"]) {
		const filePath = path.join(repoRoot, ".claude", fileName);
		const data = readJson(filePath, skipped);
		if (!data) continue;

		const hooksSection = data.hooks;
		if (typeof hooksSection !== "object" || hooksSection === null) continue;
		const stopGroups = getAliasKey(hooksSection as Record<string, unknown>, ["Stop", "stop"]);
		if (!Array.isArray(stopGroups)) continue;

		for (const group of stopGroups) {
			if (typeof group !== "object" || group === null) continue;
			const entries = (group as Record<string, unknown>).hooks;
			if (!Array.isArray(entries)) continue;

			for (const entry of entries) {
				if (typeof entry !== "object" || entry === null) continue;
				const e = entry as Record<string, unknown>;
				if (e.type !== "command" || typeof e.command !== "string") continue;

				const timeoutMs = typeof e.timeout === "number" ? e.timeout * 1000 : DEFAULT_TIMEOUT_MS;
				hooks.push({
					source: "claude",
					command: e.command,
					shell: claudeShell(e.command, repoRoot, platform, bashPath),
					cwd: repoRoot,
					timeoutMs,
					env: { CLAUDE_PROJECT_DIR: repoRoot },
					configPath: filePath,
				});
			}
		}
	}

	return hooks;
}

function loadCopilotHooks(repoRoot: string, platform: NodeJS.Platform, skipped: string[]): StopHook[] {
	const hooksDir = path.join(repoRoot, ".github", "hooks");
	if (!fs.existsSync(hooksDir)) return [];

	let fileNames: string[];
	try {
		fileNames = fs
			.readdirSync(hooksDir)
			.filter((f) => f.toLowerCase().endsWith(".json"))
			.sort();
	} catch {
		return [];
	}

	const bashPath = platform === "win32" ? resolveBashSync(platform) : commandExistsSync("bash", platform) ? "bash" : undefined;
	const hasPwsh = commandExistsSync("pwsh", platform);
	const hasPowershell = commandExistsSync("powershell", platform);
	const hooks: StopHook[] = [];

	for (const fileName of fileNames) {
		const filePath = path.join(hooksDir, fileName);
		const data = readJson(filePath, skipped);
		if (!data) continue;

		const hooksSection = data.hooks;
		if (typeof hooksSection !== "object" || hooksSection === null) continue;
		const entries = getAliasKey(hooksSection as Record<string, unknown>, ["agentStop", "Stop", "stop"]);
		if (!Array.isArray(entries)) continue;

		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			if (e.type !== "command") continue;

			const bash = typeof e.bash === "string" ? e.bash : undefined;
			const powershell = typeof e.powershell === "string" ? e.powershell : undefined;
			const preferred = platform === "win32" ? powershell : bash;
			const fallbackScript = platform === "win32" ? bash : powershell;
			const script = preferred ?? fallbackScript;
			if (script === undefined) {
				skipped.push(`${filePath}: agentStop hook has neither "bash" nor "powershell"`);
				continue;
			}
			const usingPowershell = script === powershell;

			let shell: { file: string; args: string[] } | undefined;
			if (usingPowershell) {
				if (hasPwsh) shell = { file: "pwsh", args: ["-NoProfile", "-Command", script] };
				else if (hasPowershell) shell = { file: "powershell", args: ["-NoProfile", "-Command", script] };
			} else if (bashPath) {
				shell = { file: bashPath, args: ["-c", script] };
			}
			if (!shell) {
				skipped.push(`${filePath}: no ${usingPowershell ? "pwsh/powershell" : "bash"} found on PATH to run its agentStop hook`);
				continue;
			}

			const cwd = typeof e.cwd === "string" ? path.join(repoRoot, e.cwd) : repoRoot;
			const timeoutMs = typeof e.timeoutSec === "number" ? e.timeoutSec * 1000 : DEFAULT_TIMEOUT_MS;
			const env: Record<string, string> = {};
			if (typeof e.env === "object" && e.env !== null) {
				for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) {
					if (typeof v === "string") env[k] = v;
				}
			}

			hooks.push({ source: "copilot", command: script, shell, cwd, timeoutMs, env, configPath: filePath });
		}
	}

	return hooks;
}

/**
 * Discovers Stop hooks from `.claude/settings.json` + `.claude/settings.local.json` (merged,
 * local appended) and every `.github/hooks/*.json`. When Copilot defines any `agentStop` hooks,
 * they win outright and the Claude hooks are skipped (repos like oh-my-posh register the same
 * program in both files, and the Copilot CLI itself also reads `.claude/settings.json`, so
 * running both would duplicate the check). Invalid JSON is reported in `skipped`, never thrown.
 */
export function discoverStopHooks(
	repoRoot: string,
	platform: NodeJS.Platform = process.platform,
): { hooks: StopHook[]; source: "claude" | "copilot" | undefined; skipped: string[] } {
	const skipped: string[] = [];
	const claudeHooks = loadClaudeHooks(repoRoot, platform, skipped);
	const copilotHooks = loadCopilotHooks(repoRoot, platform, skipped);

	if (copilotHooks.length > 0) {
		const claudeConfigPaths = Array.from(new Set(claudeHooks.map((h) => h.configPath)));
		for (const configPath of claudeConfigPaths) {
			skipped.push(`${configPath}: same stop event already defined for Copilot; running only one source avoids duplicate runs`);
		}
		return { hooks: copilotHooks, source: "copilot", skipped };
	}

	if (claudeHooks.length > 0) {
		return { hooks: claudeHooks, source: "claude", skipped };
	}

	return { hooks: [], source: undefined, skipped };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function truncate(output: string, maxOutput: number): string {
	if (output.length <= maxOutput) return output;
	const headLen = Math.min(TRUNCATE_HEAD, maxOutput);
	const tailLen = maxOutput - headLen;
	const head = output.slice(0, headLen);
	const tail = tailLen > 0 ? output.slice(output.length - tailLen) : "";
	const omitted = output.length - headLen - tail.length;
	return `${head}\n[... ${omitted} chars truncated ...]\n${tail}`;
}

/** Best-effort kill of a process (and its children on Windows, via taskkill /T). */
function killProcessTree(pid: number | undefined): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		} catch {
			/* ignore */
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* ignore */
	}
}

function buildStdin(hook: StopHook, opts: { repoRoot: string; stopHookActive: boolean; sessionId?: string }): string {
	if (hook.source === "claude") {
		return JSON.stringify({
			session_id: opts.sessionId ?? "",
			transcript_path: "",
			cwd: opts.repoRoot,
			hook_event_name: "Stop",
			stop_hook_active: opts.stopHookActive,
		});
	}
	return JSON.stringify({
		timestamp: Date.now(),
		cwd: opts.repoRoot,
		stop_hook_active: opts.stopHookActive,
		hook_event_name: "agentStop",
	});
}

function interpretResult(exitCode: number, stdout: string, stderr: string): { blocked: boolean; reason: string } {
	if (exitCode === 2) {
		return { blocked: true, reason: stderr.trim() || "(hook exited 2 with no stderr)" };
	}

	if (exitCode === 0) {
		const trimmed = stdout.trim();
		if (trimmed) {
			try {
				const parsed = JSON.parse(trimmed);
				if (parsed && typeof parsed === "object") {
					if ((parsed as Record<string, unknown>).decision === "block") {
						const reason = (parsed as Record<string, unknown>).reason;
						return { blocked: true, reason: typeof reason === "string" ? reason : "(blocked, no reason given)" };
					}
					const systemMessage = (parsed as Record<string, unknown>).systemMessage;
					if (typeof systemMessage === "string") {
						return { blocked: false, reason: systemMessage };
					}
				}
			} catch {
				/* stdout wasn't JSON: not a decision, nothing to surface */
			}
		}
		return { blocked: false, reason: "" };
	}

	// Any other non-zero exit: non-blocking error, but record the output for the model to see.
	const combined = [stdout.trim(), stderr.trim()].filter((s) => s.length > 0).join("\n");
	return { blocked: false, reason: combined || `hook exited with code ${exitCode}` };
}

export interface RunStopHooksOptions {
	repoRoot: string;
	stopHookActive: boolean;
	sessionId?: string;
	signal?: AbortSignal;
	maxOutput?: number;
}

/**
 * Runs `hooks` sequentially, one process per hook, spawned directly from `hook.shell` (already a
 * shell invocation, so no extra shell layer is added). Writes the harness-appropriate stdin JSON
 * and closes stdin. Never throws: spawn errors, non-zero exits, and timeouts (which kill the
 * process tree and report exit code 124) are all folded into the returned `HookResult`s.
 */
export async function runStopHooks(hooks: StopHook[], opts: RunStopHooksOptions): Promise<HookResult[]> {
	const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
	const results: HookResult[] = [];

	for (const hook of hooks) {
		const start = Date.now();
		const stdin = buildStdin(hook, opts);

		const result = await new Promise<HookResult>((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let aborted = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(hook.shell.file, hook.shell.args, {
					cwd: hook.cwd,
					shell: false,
					env: { ...process.env, ...hook.env },
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (err) {
				resolve({
					source: hook.source,
					command: hook.command,
					exit_code: 127,
					blocked: false,
					reason: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
					duration_ms: Date.now() - start,
				});
				return;
			}

			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
				const duration_ms = Date.now() - start;

				if (timedOut) {
					resolve({
						source: hook.source,
						command: hook.command,
						exit_code: 124,
						blocked: false,
						reason: truncate(`timed out after ${hook.timeoutMs}ms, process killed`, maxOutput),
						duration_ms,
					});
					return;
				}

				const { blocked, reason } = interpretResult(exitCode, stdout, stderr);
				resolve({
					source: hook.source,
					command: hook.command,
					exit_code: exitCode,
					blocked,
					reason: truncate(reason, maxOutput),
					duration_ms,
				});
			};

			const onAbort = () => {
				aborted = true;
				killProcessTree(proc.pid);
			};
			if (opts.signal) {
				if (opts.signal.aborted) onAbort();
				else opts.signal.addEventListener("abort", onAbort, { once: true });
			}

			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessTree(proc.pid);
			}, hook.timeoutMs);

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("error", (err) => {
				stderr += `\nSpawn error: ${err instanceof Error ? err.message : String(err)}`;
				finish(127);
			});

			proc.on("close", (code) => {
				finish(code ?? (aborted ? 130 : 1));
			});

			proc.stdin?.on("error", () => {
				/* the child may have exited before we finished writing; finish() below handles it */
			});
			proc.stdin?.write(stdin);
			proc.stdin?.end();
		});

		results.push(result);
	}

	return results;
}

/** The hooks in `results` that asked to block the stop. */
export function hooksBlocked(results: HookResult[]): HookResult[] {
	return results.filter((r) => r.blocked);
}

/** Markdown feedback for the model: which hook(s) blocked, why, and what to do next. */
export function formatHookFeedback(results: HookResult[]): string {
	const blocked = hooksBlocked(results);
	if (blocked.length === 0) return "";

	const lines = blocked.map((r) => {
		const reason = truncate(r.reason, FEEDBACK_TRUNCATE);
		const indented = reason
			.split("\n")
			.map((l) => `  ${l}`)
			.join("\n");
		return `- **${r.source}** hook \`${r.command}\` blocked finishing (exit ${r.exit_code}):\n\n${indented}`;
	});

	return [
		"One or more stop hooks blocked finishing this turn:",
		"",
		...lines,
		"",
		"Fix the issue(s) above, then finish your turn again.",
	].join("\n");
}

/** Repo root via `git rev-parse --show-toplevel`, or undefined outside a git repo. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
	const result = await git(["rev-parse", "--show-toplevel"], cwd);
	if (result.code !== 0) return undefined;
	const root = result.stdout.trim();
	return root.length > 0 ? path.normalize(root) : undefined;
}

// ---------------------------------------------------------------------------
// Loop cap
// ---------------------------------------------------------------------------

export type StopHookGuardResult = { action: "continue"; stopHookActive: boolean } | { action: "allow" } | { action: "give_up" };

/**
 * Bounds how many times a blocked stop is allowed to send the agent back around before the
 * caller gives up and notifies the user, mirroring Claude Code's own `stop_hook_active` loop
 * cap. A pass resets the counter; a block increments it and, once `maxContinuations` consecutive
 * blocks have been allowed to continue, the next block gives up instead.
 */
export class StopHookGuard {
	private consecutiveBlocks = 0;
	private active = false;

	constructor(private readonly maxContinuations = 2) {}

	/** Whether the next hook run must be told `stop_hook_active: true`. */
	get stopHookActive(): boolean {
		return this.active;
	}

	next(blocked: boolean): StopHookGuardResult {
		if (!blocked) {
			this.reset();
			return { action: "allow" };
		}

		this.consecutiveBlocks += 1;
		if (this.consecutiveBlocks > this.maxContinuations) {
			return { action: "give_up" };
		}

		this.active = true;
		return { action: "continue", stopHookActive: true };
	}

	reset(): void {
		this.consecutiveBlocks = 0;
		this.active = false;
	}
}
