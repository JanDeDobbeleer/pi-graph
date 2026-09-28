/**
 * CI watching for the "ci" phase: after Deliver pushes and a PR exists, poll that PR's checks
 * for the pushed commit and, on failure, collect evidence so the extension can route it back
 * into the workflow (Verify -> Supervise/Analyze) or hand it to the agent outside a run.
 *
 * Uses the `gh` CLI exclusively (no direct GitHub API calls). `gh` is spawned without a shell
 * and never throws; failures are folded into the returned result, mirroring `runShell`/`git`
 * in runner.ts.
 */

import { spawn } from "node:child_process";
import type { CheckRun, CiFailure, PullRequestRef } from "./state.ts";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_APPEAR_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_LOG_MAX_CHARS = 20_000;

export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Spawns `gh <args>` without a shell. Never throws: spawn errors resolve with code 127. */
export async function gh(args: string[], cwd: string, signal?: AbortSignal): Promise<GhResult> {
	return new Promise<GhResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("gh", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
			return;
		}

		const onAbort = () => {
			if (process.platform === "win32") {
				try {
					spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
				} catch {
					/* ignore */
				}
				return;
			}
			try {
				if (proc.pid !== undefined) process.kill(proc.pid, "SIGKILL");
			} catch {
				/* ignore */
			}
		};
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
			if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
				resolve({ code: 127, stdout, stderr: `${stderr}\ngh not found: ${err.message}` });
				return;
			}
			resolve({ code: 127, stdout, stderr: `${stderr}\nSpawn error: ${err instanceof Error ? err.message : String(err)}` });
		});
		proc.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

export const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

/** Finds the last GitHub PR URL mentioned in `text`, if any. */
export function detectPrFromText(text: string): { url: string; number: number } | undefined {
	const matches = text.match(PR_URL_RE);
	if (!matches || matches.length === 0) return undefined;
	const url = matches[matches.length - 1];
	const numMatch = /\/pull\/(\d+)/.exec(url);
	if (!numMatch) return undefined;
	return { url, number: Number(numMatch[1]) };
}

/** True for `git push ...` (including inside `&&`/`;`/`|` chains) and `gh pr create`. */
export function isPushCommand(command: string): boolean {
	const parts = command
		.split(/&&|\|\||;|\|/)
		.map((p) => p.trim())
		.filter(Boolean);
	for (const part of parts) {
		const tokens = part.split(/\s+/);
		if (tokens[0] === "git" && tokens[1] === "push") return true;
		if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "create") return true;
	}
	return false;
}

interface GhPrViewJson {
	number: number;
	url: string;
	headRefOid: string;
	state: string;
}

/** Resolves an open PR via `gh pr view`. `hint` may be a URL, a number, or omitted (current branch). */
export async function resolvePr(cwd: string, hint?: string, signal?: AbortSignal): Promise<PullRequestRef | undefined> {
	const args = ["pr", "view"];
	if (hint !== undefined && hint !== "") args.push(hint);
	args.push("--json", "number,url,headRefOid,state");
	const res = await gh(args, cwd, signal);
	if (res.code !== 0) return undefined;
	let parsed: GhPrViewJson;
	try {
		parsed = JSON.parse(res.stdout) as GhPrViewJson;
	} catch {
		return undefined;
	}
	if (parsed.state !== "OPEN") return undefined;
	return { number: parsed.number, url: parsed.url, headSha: parsed.headRefOid };
}

/** `git rev-parse HEAD` for `cwd`, or undefined outside a git repo / on failure. */
export async function localHead(cwd: string): Promise<string | undefined> {
	const res = await new Promise<GhResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("git", ["rev-parse", "HEAD"], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
			return;
		}
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("error", (err) => resolve({ code: 127, stdout, stderr: err instanceof Error ? err.message : String(err) }));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
	if (res.code !== 0) return undefined;
	const sha = res.stdout.trim();
	return sha.length > 0 ? sha : undefined;
}

interface GhCheckJson {
	name: string;
	state?: string;
	bucket?: string;
	link?: string;
	workflow?: string;
	completedAt?: string;
}

const KNOWN_BUCKETS = new Set(["pending", "pass", "fail", "skipping", "cancel"]);

