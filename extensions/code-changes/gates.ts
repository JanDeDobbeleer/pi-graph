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
	"amend_gate",
];

/** Tools the model may call while in each phase. */
export const PHASE_TOOLS: Record<Phase, string[]> = {
	analyze: ["read", "grep", "find", "ls", "bash", "powershell", "escalate", "submit_analysis"],
	awaiting_approval: ["read", "grep", "find", "ls"],
	plan: ["read", "grep", "find", "ls", "bash", "powershell", "submit_plan"],
	awaiting_plan_approval: ["read", "grep", "find", "ls"],
	delegate: ["read", "run_delegation"],
	supervise: ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "escalate", "resume_task", "amend_gate", "submit_review"],
	verify: ["read", "grep", "find", "ls", "bash", "powershell", "run_gates", "amend_gate", "escalate", "submit_verification"],
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
// (git, go, node, npm, gh, curl, sed, ...) are validated separately in `isSafeSegment`.
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
	"file",
	"stat",
	"which",
	"where",
	"type",
	"cut",
	"diff",
	"jq",
	"get-content",
	"get-childitem",
	"select-string",
	"get-item",
	"test-path",
	"resolve-path",
	"get-command",
	"gcm",
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
	// PowerShell pipeline consumers that cannot write (scriptblock-taking ones are gated below).
	"measure-object",
	"measure",
	"convertfrom-json",
	"format-list",
	"fl",
	"format-table",
	"ft",
	"select-object",
	"select",
]);

// PowerShell pipeline cmdlets that accept a scriptblock: a `{` anywhere in their args is rejected.
const NO_SCRIPTBLOCK_COMMANDS = new Set(["select-object", "select", "measure-object", "measure", "format-list", "fl", "format-table", "ft", "convertfrom-json"]);

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
	"patch-id",
]);
const GO_SUBCOMMANDS = new Set(["list", "env", "version", "doc"]);
const NPM_SUBCOMMANDS = new Set(["ls", "view"]);

// gh subcommands whose top-level verb is read-only. `search`, `api`, `auth`, `repo` are validated
// separately.
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

/** `gh ...`: read subcommands only (issue/pr/run/workflow/release view|list, pr diff|checks, repo view|list, auth status, --version, search, label list, read-only api). Never `--web` (opens a browser, not read-only in a headless sense). */
function isSafeGh(args: string[]): boolean {
	const top = args[0];
	if (top === undefined) return false;
	if (args.includes("--web")) return false;
	const rest = args.slice(1);
	if (top === "--version") return rest.length === 0;
	const readonlySubs = GH_READONLY_SUBCOMMANDS[top];
	if (readonlySubs) return rest[0] !== undefined && readonlySubs.includes(rest[0]);
	if (top === "repo") return rest[0] === "view" || rest[0] === "list";
	// `auth status` only; `-t/--show-token` would print the token into the transcript.
	if (top === "auth") return rest[0] === "status" && !rest.some((a) => a === "-t" || a === "--show-token");
	if (top === "search") return true;
	if (top === "label") return rest[0] === "list";
	if (top === "api") return isSafeGhApi(rest);
	return false;
}

/** curl output targets that write to stdout rather than a file. */
const CURL_STDOUT_TARGETS = new Set(["-", "/dev/stdout"]);

