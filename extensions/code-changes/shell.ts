/**
 * Which shell runs verification gates (and hooks): the same one pi's own `bash` tool uses, so a
 * command the model just ran through `bash` behaves identically when `run_gates` runs it.
 *
 * On Windows a plain `spawn(cmd, { shell: true })` means cmd.exe, where `grep`, `true`, `||` with
 * unix programs and quoting all behave differently; the model writes gates for the shell it can
 * see (Git Bash), so gates must run there too.
 *
 * Resolution order (see `resolveGateShell`):
 *   1. pi's own `getShellConfig` (honors `shellPath` in pi's settings.json, Git for Windows in
 *      Program Files, /bin/bash, ...), i.e. exactly what the `bash` tool runs. The legacy WSL
 *      launcher (System32\bash.exe, stdin transport) is not usable for `-c` and is skipped.
 *   2. `resolveBash`: an explicit override, Git Bash derived from `git` on PATH, then any bash on
 *      PATH that is not the WSL / WindowsApps stub.
 *   3. The platform shell (cmd.exe on Windows, sh elsewhere).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Windows bash resolution (pure)
// ---------------------------------------------------------------------------
//
// On Windows, the first `bash` found by a plain PATH scan is very often
// C:\Windows\System32\bash.exe — the WSL launcher stub. Spawning a command through it runs it
// *inside WSL*, against the WSL filesystem, not the Windows checkout the harness is operating on.
// Claude Code itself resolves a real Git Bash on Windows, so we emulate that: prefer an explicit
// override, then derive Git Bash from `git`'s own location on PATH, then fall back to any bash on
// PATH that isn't the WSL launcher.

// Matched against a lowercased path with both slash styles normalized to "\": the WSL launcher
// stub lives at "...\Windows\System32\bash.exe" (or SysWOW64); a per-user app-execution-alias
// stub can live at "...\WindowsApps\bash.exe" (there is no literal "Windows\" segment before it).
const SYSTEM32_SEGMENT = /[\\/]system32[\\/]|[\\/]syswow64[\\/]/i;
const WINDOWSAPPS_SEGMENT = /[\\/]windowsapps([\\/]|$)/i;

export interface ResolveBashOptions {
	platform: NodeJS.Platform;
	/** Environment variables, at minimum PATH/Path and (on win32) CLAUDE_CODE_GIT_BASH_PATH. */
	env: Record<string, string | undefined>;
	/** PATH, already split into directories, in PATH order. */
	pathDirs: string[];
	/** Pure existence check (a file, not necessarily executable-checked further). */
	exists(filePath: string): boolean;
}

/**
 * Joins path segments using `platform`'s own separator, independent of the host OS running this
 * code (so the win32 logic is exercisable from a test running on any platform, and vice versa).
 */
function joinAs(platform: NodeJS.Platform, dir: string, name: string): string {
	const sep = platform === "win32" ? "\\" : "/";
	const trimmed = dir.replace(/[\\/]+$/, "");
	return trimmed.length > 0 ? `${trimmed}${sep}${name}` : name;
}

/** `...\Git\cmd`, `...\Git\bin`, or `...\Git\mingw64\bin` -> `...\Git\bin\bash.exe`. */
function deriveGitBashPath(gitDir: string): string | undefined {
	const normalized = gitDir.replace(/[\\/]+$/, "");
	const lower = normalized.toLowerCase();
	let root: string | undefined;
	if (lower.endsWith("\\mingw64\\bin") || lower.endsWith("/mingw64/bin")) {
		root = normalized.slice(0, -"\\mingw64\\bin".length);
	} else if (lower.endsWith("\\cmd") || lower.endsWith("/cmd") || lower.endsWith("\\bin") || lower.endsWith("/bin")) {
		root = normalized.slice(0, -4);
	}
	if (!root) return undefined;
	return joinAs("win32", joinAs("win32", root, "bin"), "bash.exe");
}

/**
 * Pure bash-selection logic (no spawn, no real fs). On win32, in order:
 * `env.CLAUDE_CODE_GIT_BASH_PATH` if it exists; else Git Bash derived from a `git.exe`/`git.cmd`
 * found on PATH; else any `bash.exe` on PATH that is not under `%SystemRoot%\System32` (or
 * SysWOW64) or `WindowsApps` — the WSL launcher stub lives there. Off win32, the first `bash`
 * found on PATH.
 */