/** Parses `gh pr checks --json ...` stdout into normalized CheckRun records. Unknown buckets become "pending". */
export function parseChecks(json: string): CheckRun[] {
	if (!json || json.trim() === "") return [];
	let parsed: GhCheckJson[];
	try {
		parsed = JSON.parse(json) as GhCheckJson[];
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.map((c) => {
		const bucket = c.bucket && KNOWN_BUCKETS.has(c.bucket) ? (c.bucket as CheckRun["bucket"]) : "pending";
		return {
			name: c.name,
			bucket,
			link: c.link ?? "",
			workflow: c.workflow,
		};
	});
}

/** Summarizes a set of checks: fail wins over pending, pending over pass; cancel counts as fail. */
export function summarizeChecks(checks: CheckRun[]): { state: "pending" | "pass" | "fail" | "none"; failed: CheckRun[]; pending: CheckRun[] } {
	if (checks.length === 0) return { state: "none", failed: [], pending: [] };
	const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
	const pending = checks.filter((c) => c.bucket === "pending");
	if (failed.length > 0) return { state: "fail", failed, pending };
	if (pending.length > 0) return { state: "pending", failed, pending };
	return { state: "pass", failed, pending };
}

/** Extracts the run id (and job id, if present) from a GitHub Actions check link. */
export function runIdFromLink(link: string): { runId: string; jobId?: string } | undefined {
	const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link);
	if (!m) return undefined;
	return { runId: m[1], jobId: m[2] };
}

/**
 * Fetches failed-step logs for each failed check with an Actions link. Checks without a link
 * are listed with their link only. Each log is tailed (errors are at the end) and the total
 * output is truncated to `opts.maxChars` (default 20000).
 */
export async function collectFailureLogs(cwd: string, failed: CheckRun[], opts?: { maxChars?: number; signal?: AbortSignal }): Promise<string> {
	const maxChars = opts?.maxChars ?? DEFAULT_LOG_MAX_CHARS;
	const sections: string[] = [];

	for (const check of failed) {
		const ids = runIdFromLink(check.link);
		if (!ids) {
			sections.push(`### ${check.name}\n(no Actions run link: ${check.link || "none"})`);
			continue;
		}
		let res: GhResult;
		if (ids.jobId) {
			res = await gh(["run", "view", ids.runId, "--job", ids.jobId, "--log-failed"], cwd, opts?.signal);
			if (res.code !== 0 || res.stdout.trim() === "") {
				res = await gh(["run", "view", ids.runId, "--log-failed"], cwd, opts?.signal);
			}
		} else {
			res = await gh(["run", "view", ids.runId, "--log-failed"], cwd, opts?.signal);
		}
		const body = res.stdout.trim() !== "" ? res.stdout : res.stderr || "(no log output)";
		sections.push(`### ${check.name}\n${body}`);
	}

	// Truncate the whole thing, keeping the tail (errors are usually at the end of a log).
	const combined = sections.join("\n\n");
	if (combined.length <= maxChars) return combined;
	const omitted = combined.length - maxChars;
	return `[... ${omitted} chars truncated ...]\n${combined.slice(combined.length - maxChars)}`;
}

export interface WatchOptions {
	cwd: string;
	pr: PullRequestRef;
	intervalMs?: number;
	appearTimeoutMs?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	onUpdate?(s: ReturnType<typeof summarizeChecks>): void;
	sleep?(ms: number, signal?: AbortSignal): Promise<void>;
	fetchChecks?(pr: PullRequestRef): Promise<{ headSha: string; checks: CheckRun[] }>;
	collectLogs?(cwd: string, failed: CheckRun[], opts?: { maxChars?: number; signal?: AbortSignal }): Promise<string>;
}

export type WatchResult =
	| { kind: "pass"; checks: CheckRun[] }
	| { kind: "fail"; failure: CiFailure }
	| { kind: "none" }
	| { kind: "stale"; headSha: string }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "error"; message: string };

/** Races `promise` against `signal` aborting, so an abort is observed immediately even if `promise` never settles. */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => resolve(undefined as unknown as T);
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

async function defaultFetchChecks(cwd: string, pr: PullRequestRef, signal?: AbortSignal): Promise<{ headSha: string; checks: CheckRun[] }> {
	const viewRes = await gh(["pr", "view", String(pr.number), "--json", "headRefOid"], cwd, signal);
	let headSha = pr.headSha;
	if (viewRes.code === 0) {
		try {
			const parsed = JSON.parse(viewRes.stdout) as { headRefOid: string };
			if (parsed.headRefOid) headSha = parsed.headRefOid;
		} catch {
			/* keep prior headSha */
		}
	}
	// `gh pr checks` exits 8 when pending and 1 when some failed; stdout is still valid JSON either way.
	const checksRes = await gh(["pr", "checks", String(pr.number), "--json", "name,state,bucket,link,workflow,completedAt"], cwd, signal);
	const checks = parseChecks(checksRes.stdout);
	return { headSha, checks };
}

/**
 * Polls a PR's checks for `pr.headSha` until they all pass, one fails, the head moves (stale),
 * no checks appear within `appearTimeoutMs`, the overall `timeoutMs` elapses, or `signal` aborts.
 * Returns as soon as any check has failed, without waiting for the rest.
 */