/** `curl ...`: GETs to stdout only. Anything writing to a file, sending a body, or using a non-GET/HEAD method is rejected. */
function isSafeCurl(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const tok = args[i];
		if (tok === "-o" || tok === "--output") {
			if (!CURL_STDOUT_TARGETS.has(args[i + 1] ?? "")) return false;
			i++;
			continue;
		}
		if (tok.startsWith("--output=")) {
			if (!CURL_STDOUT_TARGETS.has(tok.slice("--output=".length))) return false;
			continue;
		}
		if (tok === "-O" || tok.startsWith("--output-dir") || tok.startsWith("--remote-name")) return false;
		// Other flags that write a file.
		if (tok === "-D" || tok === "--dump-header" || tok === "-c" || tok === "--cookie-jar" || tok === "--stderr" || tok.startsWith("--trace")) {
			return false;
		}
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
			continue;
		}
		// Clustered short flags (`-sLo file`, `-sSLO`): an `o` must end the cluster and target stdout; any
		// other file-writing/body/method flag anywhere in a cluster is rejected.
		if (/^-[A-Za-z]{2,}$/.test(tok)) {
			if (/[OdFTKDcX]/.test(tok)) return false;
			const oi = tok.indexOf("o");
			if (oi >= 0) {
				if (oi !== tok.length - 1 || !CURL_STDOUT_TARGETS.has(args[i + 1] ?? "")) return false;
				i++;
			}
		}
	}
	return true;
}

/** True when `tok` (a lowercase PowerShell parameter, `-name` or `-name:value`) is `full` or an abbreviation of it. */
function isPsParam(tok: string, full: string): boolean {
	if (!tok.startsWith("-")) return false;
	const name = tok.split(":")[0];
	return name.length >= 2 && full.startsWith(name);
}

/** `Invoke-WebRequest`/`Invoke-RestMethod`/`iwr`/`irm`: same GET-to-stdout constraint as curl, PowerShell-flavored. */
function isSafeInvokeWeb(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const low = args[i].toLowerCase();
		if (isPsParam(low, "-outfile") || isPsParam(low, "-body") || isPsParam(low, "-infile")) return false;
		if (isPsParam(low, "-method")) {
			const inline = low.includes(":") ? low.slice(low.indexOf(":") + 1) : undefined;
			const method = (inline ?? args[i + 1] ?? "").toUpperCase();
			if (method !== "GET" && method !== "HEAD") return false;
			if (inline === undefined) i++;
		}
	}
	return true;
}

/** `git tag` in list-only mode: no args, or list/filter flags; a pattern positional only with `-l`/`--list`. */
function isSafeGitTag(args: string[]): boolean {
	const hasList = args.some((a) => a === "-l" || a === "--list");
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-l" || a === "--list" || a === "--column" || a === "--no-column" || a === "-n" || /^-n\d+$/.test(a)) continue;
		if (a.startsWith("--sort=") || a.startsWith("--format=")) continue;
		if (a === "--contains" || a === "--no-contains" || a === "--points-at") {
			if (args[i + 1] === undefined || args[i + 1].startsWith("-")) return false;
			i++;
			continue;
		}
		if (a === "--merged" || a === "--no-merged") {
			if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
			continue;
		}
		if (a.startsWith("-")) return false;
		if (!hasList) return false;
	}
	return true;
}

function isSafeGit(rawArgs: string[]): boolean {
	// `git -C <dir> ...` (possibly repeated) only changes the directory; validate the rest.
	let args = rawArgs;
	while (args[0] === "-C") {
		if (args[1] === undefined) return false;
		args = args.slice(2);
	}
	const sub = args[0];
	if (sub === undefined) return false;
	// `--output=<file>` (diff/log/show) writes a file; `git grep -O`/`--open-files-in-pager` runs a program.
	if (args.some((a) => a.startsWith("--output") || a.startsWith("--open-files-in-pager"))) return false;
	if (sub === "grep" && args.some((a) => a.startsWith("-O"))) return false;
	if (GIT_SIMPLE_SUBCOMMANDS.has(sub)) return true;
	if (sub === "branch") return !args.slice(1).some((a) => a === "-d" || a === "-D" || a === "-m" || a === "-M");
	if (sub === "tag") return isSafeGitTag(args.slice(1));
	if (sub === "remote") return args[1] === "-v";
	if (sub === "config") return args[1] === "--get" || args[1] === "--list";
	return false;
}

