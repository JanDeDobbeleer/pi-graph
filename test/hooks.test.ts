import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverStopHooks, findRepoRoot, formatHookFeedback, hooksBlocked, resolveBash, runStopHooks, StopHookGuard, type StopHook } from "../extensions/code-changes/hooks.ts";
import { git } from "../extensions/code-changes/runner.ts";
import type { HookResult } from "../extensions/code-changes/state.ts";

const TIMEOUT = 30_000;

function commandExistsSync(name: string, platform: NodeJS.Platform = process.platform): boolean {
	const pathEnv = process.env.PATH ?? process.env.Path ?? "";
	const dirs = pathEnv.split(platform === "win32" ? ";" : ":").filter((d) => d.length > 0);
	const exts = platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			try {
				if (fs.statSync(path.join(dir, name + ext.toLowerCase())).isFile()) return true;
			} catch {
				/* not found here */
			}
		}
	}
	return false;
}

const hasBash = commandExistsSync("bash");

async function makeTempRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-hooks-test-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await fs.promises.writeFile(path.join(dir, "README.md"), "# test repo\n", "utf-8");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "initial commit"], dir);
	return dir;
}

async function rmrf(dir: string): Promise<void> {
	await fs.promises.rm(dir, { recursive: true, force: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// A one-liner node script, portable across bash/cmd/powershell since it's invoked as
// `node -e "<script>"` directly (no dependency on the calling shell's quoting rules), used as
// the StopHook's `command`/`bash`/`powershell` field so it runs regardless of shell.
function nodeCommand(script: string): string {
	return `node -e "${script.replace(/"/g, '\\"')}"`;
}

describe("resolveBash", () => {
	function fakeExists(files: string[]) {
		const set = new Set(files.map((f) => f.toLowerCase()));
		return (filePath: string) => set.has(filePath.toLowerCase());
	}

	it("on win32, prefers CLAUDE_CODE_GIT_BASH_PATH when it exists", () => {
		const bash = resolveBash({
			platform: "win32",
			env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Tools\\CustomGit\\bin\\bash.exe" },
			pathDirs: ["C:\\Windows\\System32", "C:\\Program Files\\Git\\cmd"],
			exists: fakeExists(["C:\\Tools\\CustomGit\\bin\\bash.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
		});
		expect(bash).toBe("C:\\Tools\\CustomGit\\bin\\bash.exe");
	});

	it("ignores CLAUDE_CODE_GIT_BASH_PATH when it does not exist", () => {
		const bash = resolveBash({
			platform: "win32",
			env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\nope\\bash.exe" },
			pathDirs: ["C:\\Program Files\\Git\\cmd"],
			exists: fakeExists(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
		});
		expect(bash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("derives Git Bash from git.exe under ...\\Git\\cmd on PATH", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Windows\\System32", "C:\\Program Files\\Git\\cmd"],
			exists: fakeExists(["C:\\Windows\\System32\\bash.exe", "C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
		});
		expect(bash).toBe(String.raw`C:\Program Files\Git\bin\bash.exe`);
	});

	it("derives Git Bash from git.exe under ...\\Git\\mingw64\\bin on PATH", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Program Files\\Git\\mingw64\\bin"],
			exists: fakeExists(["C:\\Program Files\\Git\\mingw64\\bin\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
		});
		expect(bash).toBe(String.raw`C:\Program Files\Git\bin\bash.exe`);
	});

	it("derives Git Bash from git.exe already under ...\\Git\\bin on PATH", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Program Files\\Git\\bin"],
			exists: fakeExists(["C:\\Program Files\\Git\\bin\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
		});
		expect(bash).toBe(String.raw`C:\Program Files\Git\bin\bash.exe`);
	});

	it("falls back to any non-System32/WindowsApps bash.exe on PATH when git is not found", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Windows\\System32", "C:\\Tools\\bash-portable"],
			exists: fakeExists(["C:\\Windows\\System32\\bash.exe", "C:\\Tools\\bash-portable\\bash.exe"]),
		});
		expect(bash).toBe(String.raw`C:\Tools\bash-portable\bash.exe`);
	});

	it("never returns the System32 WSL launcher stub, even with nothing else on PATH", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Windows\\System32"],
			exists: fakeExists(["C:\\Windows\\System32\\bash.exe"]),
		});
		expect(bash).toBeUndefined();
	});

	it("skips a WindowsApps bash.exe too", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: [String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps`, "C:\\Tools\\bash-portable"],
			exists: fakeExists([String.raw`C:\Users\me\AppData\Local\Microsoft\WindowsApps\bash.exe`, "C:\\Tools\\bash-portable\\bash.exe"]),
		});
		expect(bash).toBe(String.raw`C:\Tools\bash-portable\bash.exe`);
	});

	it("returns undefined on win32 when nothing usable is found", () => {
		const bash = resolveBash({ platform: "win32", env: {}, pathDirs: ["C:\\Windows\\System32"], exists: () => false });
		expect(bash).toBeUndefined();
	});

	it("off win32, returns the first PATH dir with a bash file", () => {
		const bash = resolveBash({
			platform: "linux",
			env: {},
			pathDirs: ["/usr/bin", "/bin"],
			exists: fakeExists(["/bin/bash"]),
		});
		expect(bash).toBe("/bin/bash");
	});
});

describe("discoverStopHooks", () => {
	it(
		"discovers Claude Stop hooks from .claude/settings.json",
		async () => {
			const repo = await makeTempRepo();
			try {
				await writeJson(path.join(repo, ".claude", "settings.json"), {
					hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi", timeout: 30 }] }] },
				});

				const { hooks, source, skipped } = discoverStopHooks(repo);
				expect(source).toBe("claude");
				expect(hooks).toHaveLength(1);
				expect(hooks[0].source).toBe("claude");
				expect(hooks[0].command).toBe("echo hi");
				expect(hooks[0].timeoutMs).toBe(30_000);
				expect(hooks[0].env.CLAUDE_PROJECT_DIR).toBe(repo);
				expect(hooks[0].cwd).toBe(repo);
				expect(skipped).toEqual([]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"discovers Copilot agentStop hooks from every .github/hooks/*.json",
		async () => {
			const repo = await makeTempRepo();
			try {
				await writeJson(path.join(repo, ".github", "hooks", "quality.json"), {
					version: 1,
					hooks: {
						agentStop: [{ type: "command", bash: "echo hi", powershell: "Write-Output hi", timeoutSec: 45 }],
					},
				});

				const { hooks, source, skipped } = discoverStopHooks(repo);
				expect(source).toBe("copilot");
				expect(hooks).toHaveLength(1);
				expect(hooks[0].source).toBe("copilot");
				expect(hooks[0].timeoutMs).toBe(45_000);
				expect(skipped).toEqual([]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"prefers Copilot and skips Claude when both define a stop hook",
		async () => {
			const repo = await makeTempRepo();
			try {
				const claudePath = path.join(repo, ".claude", "settings.json");
				await writeJson(claudePath, {
					hooks: { Stop: [{ hooks: [{ type: "command", command: "go run main.go --harness claude" }] }] },
				});
				await writeJson(path.join(repo, ".github", "hooks", "quality.json"), {
					version: 1,
					hooks: { agentStop: [{ type: "command", bash: "go run main.go --harness copilot", powershell: "go run main.go --harness copilot" }] },
				});

				const { hooks, source, skipped } = discoverStopHooks(repo);
				expect(source).toBe("copilot");
				expect(hooks.every((h) => h.source === "copilot")).toBe(true);
				expect(skipped.some((s) => s.includes(claudePath) && s.includes("Copilot"))).toBe(true);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"skips invalid JSON files instead of throwing",
		async () => {
			const repo = await makeTempRepo();
			try {
				await fs.promises.mkdir(path.join(repo, ".claude"), { recursive: true });
				await fs.promises.writeFile(path.join(repo, ".claude", "settings.json"), "{ not valid json", "utf-8");
				await fs.promises.mkdir(path.join(repo, ".github", "hooks"), { recursive: true });
				await fs.promises.writeFile(path.join(repo, ".github", "hooks", "broken.json"), "[ nope", "utf-8");

				const { hooks, source, skipped } = discoverStopHooks(repo);
				expect(hooks).toEqual([]);
				expect(source).toBeUndefined();
				expect(skipped.length).toBe(2);
				expect(skipped.some((s) => s.includes("settings.json"))).toBe(true);
				expect(skipped.some((s) => s.includes("broken.json"))).toBe(true);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"merges settings.local.json after settings.json",
		async () => {
			const repo = await makeTempRepo();
			try {
				await writeJson(path.join(repo, ".claude", "settings.json"), {
					hooks: { Stop: [{ hooks: [{ type: "command", command: "echo main" }] }] },
				});
				await writeJson(path.join(repo, ".claude", "settings.local.json"), {
					hooks: { Stop: [{ hooks: [{ type: "command", command: "echo local" }] }] },
				});

				const { hooks } = discoverStopHooks(repo);
				expect(hooks.map((h) => h.command)).toEqual(["echo main", "echo local"]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"returns no hooks and no source when nothing is configured",
		async () => {
			const repo = await makeTempRepo();
			try {
				const { hooks, source, skipped } = discoverStopHooks(repo);
				expect(hooks).toEqual([]);
				expect(source).toBeUndefined();
				expect(skipped).toEqual([]);
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});

// ---------------------------------------------------------------------------
// runStopHooks: StopHook objects are constructed directly so these don't depend on bash/pwsh
// being on PATH (the StopHook.shell already names the interpreter to spawn).
// ---------------------------------------------------------------------------

function directHook(overrides: Partial<StopHook> & Pick<StopHook, "shell">): StopHook {
	return {
		source: "claude",
		command: "test hook",
		cwd: process.cwd(),
		timeoutMs: 10_000,
		env: {},
		configPath: "test",
		...overrides,
	};
}

describe("runStopHooks", () => {
	it(
		"blocks on {\"decision\":\"block\"} printed to stdout with exit 0",
		async () => {
			const hook = directHook({
				shell: { file: process.execPath, args: ["-e", `console.log(JSON.stringify({decision:"block",reason:"lint failed"}))`] },
			});
			const [result] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(result.exit_code).toBe(0);
			expect(result.blocked).toBe(true);
			expect(result.reason).toBe("lint failed");
		},
		TIMEOUT,
	);

	it(
		"blocks on exit code 2 and uses stderr as the reason",
		async () => {
			const hook = directHook({
				shell: { file: process.execPath, args: ["-e", `console.error("boom"); process.exit(2)`] },
			});
			const [result] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(result.exit_code).toBe(2);
			expect(result.blocked).toBe(true);
			expect(result.reason).toContain("boom");
		},
		TIMEOUT,
	);

	it(
		"does not block on a silent exit 0",
		async () => {
			const hook = directHook({ shell: { file: process.execPath, args: ["-e", `process.exit(0)`] } });
			const [result] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(result.exit_code).toBe(0);
			expect(result.blocked).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"does not block on a non-zero, non-2 exit, but records the output",
		async () => {
			const hook = directHook({
				shell: { file: process.execPath, args: ["-e", `console.log("weird failure"); process.exit(1)`] },
			});
			const [result] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(result.exit_code).toBe(1);
			expect(result.blocked).toBe(false);
			expect(result.reason).toContain("weird failure");
		},
		TIMEOUT,
	);

	it(
		"delivers stdin JSON and echoes stop_hook_active back",
		async () => {
			const script = [
				"let d='';",
				"process.stdin.on('data',c=>d+=c);",
				"process.stdin.on('end',()=>{",
				"const p=JSON.parse(d);",
				"console.log(JSON.stringify({decision:'block',reason:'stop_hook_active='+p.stop_hook_active}));",
				"});",
			].join("");
			const hook = directHook({ shell: { file: process.execPath, args: ["-e", script] } });

			const [resultFalse] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(resultFalse.reason).toBe("stop_hook_active=false");

			const [resultTrue] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: true });
			expect(resultTrue.reason).toBe("stop_hook_active=true");
		},
		TIMEOUT,
	);

	it(
		"sets CLAUDE_PROJECT_DIR for claude-source hooks",
		async () => {
			const script = "console.log(JSON.stringify({decision:'block',reason:process.env.CLAUDE_PROJECT_DIR||''}))";
			const hook = directHook({
				source: "claude",
				env: { CLAUDE_PROJECT_DIR: "/some/repo/root" },
				shell: { file: process.execPath, args: ["-e", script] },
			});
			const [result] = await runStopHooks([hook], { repoRoot: "/some/repo/root", stopHookActive: false });
			expect(result.reason).toBe("/some/repo/root");
		},
		TIMEOUT,
	);

	it(
		"kills a hook that exceeds its timeout and reports exit code 124",
		async () => {
			const hook = directHook({
				timeoutMs: 200,
				shell: { file: process.execPath, args: ["-e", `setTimeout(()=>{}, 60000)`] },
			});
			const [result] = await runStopHooks([hook], { repoRoot: process.cwd(), stopHookActive: false });
			expect(result.exit_code).toBe(124);
			expect(result.blocked).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"runs multiple hooks sequentially and returns one result each",
		async () => {
			const hookA = directHook({
				command: "a",
				shell: { file: process.execPath, args: ["-e", `console.log(JSON.stringify({decision:"block",reason:"a"}))`] },
			});
			const hookB = directHook({
				command: "b",
				shell: { file: process.execPath, args: ["-e", `process.exit(0)`] },
			});
			const results = await runStopHooks([hookA, hookB], { repoRoot: process.cwd(), stopHookActive: false });
			expect(results).toHaveLength(2);
			expect(results[0].command).toBe("a");
			expect(results[1].command).toBe("b");
		},
		TIMEOUT,
	);
});

describe("hooksBlocked / formatHookFeedback", () => {
	function makeResult(overrides: Partial<HookResult>): HookResult {
		return { source: "claude", command: "cmd", exit_code: 0, blocked: false, reason: "", duration_ms: 1, ...overrides };
	}

	it("hooksBlocked filters to only the blocking results", () => {
		const results = [makeResult({ blocked: false }), makeResult({ blocked: true, reason: "nope" })];
		expect(hooksBlocked(results)).toHaveLength(1);
		expect(hooksBlocked(results)[0].reason).toBe("nope");
	});

	it("formatHookFeedback returns empty string when nothing is blocked", () => {
		expect(formatHookFeedback([makeResult({ blocked: false })])).toBe("");
	});

	it("formatHookFeedback names the source, command, and reason of blocking hooks", () => {
		const feedback = formatHookFeedback([makeResult({ source: "copilot", command: "go run main.go", blocked: true, reason: "lint failed" })]);
		expect(feedback).toContain("copilot");
		expect(feedback).toContain("go run main.go");
		expect(feedback).toContain("lint failed");
		expect(feedback.toLowerCase()).toContain("finish");
	});

	it("formatHookFeedback truncates a very long reason", () => {
		const feedback = formatHookFeedback([makeResult({ blocked: true, reason: "x".repeat(20_000) })]);
		expect(feedback.length).toBeLessThan(20_000);
		expect(feedback).toContain("truncated");
	});
});

describe("findRepoRoot", () => {
	it(
		"resolves the repo root from inside a git repo",
		async () => {
			const repo = await makeTempRepo();
			try {
				const root = await findRepoRoot(repo);
				expect(root).toBeDefined();
				expect(fs.realpathSync(root as string)).toBe(fs.realpathSync(repo));
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);

	it(
		"returns undefined outside a git repo",
		async () => {
			const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-not-a-repo-"));
			try {
				const root = await findRepoRoot(dir);
				expect(root).toBeUndefined();
			} finally {
				await rmrf(dir);
			}
		},
		TIMEOUT,
	);
});

describe("StopHookGuard", () => {
	it("allows and stays reset when nothing blocks", () => {
		const guard = new StopHookGuard(2);
		expect(guard.next(false)).toEqual({ action: "allow" });
		expect(guard.stopHookActive).toBe(false);
	});

	it("continues (with stop_hook_active true) up to maxContinuations, then gives up", () => {
		const guard = new StopHookGuard(2);

		const first = guard.next(true);
		expect(first).toEqual({ action: "continue", stopHookActive: true });
		expect(guard.stopHookActive).toBe(true);

		const second = guard.next(true);
		expect(second).toEqual({ action: "continue", stopHookActive: true });

		const third = guard.next(true);
		expect(third).toEqual({ action: "give_up" });
	});

	it("a pass resets the counter", () => {
		const guard = new StopHookGuard(2);
		expect(guard.next(true)).toEqual({ action: "continue", stopHookActive: true });
		expect(guard.next(false)).toEqual({ action: "allow" });
		expect(guard.stopHookActive).toBe(false);

		// Back to a fresh run of continuations after the reset.
		expect(guard.next(true)).toEqual({ action: "continue", stopHookActive: true });
		expect(guard.next(true)).toEqual({ action: "continue", stopHookActive: true });
		expect(guard.next(true)).toEqual({ action: "give_up" });
	});

	it("reset() clears state manually", () => {
		const guard = new StopHookGuard(1);
		guard.next(true);
		expect(guard.stopHookActive).toBe(true);
		guard.reset();
		expect(guard.stopHookActive).toBe(false);
		expect(guard.next(true)).toEqual({ action: "continue", stopHookActive: true });
	});
});

// ---------------------------------------------------------------------------
// End-to-end: discovery -> run, using real shells. Skipped where bash isn't on PATH (Windows CI
// without git-bash), since the Claude-format hooks in this repo's fixtures use bash-style quoting.
// ---------------------------------------------------------------------------

describe.skipIf(!hasBash)("discoverStopHooks -> runStopHooks (integration)", () => {
	it(
		"discovers and runs a real Claude Stop hook end to end",
		async () => {
			const repo = await makeTempRepo();
			try {
				await writeJson(path.join(repo, ".claude", "settings.json"), {
					hooks: {
						Stop: [{ hooks: [{ type: "command", command: nodeCommand("console.log(JSON.stringify({decision:'block',reason:'from claude hook'}))") }] }],
					},
				});

				const { hooks, source } = discoverStopHooks(repo);
				expect(source).toBe("claude");
				const results = await runStopHooks(hooks, { repoRoot: repo, stopHookActive: false });
				expect(results).toHaveLength(1);
				expect(results[0].blocked).toBe(true);
				expect(results[0].reason).toBe("from claude hook");
			} finally {
				await rmrf(repo);
			}
		},
		TIMEOUT,
	);
});