export function resolveBash(opts: ResolveBashOptions): string | undefined {
	const { platform, env, pathDirs, exists } = opts;

	if (platform !== "win32") {
		for (const dir of pathDirs) {
			const candidate = joinAs(platform, dir, "bash");
			if (exists(candidate)) return candidate;
		}
		return undefined;
	}

	const override = env.CLAUDE_CODE_GIT_BASH_PATH;
	if (override && exists(override)) return override;

	for (const dir of pathDirs) {
		if (exists(joinAs(platform, dir, "git.exe")) || exists(joinAs(platform, dir, "git.cmd"))) {
			const derived = deriveGitBashPath(dir);
			if (derived && exists(derived)) return derived;
		}
	}

	for (const dir of pathDirs) {
		if (SYSTEM32_SEGMENT.test(`${dir}\\`) || WINDOWSAPPS_SEGMENT.test(`${dir}\\`)) continue;
		const candidate = joinAs(platform, dir, "bash.exe");
		if (exists(candidate)) return candidate;
	}

	return undefined;
}

/** `resolveBash` wired to the real process env, PATH, and filesystem. */
export function resolveBashSync(platform: NodeJS.Platform): string | undefined {
	const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path ?? "";
	const pathDirs = pathEnv.split(platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
	return resolveBash({
		platform,
		env: process.env as Record<string, string | undefined>,
		pathDirs,
		exists: (filePath) => {
			try {
				return fs.statSync(filePath).isFile();
			} catch {
				return false;
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Gate shell
// ---------------------------------------------------------------------------

export interface GateShell {
	/** "bash": `file` + `args` + command. "cmd" / "sh": the platform shell (spawn with shell: true). */
	kind: "bash" | "cmd" | "sh";
	/** Executable for kind "bash". */
	file?: string;
	/** Arguments placed before the command for kind "bash" (normally ["-c"]). */
	args?: string[];
	/** Human-readable name, e.g. "bash (C:\Program Files\Git\bin\bash.exe)" or "cmd.exe". */
	label: string;
}

export function platformShell(platform: NodeJS.Platform = process.platform): GateShell {
	return platform === "win32" ? { kind: "cmd", label: "cmd.exe" } : { kind: "sh", label: "sh" };
}

export function bashShell(file: string, args: string[] = ["-c"]): GateShell {
	return { kind: "bash", file, args, label: `bash (${file})` };
}

const WSL_LAUNCHER = /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/;

function isWslLauncher(file: string): boolean {
	return WSL_LAUNCHER.test(file.replace(/\//g, "\\").toLowerCase());
}

function readShellPathSetting(file: string): string | undefined {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { shellPath?: unknown };
		return typeof data.shellPath === "string" && data.shellPath.trim() !== "" ? data.shellPath.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** `shellPath` from pi's settings: project `.pi/settings.json` overrides `<agentDir>/settings.json`. */
function configuredShellPath(cwd: string, agentDir: string): string | undefined {
	const raw = readShellPathSetting(path.join(cwd, ".pi", "settings.json")) ?? readShellPathSetting(path.join(agentDir, "settings.json"));
	if (!raw) return undefined;
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
	return raw;
}

const shellCache = new Map<string, GateShell>();
/** Last shell resolved in this process; lets synchronous prompt builders name it. */
let lastResolved: GateShell | undefined;

/** Label of the most recently resolved gate shell, if any has been resolved yet. */
export function knownGateShellLabel(): string | undefined {
	return lastResolved?.label;
}

/** Test helper: forget cached resolutions. */
export function resetGateShellCache(): void {
	shellCache.clear();
	lastResolved = undefined;
}

/** Resolves the shell gates run in (see the module comment). Never throws; cached per cwd. */
export async function resolveGateShell(cwd: string): Promise<GateShell> {
	const cached = shellCache.get(cwd);
	if (cached) return cached;

	let resolved: GateShell | undefined;
	try {
		const pi = await import("@earendil-works/pi-coding-agent");
		const config = pi.getShellConfig(configuredShellPath(cwd, pi.getAgentDir()));
		const usable = config.commandTransport !== "stdin" && !isWslLauncher(config.shell);
		if (usable && path.basename(config.shell).toLowerCase().startsWith("bash")) {
			resolved = bashShell(config.shell, config.args);
		}
	} catch {
		/* pi has no usable shell (or cannot be loaded): fall through */
	}

	if (!resolved) {
		const bash = resolveBashSync(process.platform);
		resolved = bash ? bashShell(bash) : platformShell();
	}

	shellCache.set(cwd, resolved);
	lastResolved = resolved;
	return resolved;
}