/** Short, concrete hint appended to the read-only block reason; derived from the real allowlist sets. */
export function readOnlyHint(): string {
	const files = [...SAFE_COMMANDS].filter((c) => /^[a-z]+$/.test(c) && c !== "type" && c !== "dir").slice(0, 14);
	const gitSubs = [...GIT_SIMPLE_SUBCOMMANDS].slice(0, 6).join("/");
	return (
		`Allowed: file inspection (${[...files, "sed -n", "find", "rg"].join("/")}/...), git read commands (${gitSubs}/tag -l, git -C <dir> ...), ` +
		"gh view/list, curl/Invoke-WebRequest GETs, and pipes between them. " +
		"Blocked here: interpreters and scripts (node -e, python, npm run, shell loops, heredocs), writes and redirects. " +
		"Use the read/grep/find tools for files; running code waits for Delegate/Verify."
	);
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

const FIND_WRITING_PREDICATES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

function isSafeFind(args: string[]): boolean {
	return !args.some((a) => FIND_WRITING_PREDICATES.has(a));
}

function isSafeFd(args: string[]): boolean {
	return !args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec"));
}

/** `sort -o file` / `--output` write a file; `--compress-program` runs one. */
function isSafeSort(args: string[]): boolean {
	return !args.some((a) => (a.startsWith("-") && !a.startsWith("--") && a.includes("o")) || a.startsWith("--output") || a.startsWith("--compress-program"));
}

/** `uniq [IN [OUT]]`: a second positional argument is an output file. Conservative: at most one non-option argument. */
function isSafeUniq(args: string[]): boolean {
	return args.filter((a) => !a.startsWith("-")).length <= 1;
}

/** `tree -o file` writes its listing to a file. */
function isSafeTree(args: string[]): boolean {
	return !args.some((a) => (a.startsWith("-") && !a.startsWith("--") && a.includes("o")) || a.startsWith("--output"));
}

/** ripgrep `--pre`/`--hostname-bin` run an external program. */
function isSafeRg(args: string[]): boolean {
	return !args.some((a) => a.startsWith("--pre") || a.startsWith("--hostname-bin"));
}

// ---------------------------------------------------------------------------
// sed: read-only only without in-place editing and with a script limited to addresses plus
// p/d/q/= commands and `s` substitutions whose flags are g/i/I/p/digits (no w/e/m).
// ---------------------------------------------------------------------------

/** Skips a bracket expression starting at `i` (`[`). Returns the index after `]`, or -1 if unterminated or it contains `delim` (delimiter-in-bracket semantics differ between sed flavors). */
function skipSedBracket(script: string, i: number, delim: string): number {
	let j = i + 1;
	if (script[j] === "^") j++;
	if (script[j] === "]") j++;
	while (j < script.length) {
		const ch = script[j];
		if (ch === "[" && (script[j + 1] === ":" || script[j + 1] === "." || script[j + 1] === "=")) {
			const close = script.indexOf(`${script[j + 1]}]`, j + 2);
			if (close < 0) return -1;
			j = close + 2;
			continue;
		}
		if (ch === "]") return j + 1;
		if (ch === delim) return -1;
		j++;
	}
	return -1;
}

/** Skips a regex body up to and including the closing `delim`. Returns the index after it, or -1. */
function skipSedRegex(script: string, start: number, delim: string): number {
	let i = start;
	while (i < script.length) {
		const ch = script[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "[") {
			i = skipSedBracket(script, i, delim);
			if (i < 0) return -1;
			continue;
		}
		if (ch === delim) return i + 1;
		i++;
	}
	return -1;
}

function isSafeSedScript(script: string): boolean {
	const n = script.length;
	let i = 0;
	const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
	const digits = (): boolean => {
		const from = i;
		while (isDigit(script[i])) i++;
		return i > from;
	};
	const skipBlank = () => {
		while (script[i] === " " || script[i] === "\t") i++;
	};
	const address = (): boolean => {
		if (script[i] === "$") {
			i++;
			return true;
		}
		if (isDigit(script[i])) {
			digits();
			if (script[i] === "~") {
				i++;
				return digits();
			}
			return true;
		}
		if (script[i] === "/") {
			i = skipSedRegex(script, i + 1, "/");
			if (i < 0) return false;
			while (script[i] === "I" || script[i] === "M") i++;
			return true;
		}
		return false;
	};
	const endOfCommand = (): boolean => script[i] === undefined || /[\s;}]/.test(script[i]);

	for (;;) {
		while (i < n && (/\s/.test(script[i]) || script[i] === ";")) i++;
		if (i >= n) return true;
		if (address()) {
			skipBlank();
			if (script[i] === ",") {
				i++;
				skipBlank();
				if (script[i] === "+" || script[i] === "~") {
					i++;
					if (!digits()) return false;
				} else if (!address()) {
					return false;
				}
			}
		}
		if (i < 0) return false;
		skipBlank();
		while (script[i] === "!") {
			i++;
			skipBlank();
		}
		const c = script[i++];
		if (c === undefined) return false;
		if (c === "{" || c === "}") continue;
		if (c === "p" || c === "d" || c === "q" || c === "=") {
			if (!endOfCommand()) return false;
			continue;
		}
		if (c === "s") {
			const delim = script[i++];
			if (delim === undefined || /[\s\\A-Za-z0-9]/.test(delim)) return false;
			i = skipSedRegex(script, i, delim);
			if (i < 0) return false;
			while (i < n && script[i] !== delim) {
				if (script[i] === "\\") i++;
				i++;
			}
			if (i >= n) return false;
			i++;
			while (i < n && /[giIp0-9]/.test(script[i])) i++;
			if (!endOfCommand()) return false;
			continue;
		}
		return false;
	}
}

