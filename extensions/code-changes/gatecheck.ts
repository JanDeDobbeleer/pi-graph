/**
 * Plan-time check that the programs a plan's verification commands invoke exist in the shell the
 * gates will run in. Required gates are frozen when the plan is submitted; catching "grep is not
 * recognized" (cmd.exe) or a mistyped tool then, while the model can still rewrite the plan, is
 * far cheaper than discovering it in Verify.
 *
 * `extractPrograms` is a small quote-aware tokenizer (first word of each `&&`/`||`/`;`/`|`/newline
 * separated segment); `checkGateCommands` asks the gate shell `command -v` (bash/sh) or `where`
 * (cmd.exe) in ONE invocation. The check never blocks on its own failure: a shell that cannot run
 * it, a timeout or unparsable output yields a warning instead of a rejection.
 */

import { runShell } from "./runner.ts";
import type { GateShell } from "./shell.ts";

/** Builtins and keywords that exist in every shell we run gates in (or are never external programs). */
const SKIPPED = new Set([
	"cd", "echo", "test", "[", "[[", "true", "false", "exit", "export", "set", "unset", "if", "then", "else", "elif", "fi", "for", "do", "done",
	"while", "until", "case", "esac", "in", "select", "function", ":", ".", "source", "eval", "exec", "return", "break", "continue", "shift",
	"wait", "read", "printf", "pwd", "type", "alias", "ulimit", "umask", "trap", "local", "declare", "readonly", "time", "{", "}", "!", "((",
]);

/** Extra cmd.exe internal commands, which `where` cannot find. */
const CMD_INTERNAL = new Set(["dir", "copy", "del", "erase", "rd", "rmdir", "md", "mkdir", "ren", "rename", "move", "cls", "call", "start", "title", "ver", "vol", "path", "rem", "pushd", "popd", "mklink"]);

/** Keywords after which the next word is the program (`if grep x; then ...`, `! cmd`, `time cmd`). */
const TRANSPARENT = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "time", "{", "("]);

/** Splits `command` on top-level `&&`, `||`, `;`, `|`, `&` and newlines, honoring quotes and backslash escapes. */
function splitSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				current += command[++i];
			} else if (ch === quote) {
				quote = undefined;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += ch + command[++i];
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
			// "2>&1" and "&>" are redirections, not separators.
			if (ch === "&" && (command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">")) {
				current += ch;
				continue;
			}
			segments.push(current);
			current = "";
			// swallow the second char of && and ||
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments;
}

/** First words of a segment, unquoted enough to compare: splits on whitespace outside quotes. */
function words(segment: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) out.push(current);
	return out;
}

/**
 * Program names invoked by `command`: the first word of each segment, skipping builtins, keywords,
 * `A=b` environment assignments, and anything that is not a plain name (paths, variables, globs,
 * substitutions, quoted strings), since those cannot be looked up by name reliably.
 */
export function extractPrograms(command: string): string[] {
	const found: string[] = [];
	for (const segment of splitSegments(command)) {
		const ws = words(segment.trim().replace(/^[({]+\s*/, ""));
		let i = 0;
		while (i < ws.length) {
			const w = ws[i];
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
				i++;
				continue;
			}
			if (TRANSPARENT.has(w)) {
				i++;
				continue;
			}
			break;
		}
		const first = ws[i];
		if (!first || SKIPPED.has(first.toLowerCase())) continue;
		if (!/^[A-Za-z0-9_][\w.+-]*$/.test(first)) continue; // path, variable, glob, quoted, substitution...
		if (!found.includes(first)) found.push(first);
	}
	return found;
}

export interface GateCommandProblem {
	command: string;
	missing: string[];
}

export interface GateCheckResult {
	problems: GateCommandProblem[];
	/** Set when the check itself could not run; nothing is rejected in that case. */
	warning?: string;
	/** Human-readable rejection text when `problems` is non-empty. */
	message?: string;
}

export interface GateCheckRun {
	exit_code: number;
	output: string;
}

/** Runs the lookup script in the gate shell. Injectable for tests. */
export type GateCheckRunner = (script: string, cwd: string, shell: GateShell) => Promise<GateCheckRun>;

const CHECK_TIMEOUT_MS = 5_000;

const defaultRunner: GateCheckRunner = async (script, cwd, shell) => {
	const r = await runShell(script, cwd, { shell, timeoutMs: CHECK_TIMEOUT_MS, maxOutput: 4_000 });
	return { exit_code: r.exit_code, output: r.output };
};

/** The shell script that prints `MISSING:<name>` for every name that cannot be found. */
export function buildCheckScript(names: string[], kind: GateShell["kind"]): string {
	if (kind === "cmd") {
		return names.map((n) => `where ${n} >nul 2>&1 || echo MISSING:${n}`).join(" & ");
	}
	return `for p in ${names.join(" ")}; do command -v "$p" >/dev/null 2>&1 || echo "MISSING:$p"; done`;
}

function skippedFor(shell: GateShell): (name: string) => boolean {
	return shell.kind === "cmd" ? (n) => CMD_INTERNAL.has(n.toLowerCase()) : () => false;
}

/**
 * Checks that every program the `commands` invoke exists in `shell`. Returns the offending
 * commands (with the missing program names) and a ready-to-throw message; never throws and never
 * blocks when the check itself fails (a `warning` is returned instead).
 */
export async function checkGateCommands(
	commands: string[],
	cwd: string,
	shell: GateShell,
	run: GateCheckRunner = defaultRunner,
): Promise<GateCheckResult> {
	const skip = skippedFor(shell);
	const perCommand = new Map<string, string[]>();
	const all: string[] = [];
	for (const command of new Set(commands)) {
		const programs = extractPrograms(command).filter((p) => !skip(p));
		perCommand.set(command, programs);
		for (const p of programs) if (!all.includes(p)) all.push(p);
	}
	if (all.length === 0) return { problems: [] };

	let result: GateCheckRun;
	try {
		result = await run(buildCheckScript(all, shell.kind), cwd, shell);
	} catch (err) {
		return { problems: [], warning: `could not check the verification commands' programs (${err instanceof Error ? err.message : String(err)})` };
	}
	if (result.exit_code !== 0) {
		return { problems: [], warning: `could not check the verification commands' programs in ${shell.label} (exit ${result.exit_code})` };
	}

	const missing = new Set<string>();
	for (const line of result.output.split(/\r?\n/)) {
		const m = /^MISSING:(\S+)\s*$/.exec(line.trim());
		if (m) missing.add(m[1]);
	}

	const problems: GateCommandProblem[] = [];
	for (const [command, programs] of perCommand) {
		const gone = programs.filter((p) => missing.has(p));
		if (gone.length > 0) problems.push({ command, missing: gone });
	}
	if (problems.length === 0) return { problems };

	const lines = problems.map((p) => `- \`${p.command}\`: ${p.missing.length > 1 ? "programs" : "program"} not found: ${p.missing.join(", ")}`);
	const message =
		`Verification commands use programs that do not exist in the gate shell:\n${lines.join("\n")}\n` +
		`Verification commands run in ${shell.label}; rewrite them for it (e.g. use node/npm scripts or tools available there).`;
	return { problems, message };
}