export async function watchChecks(opts: WatchOptions): Promise<WatchResult> {
	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	const appearTimeoutMs = opts.appearTimeoutMs ?? DEFAULT_APPEAR_TIMEOUT_MS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const sleep = opts.sleep ?? defaultSleep;
	const fetchChecks = opts.fetchChecks ?? ((pr: PullRequestRef) => defaultFetchChecks(opts.cwd, pr, opts.signal));
	const collectLogs = opts.collectLogs ?? ((cwd: string, failed: CheckRun[], o?: { maxChars?: number; signal?: AbortSignal }) => collectFailureLogs(cwd, failed, o));

	const start = Date.now();
	let firstSeenAt: number | undefined;

	try {
		for (;;) {
			if (opts.signal?.aborted) return { kind: "aborted" };
			if (Date.now() - start > timeoutMs) return { kind: "timeout" };

			const fetched = await raceAbort(fetchChecks(opts.pr), opts.signal);

			if (opts.signal?.aborted) return { kind: "aborted" };
			const { headSha, checks } = fetched;

			if (headSha !== opts.pr.headSha) {
				return { kind: "stale", headSha };
			}

			if (checks.length === 0) {
				if (firstSeenAt === undefined) firstSeenAt = Date.now();
				if (Date.now() - firstSeenAt > appearTimeoutMs) return { kind: "none" };
				await sleep(intervalMs, opts.signal);
				if (opts.signal?.aborted) return { kind: "aborted" };
				continue;
			}

			const summary = summarizeChecks(checks);
			opts.onUpdate?.(summary);

			if (summary.state === "fail") {
				const logs = await collectLogs(opts.cwd, summary.failed, { signal: opts.signal });
				return {
					kind: "fail",
					failure: { pr: opts.pr, failed: summary.failed, logs },
				};
			}

			if (summary.state === "pass") {
				return { kind: "pass", checks };
			}

			// pending
			await sleep(intervalMs, opts.signal);
			if (opts.signal?.aborted) return { kind: "aborted" };
		}
	} catch (err) {
		return { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

/** Owns at most one background watch per PR number; a new watch for the same PR aborts the old one. */
export class CiWatcher {
	private controllers = new Map<number, AbortController>();

	start(opts: WatchOptions, onDone: (result: WatchResult) => void): void {
		this.stop(opts.pr.number);
		const controller = new AbortController();
		this.controllers.set(opts.pr.number, controller);

		const signal = opts.signal
			? mergeSignals(opts.signal, controller.signal)
			: controller.signal;

		watchChecks({ ...opts, signal })
			.then((result) => {
				if (this.controllers.get(opts.pr.number) === controller) {
					this.controllers.delete(opts.pr.number);
				}
				onDone(result);
			})
			.catch((err) => {
				if (this.controllers.get(opts.pr.number) === controller) {
					this.controllers.delete(opts.pr.number);
				}
				onDone({ kind: "error", message: err instanceof Error ? err.message : String(err) });
			});
	}

	stop(prNumber?: number): void {
		if (prNumber === undefined) {
			this.stopAll();
			return;
		}
		const controller = this.controllers.get(prNumber);
		if (controller) {
			controller.abort();
			this.controllers.delete(prNumber);
		}
	}

	stopAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}

	active(): number[] {
		return [...this.controllers.keys()];
	}
}

/** Combines two AbortSignals into one that aborts when either does. */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (a.aborted || b.aborted) {
		controller.abort();
	} else {
		a.addEventListener("abort", onAbort, { once: true });
		b.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

/** Formats a CiFailure as markdown for the model, instructing it to classify, fix, re-verify, and push. */
export function formatCiFailure(f: CiFailure): string {
	const lines: string[] = [];
	lines.push(`## CI failed for PR ${f.pr.url}`);
	lines.push("");
	lines.push(`Commit: \`${f.pr.headSha}\``);
	lines.push("");
	lines.push("### Failed checks");
	for (const check of f.failed) {
		const workflow = check.workflow ? `${check.workflow} / ` : "";
		lines.push(`- ${workflow}${check.name}${check.link ? ` — ${check.link}` : ""}`);
	}
	lines.push("");
	lines.push("### Logs");
	lines.push("```");
	lines.push(f.logs);
	lines.push("```");
	lines.push("");
	lines.push(
		"Classify this failure as `gate_failure`/`spec_mismatch` (the change is wrong or incomplete — fix it) " +
			"or `wrong_root_cause` (the original analysis was wrong — go back to Analyze). " +
			"Then fix the issue, re-verify locally with the required gates, and push again.",
	);
	return lines.join("\n");
}