function isSafeSed(args: string[]): boolean {
	const scripts: string[] = [];
	const positional: string[] = [];
	let endOfOptions = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (endOfOptions || a === "-" || !a.startsWith("-")) {
			positional.push(a);
			continue;
		}
		if (a === "--") {
			endOfOptions = true;
			continue;
		}
		if (a.startsWith("--")) {
			if (a === "--quiet" || a === "--silent" || a === "--regexp-extended" || a === "--separate" || a === "--null-data") continue;
			if (a === "--expression") {
				const script = args[++i];
				if (script === undefined) return false;
				scripts.push(script);
				continue;
			}
			if (a.startsWith("--expression=")) {
				scripts.push(a.slice("--expression=".length));
				continue;
			}
			return false; // --in-place, --file, --sandbox, ...: not allowed
		}
		const flags = a.slice(1);
		for (let j = 0; j < flags.length; j++) {
			const f = flags[j];
			if ("nErsz".includes(f)) continue;
			if (f === "e") {
				const inline = flags.slice(j + 1);
				const script = inline.length > 0 ? inline : args[++i];
				if (script === undefined) return false;
				scripts.push(script);
				break;
			}
			return false; // -i (any cluster containing it), -f, -l, ...
		}
	}
	if (scripts.length === 0) {
		const script = positional.shift();
		if (script === undefined) return false;
		scripts.push(script);
	}
	return scripts.every(isSafeSedScript);
}

// ---------------------------------------------------------------------------
// PowerShell pipeline filter: Where-Object with a scriptblock made only of property comparisons.
// ---------------------------------------------------------------------------

const PS_VALUE = "(?:'[^']*'|\"[^\"$`(]*\"|-?\\d+(?:\\.\\d+)?|\\$true|\\$false|\\$null)";
const PS_COMPARE = `\\$_(?:\\.\\w+)*\\s+-[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains)\\s+${PS_VALUE}`;
const WHERE_SCRIPTBLOCK = new RegExp(`^\\{\\s*${PS_COMPARE}(?:\\s+-(?:and|or)\\s+${PS_COMPARE})*\\s*\\}$`, "i");

// ---------------------------------------------------------------------------
// PowerShell `( ... )` expressions: the leading command is judged recursively; what may follow the
// closing paren is limited to member access, safe method calls with literal arguments, indexing,
// and -join/-split/-replace with literal operands.
// ---------------------------------------------------------------------------

