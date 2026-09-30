/**
 * Shell and git process running helpers used by the Delegate phase.
 *
 * `runShell` never throws: every failure (non-zero exit, spawn error, timeout, abort) is folded
 * into a `GateResult` so callers can always inspect `exit_code` and `output`. `git` is a thin,
 * shell-less wrapper for the git plumbing `delegate.ts` needs (worktrees, merges, diffs).
 */

import { spawn } from "node:child_process";
import { platformShell, resolveGateShell, type GateShell } from "./shell.ts";
import type { GateResult } from "./state.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT = 12_000;
const TRUNCATE_HEAD = 2_000;

function truncateOutput(output: string, maxOutput: number): string {
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

export interface RunShellOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutput?: number;
	/** Shell to run in; defaults to the shell pi's bash tool uses (see shell.ts). */
	shell?: GateShell;
}

/** Output that means "the command itself could not be found or started" rather than "it ran and failed". */
const UNRUNNABLE_OUTPUT =
	/is not recognized as an internal or external command|command not found|No such file or directory.*(?:bash|sh):|cannot find the path|The term '.+' is not recognized/i;

/** True when a failed run says the environment cannot run the command at all (missing program, bad path). */
export function isUnrunnable(exitCode: number, output: string): boolean {
	if (exitCode === 0) return false;
	return exitCode === 127 || UNRUNNABLE_OUTPUT.test(output);
}

/**
 * Runs `command` in the gate shell inside `cwd`: `bash -c` when a bash resolves (the same shell
 * pi's bash tool uses), else the platform shell (cmd.exe on Windows, sh elsewhere).
 * Merges stdout+stderr in arrival order. Never throws: non-zero exit, timeout, abort and
 * spawn errors are all reported through the returned `GateResult`, which names the shell and
 * says whether the command was runnable at all.
 */
export async function runShell(command: string, cwd: string, opts?: RunShellOptions): Promise<GateResult> {
	const shell = opts?.shell ?? (await resolveGateShell(cwd).catch(() => platformShell()));
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxOutput = opts?.maxOutput ?? DEFAULT_MAX_OUTPUT;
	const start = Date.now();

	return new Promise<GateResult>((resolve) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let spawnFailed = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		let proc: ReturnType<typeof spawn>;
		try {
			proc =
				shell.kind === "bash" && shell.file
					? spawn(shell.file, [...(shell.args ?? ["-c"]), command], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
					: spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({
				command,
				exit_code: 127,
				shell: shell.label,
				runnable: false,
				output: `Failed to spawn command: ${err instanceof Error ? err.message : String(err)}`,
				duration_ms: Date.now() - start,
			});
			return;
		}

		const finish = (exitCode: number, note?: string) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (opts?.signal) opts.signal.removeEventListener("abort", onAbort);
			const combined = note ? `${output}\n${note}` : output;
			resolve({
				command,
				exit_code: exitCode,
				shell: shell.label,
				runnable: !(spawnFailed || isUnrunnable(exitCode, combined)),
				output: truncateOutput(combined, maxOutput),
				duration_ms: Date.now() - start,
			});
		};

		const onAbort = () => {
			aborted = true;
			killProcessTree(proc.pid);
		};

		if (opts?.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		timeoutHandle = setTimeout(() => {
			timedOut = true;
			killProcessTree(proc.pid);
		}, timeoutMs);

		proc.stdout?.on("data", (data) => {
			output += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			output += data.toString();
		});

		proc.on("error", (err) => {
			spawnFailed = true;
			finish(127, `Spawn error: ${err instanceof Error ? err.message : String(err)}`);
		});

		proc.on("close", (code, signalName) => {
			if (timedOut) {
				finish(124, `[timed out after ${timeoutMs}ms, process killed]`);
				return;
			}
			if (aborted) {
				finish(code ?? 130, `[aborted, process killed${signalName ? ` (${signalName})` : ""}]`);
				return;
			}
			finish(code ?? 1);
		});
	});
}

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Spawns `git <args>` without a shell. Never throws on non-zero exit or spawn error. */
export async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
	return new Promise<GitResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
			return;
		}

		const onAbort = () => killProcessTree(proc.pid);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (err) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ code: 127, stdout, stderr: `${stderr}\nSpawn error: ${err instanceof Error ? err.message : String(err)}` });
		});
		proc.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}
