import { describe, expect, it } from "vitest";
import { buildCheckScript, checkGateCommands, extractPrograms, type GateCheckRunner } from "../extensions/code-changes/gatecheck.ts";
import { isUnrunnable, runShell } from "../extensions/code-changes/runner.ts";
import { bashShell, platformShell, resolveBash, resolveGateShell, type GateShell } from "../extensions/code-changes/shell.ts";

const TIMEOUT = 30_000;

describe("extractPrograms", () => {
	it("takes the first word of each segment", () => {
		expect(extractPrograms("npm run build && node scripts/x.mjs | grep ok; go test ./...")).toEqual(["npm", "node", "grep", "go"]);
	});

	it("skips builtins, keywords, env assignments and non-plain words", () => {
		expect(extractPrograms('cd sub && echo hi && test -f a || true')).toEqual([]);
		expect(extractPrograms("FOO=1 BAR=2 vitest run")).toEqual(["vitest"]);
		expect(extractPrograms("./scripts/x.sh && $HOME/bin/y && node_modules/.bin/z")).toEqual([]);
		expect(extractPrograms('if grep -q x f; then echo y; fi')).toEqual(["grep"]);
		expect(extractPrograms("for f in a b; do cat $f; done")).toEqual(["cat"]);
	});

	it("is quote-aware and treats redirections as part of the command", () => {
		expect(extractPrograms(`grep -c "a && b" dist/*.js || true`)).toEqual(["grep"]);
		expect(extractPrograms("tsc --noEmit 2>&1 | head -5")).toEqual(["tsc", "head"]);
		expect(extractPrograms(`node -e "console.log(1); process.exit(0)"`)).toEqual(["node"]);
	});
});

describe("checkGateCommands", () => {
	const bash: GateShell = bashShell("/usr/bin/bash");

	/** Fake shell: every name in `have` exists, the rest are reported MISSING. */
	const fakeRunner = (have: string[], exit_code = 0): GateCheckRunner => async (script) => {
		const names = /for p in ([^;]*);/.exec(script)?.[1].split(" ") ?? [];
		return { exit_code, output: names.filter((n) => !have.includes(n)).map((n) => `MISSING:${n}`).join("\n") };
	};

	it("passes when every program exists and runs one batched lookup", async () => {
		let calls = 0;
		const runner: GateCheckRunner = async (script, cwd, shell) => {
			calls++;
			return fakeRunner(["node", "npm"])(script, cwd, shell);
		};
		const result = await checkGateCommands(["npm test", "node a.js && npm run b"], process.cwd(), bash, runner);
		expect(result.problems).toEqual([]);
		expect(result.message).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("reports the command and the missing program with the shell in the message", async () => {
		const result = await checkGateCommands(["grep -c x dist/a.js || true", "npm test"], process.cwd(), bash, fakeRunner(["npm"]));
		expect(result.problems).toEqual([{ command: "grep -c x dist/a.js || true", missing: ["grep"] }]);
		expect(result.message).toContain("`grep -c x dist/a.js || true`");
		expect(result.message).toContain("grep");
		expect(result.message).toContain("Verification commands run in bash (/usr/bin/bash); rewrite them for it");
	});

	it("does not block when the check itself cannot run", async () => {
		const failed = await checkGateCommands(["nope --x"], process.cwd(), bash, fakeRunner([], 2));
		expect(failed.problems).toEqual([]);
		expect(failed.warning).toContain("could not check");
		const thrown = await checkGateCommands(["nope --x"], process.cwd(), bash, async () => {
			throw new Error("spawn failed");
		});
		expect(thrown.problems).toEqual([]);
		expect(thrown.warning).toContain("spawn failed");
	});

	it("skips cmd.exe internals when the gate shell is cmd", async () => {
		const cmd = platformShell("win32");
		const scripts: string[] = [];
		const result = await checkGateCommands(["dir && node a.js"], process.cwd(), cmd, async (script) => {
			scripts.push(script);
			return { exit_code: 0, output: "" };
		});
		expect(result.problems).toEqual([]);
		expect(scripts[0]).toContain("where node");
		expect(scripts[0]).not.toContain("where dir");
	});

	it("builds a script per shell kind", () => {
		expect(buildCheckScript(["a", "b"], "bash")).toBe('for p in a b; do command -v "$p" >/dev/null 2>&1 || echo "MISSING:$p"; done');
		expect(buildCheckScript(["a", "b"], "cmd")).toBe("where a >nul 2>&1 || echo MISSING:a & where b >nul 2>&1 || echo MISSING:b");
	});

	it(
		"finds a real missing program through the real gate shell",
		async () => {
			const shell = await resolveGateShell(process.cwd());
			const result = await checkGateCommands(["node -v && definitely-not-a-real-program-xyz --check"], process.cwd(), shell);
			expect(result.warning).toBeUndefined();
			expect(result.problems).toEqual([{ command: "node -v && definitely-not-a-real-program-xyz --check", missing: ["definitely-not-a-real-program-xyz"] }]);
		},
		TIMEOUT,
	);
});

describe("isUnrunnable", () => {
	it("flags exit 127 and missing-program output, never a successful run", () => {
		expect(isUnrunnable(127, "")).toBe(true);
		expect(isUnrunnable(1, "'grep' is not recognized as an internal or external command,")).toBe(true);
		expect(isUnrunnable(1, "bash: foo: command not found")).toBe(true);
		expect(isUnrunnable(1, "The term 'foo' is not recognized as a cmdlet")).toBe(true);
		expect(isUnrunnable(1, "The system cannot find the path specified.")).toBe(true);
		expect(isUnrunnable(0, "command not found")).toBe(false);
		expect(isUnrunnable(1, "2 tests failed")).toBe(false);
	});
});

describe("runShell in the gate shell", () => {
	it(
		"names the shell and marks a real failure runnable",
		async () => {
			const r = await runShell(`node -e "process.exit(3)"`, process.cwd());
			expect(r.exit_code).toBe(3);
			expect(r.runnable).toBe(true);
			expect(r.shell).toBeTruthy();
		},
		TIMEOUT,
	);

	it(
		"marks a missing program as not runnable",
		async () => {
			const r = await runShell("definitely-not-a-real-program-xyz --check", process.cwd());
			expect(r.exit_code).not.toBe(0);
			expect(r.runnable).toBe(false);
		},
		TIMEOUT,
	);

	it(
		"uses bash semantics (|| true, unix quoting) when a bash resolves",
		async () => {
			const shell = await resolveGateShell(process.cwd());
			if (shell.kind !== "bash") return; // no bash on this machine: nothing to prove
			const r = await runShell(`node -e "process.exit(1)" || true`, process.cwd(), { shell });
			expect(r.exit_code).toBe(0);
			expect(r.shell).toBe(shell.label);
			expect(r.shell).toMatch(/^bash \(/);
		},
		TIMEOUT,
	);
});

describe("resolveBash (shared with hooks)", () => {
	it("still refuses the WSL launcher on Windows", () => {
		const bash = resolveBash({
			platform: "win32",
			env: {},
			pathDirs: ["C:\\Windows\\System32", "C:\\Program Files\\Git\\bin"],
			exists: (p) => p === "C:\\Windows\\System32\\bash.exe" || p === "C:\\Program Files\\Git\\bin\\bash.exe",
		});
		expect(bash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
	});
});