const PS_STRING = "(?:'[^']*'|\"[^\"$]*\")";
const PS_LITERAL = `(?:${PS_STRING}|-?\\d+)`;
const PS_LITERAL_LIST = `${PS_LITERAL}(?:\\s*,\\s*${PS_LITERAL})*`;
const PS_METHOD_CALL = new RegExp(`^\\.([A-Za-z_]\\w*)\\(\\s*(?:${PS_LITERAL_LIST})?\\s*\\)`);
const PS_MEMBER = /^\.[A-Za-z_]\w*/;
const PS_INDEX = new RegExp(`^\\[\\s*(?:-?\\d+(?:\\s*(?:\\.\\.|,)\\s*-?\\d+)*|${PS_STRING})\\s*\\]`);
const PS_OPERATOR = new RegExp(`^-(?:join|split|replace)\\s+${PS_LITERAL_LIST}`, "i");
const PS_SAFE_METHODS = new Set([
	"split",
	"trim",
	"trimstart",
	"trimend",
	"substring",
	"replace",
	"tostring",
	"tolower",
	"toupper",
	"contains",
	"startswith",
	"endswith",
	"indexof",
]);

function isSafePsPostfix(rest: string): boolean {
	let s = rest.trim();
	while (s.length > 0) {
		let m = PS_METHOD_CALL.exec(s);
		if (m) {
			if (!PS_SAFE_METHODS.has(m[1].toLowerCase())) return false;
		} else {
			m = PS_MEMBER.exec(s) ?? PS_INDEX.exec(s) ?? PS_OPERATOR.exec(s);
			if (!m) return false;
		}
		s = s.slice(m[0].length).trimStart();
	}
	return true;
}

// ---------------------------------------------------------------------------
// Quote-aware scanning
// ---------------------------------------------------------------------------

// Redirections that are always safe: discarding/merging streams, never capturing output to a file.
const ALLOWED_REDIRECT_AT = /^(?:2>&1|&>\s*\/dev\/null|[12]?>\s*\/dev\/null|[12]?>\s*\$null)(?![\w./$-])/i;

interface Scan {
	segments: string[];
	/** False when the text contains something a read-only command may not: a capturing redirect, command substitution, an unbalanced quote/paren, or an ambiguous backslash-quote. */
	ok: boolean;
}

interface ScanOptions {
	/** Allow PowerShell backtick escapes (`n, `t, `r, `0) inside double quotes. Any other backtick is rejected. */
	psEscapes?: boolean;
	/** Keep `( ... )` groups together in one segment. When false, parens act as separators (outward-action detection). */
	groupParens?: boolean;
}

/**
 * Splits a shell command into segments on `|`, `&&`, `||`, `;`, `&` and newlines, ignoring separators
 * inside single/double quotes and inside `( ... )` groups (when `groupParens`). Allowed redirects
 * (`2>&1`, `>/dev/null`, `>$null`, ...) are removed from the segments.
 *
 * Ambiguity policy: the same text can be run by bash or PowerShell, whose quoting rules differ (backslash,
 * backtick). Anything where they would disagree about where a quote ends is rejected (`ok = false`):
 * a backslash before a quote character, backticks outside single quotes (except the PowerShell
 * escapes when `psEscapes`), and `$(` outside single quotes. Inside single quotes `$(` and backticks are
 * literal in both shells, so they are allowed there. An unquoted backslash before a separator does not
 * escape it (PowerShell would not), so `a\|b` outside quotes splits at the `|`.
 */
function scanCommand(command: string, opts: ScanOptions = {}): Scan {
	const groupParens = opts.groupParens ?? true;
	const segments: string[] = [];
	let buf = "";
	let ok = true;
	let quote: "'" | '"' | undefined;
	let depth = 0;
	const flush = () => {
		const t = buf.trim();
		if (t.length > 0) segments.push(t);
		buf = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			buf += ch;
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === '"') ok = false; // bash: escaped quote; PowerShell: closes the string
				buf += ch + (next ?? "");
				i++;
				continue;
			}
			if (ch === "`") {
				const next = command[i + 1];
				if (opts.psEscapes && next !== undefined && "ntr0".includes(next)) {
					buf += ch + next;
					i++;
					continue;
				}
				ok = false;
			} else if (ch === "$" && command[i + 1] === "(") {
				ok = false;
			}
			buf += ch;
			if (ch === '"') quote = undefined;
			continue;
		}
		// Unquoted.
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === '"' || next === "'") ok = false;
			buf += ch;
			continue;
		}
		if (ch === "`") {
			ok = false;
			buf += ch;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			ok = false;
			buf += ch;
			continue;
		}
		if (ch === "<" && command[i + 1] === "(") {
			ok = false;
			buf += ch;
			continue;
		}
		const digitInsideWord = (ch === "2" || ch === "1") && i > 0 && /\S/.test(command[i - 1]);
		if (!digitInsideWord && (ch === "2" || ch === "1" || ch === "&" || ch === ">")) {
			const m = ALLOWED_REDIRECT_AT.exec(command.slice(i));
			if (m) {
				buf += " ";
				i += m[0].length - 1;
				continue;
			}
		}
		if (ch === ">") {
			ok = false;
			buf += ch;
			continue;
		}
		if (ch === "(") {
			if (groupParens) {
				depth++;
				buf += ch;
			} else {
				flush();
			}
			continue;
		}
		if (ch === ")") {
			if (groupParens) {
				depth--;
				if (depth < 0) ok = false;
				buf += ch;
			} else {
				flush();
			}
			continue;
		}
		if (depth <= 0 && (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r")) {
			flush();
			continue;
		}
		buf += ch;
	}
	if (quote !== undefined || depth !== 0) ok = false;
	flush();
	return { segments, ok };
}

/** Whitespace tokenizer that honours quotes (stripped from the tokens) and keeps `( ... )` groups inside one token. */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let has = false;
	let quote: "'" | '"' | undefined;
	let depth = 0;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (quote === '"' && ch === "\\" && i + 1 < segment.length) {
				cur += ch + segment[i + 1];
				i++;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (depth <= 0 && /\s/.test(ch)) {
			if (has || cur.length > 0) tokens.push(cur);
			cur = "";
			has = false;
			continue;
		}
		cur += ch;
	}
	if (has || cur.length > 0) tokens.push(cur);
	return tokens;
}

/** Top-level `( ... )` groups of an already-scanned segment, as `[open, close]` index pairs (quotes respected). */
function topLevelParenGroups(s: string): Array<[number, number]> {
	const groups: Array<[number, number]> = [];
	let quote: "'" | '"' | undefined;
	let depth = 0;
	let open = -1;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quote) {
			if (quote === '"' && (ch === "\\" || ch === "`")) i++;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "(") {
			if (depth === 0) open = i;
			depth++;
		} else if (ch === ")") {
			depth--;
			if (depth === 0) groups.push([open, i]);
		}
	}
	return groups;
}

function isSafeSegment(segment: string, psEscapes: boolean): boolean {
	const trimmed = segment.trim();
	if (trimmed.length === 0) return true;

	// Parenthesized groups execute (PowerShell) or spawn a subshell (bash): judge their contents as commands.
	const groups = topLevelParenGroups(trimmed);
	if (trimmed.startsWith("(")) {
		const [open, close] = groups[0] ?? [0, -1];
		if (close < 0 || !checkReadOnly(trimmed.slice(open + 1, close), psEscapes)) return false;
		return isSafePsPostfix(trimmed.slice(close + 1));
	}
	for (const [open, close] of groups) {
		if (!checkReadOnly(trimmed.slice(open + 1, close), psEscapes)) return false;
	}

	const tokens = tokenize(trimmed);
	const cmd = (tokens[0] ?? "").toLowerCase();
	const args = tokens.slice(1);
	switch (cmd) {
		case "git":
			return isSafeGit(args);
		case "go":
			return isSafeGo(args);
		case "node":
			return isSafeNode(args);
		case "npm":
			return isSafeNpm(args);
		case "gh":
			return isSafeGh(args);
		case "curl":
			return isSafeCurl(args);
		case "invoke-webrequest":
		case "invoke-restmethod":
		case "iwr":
		case "irm":
			return isSafeInvokeWeb(args);
		case "sed":
			return isSafeSed(args);
		case "find":
			return isSafeFind(args);
		case "fd":
			return isSafeFd(args);
		case "sort":
			return isSafeSort(args);
		case "uniq":
			return isSafeUniq(args);
		case "tree":
			return isSafeTree(args);
		case "rg":
			return isSafeRg(args);
		case "tr":
			// Pure stdin->stdout filter; redirects/substitutions are already rejected by the scan.
			return true;
		case "command":
			return args[0] === "-v" || args[0] === "-V";
		case "where-object":
		case "?":
			return WHERE_SCRIPTBLOCK.test(trimmed.replace(/^\S+\s*/, ""));
		case "where": {
			// `where` is where.exe unless it carries a scriptblock (the Where-Object alias).
			const rest = trimmed.replace(/^\S+\s*/, "");
			return rest.includes("{") ? WHERE_SCRIPTBLOCK.test(rest) : true;
		}
		default:
			if (!SAFE_COMMANDS.has(cmd)) return false;
			if (NO_SCRIPTBLOCK_COMMANDS.has(cmd) && trimmed.includes("{")) return false;
			return true;
	}
}

function checkReadOnly(text: string, psEscapes: boolean): boolean {
	const scan = scanCommand(text, { psEscapes });
	if (!scan.ok || scan.segments.length === 0) return false;
	return scan.segments.every((segment) => isSafeSegment(segment, psEscapes));
}

/** Naive splitter kept for the outward-action gates: no quote awareness, so it can only flag more. */
function legacySplit(command: string): string[] {
	return command
		.replace(/(2>&1|2>\/dev\/null|>\/dev\/null|>\$null|2>\$null)/gi, "")
		.split(/&&|\|\||;|\||\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Segments for the outward-action gates (push / PR / broad staging): the quote-aware split with parens as
 * separators, plus the naive split, so a command hidden in a subshell or quotes is still flagged.
 */
function splitSegments(command: string): string[] {
	return [...scanCommand(command, { psEscapes: true, groupParens: false }).segments, ...legacySplit(command)];
}

/**
 * Conservative allowlist for read-only shell commands. When unsure, returns false.
 *
 * The command is split quote-aware into segments; every segment must start with an allowlisted command
 * (with per-command flag checks), and nothing may redirect output to a file or substitute commands.
 * Words like `rm`/`tee` inside quoted arguments are data, not commands, and do not trigger a reject.
 */
export function isReadOnlyCommand(command: string): boolean {
	if (typeof command !== "string") return false;
	const trimmed = command.trim();
	if (trimmed.length === 0) return false;
	// PowerShell backtick escapes (`n) are tolerated only for a command that leads with a paren expression.
	return checkReadOnly(trimmed, trimmed.startsWith("("));
}

// ---------------------------------------------------------------------------
// Outward actions (push / PR / GitHub replies): blocked unless the user allowed them
// (deliver.md), even outside read-only phases. Force push always needs --force-with-lease.
// Explicit broad staging is blocked in supervise/verify/deliver (deliver.md: stage explicitly).
// ---------------------------------------------------------------------------

const OUTWARD_PATTERNS: RegExp[] = [
	/^git\s+(?:-C\s+\S+\s+)*push\b/i,
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
	if (!/^git\s+(?:-C\s+\S+\s+)*push\b/i.test(segment)) return false;
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
	/^git\s+(?:-C\s+\S+\s+)*add\s+(-A\b|--all\b|\.(\s|$)|:\/(\s|$))/i,
	/^git\s+(?:-C\s+\S+\s+)*commit\s+(-a\b|-am\b|--all\b)/i,
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
				reason: `${label} is read-only: only inspection commands are allowed until ${nextStepReason(phase, state)}. ${readOnlyHint()}`,
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
