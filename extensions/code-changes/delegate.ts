/**
 * Delegate phase: fan a plan's tasks out to sub-agent `pi` processes (worktree tasks in
 * parallel, main-tree tasks sequentially), then fan the worktree branches back in. Which tasks
 * end up in worktrees is decided by `effectiveWorkspace` (planning.ts): independent tasks with
 * disjoint `paths` are moved there automatically so they can run concurrently, up to `maxParallel`.
 *
 * The sub-agent spawning pattern (spawn `pi --mode json -p --no-session ...`, parse JSON-lines
 * events for `message_end`, collect the final assistant text and usage) is adapted from
 * `examples/extensions/subagent/index.ts` in `@earendil-works/pi-coding-agent`. It is copied and
 * trimmed down here rather than imported, since the example is not a published module.
 *
 * Uncommitted changes: when the main tree is dirty, a snapshot commit of the whole working tree
 * (tracked changes plus untracked files) is built without touching the real index or working
 * tree, and worktrees branch from it, so tasks see the uncommitted work and can run in parallel.
 * Because the main tree already contains that content, worktree branches are then merged back by
 * applying each task's own diff (snapshot..branch) instead of `git merge --squash`.
 *
 * Worktree merge strategy: a later-wave worktree task always branches from the start commit (`HEAD`
 * or the snapshot, not from an earlier wave's branch), so if it depends on an earlier-wave worktree
 * task, its own worktree would not otherwise see that task's changes. We fix this up right after creating the worktree,
 * by running `git merge --no-edit <depBranch>` inside it for every succeeded worktree dependency.
 * Main-tree tasks that depend on a worktree task do NOT get this treatment: the worktree branch
 * only lands in the main tree during the final merge step, after every wave has run. Sequencing a
 * main-tree task after a worktree task it depends on is therefore only safe when the dependency
 * itself doesn't need to be visible in the main tree's files (e.g. it just needs to have
 * happened) — plan accordingly in Phase 2.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchesAnyPath, normalizePath } from "./paths.ts";
import { effectiveWorkspace, isSubAgentTask, planWorkspaces, topologicalWaves, type WorkspaceDecision } from "./planning.ts";
import { git } from "./runner.ts";
import type { DelegationPacket, ExecutorTier, PlanTask, TaskList, TaskRun } from "./state.ts";

export { effectiveWorkspace };

// ---------------------------------------------------------------------------
// Sub-agent process spawning
// ---------------------------------------------------------------------------

/** Resolves how to re-invoke the running `pi` binary, mirroring the reference subagent example. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(name: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-prompt-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Default per-task time budget before a stalled implementer is killed (supervise.md). */
export const DEFAULT_TASK_TIMEOUT_MS = 20 * 60_000;

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

export interface RunPiAgentOptions {
	cwd: string;
	model?: string;
	systemPrompt: string;
	task: string;
	signal?: AbortSignal;
	tools?: string[];
	/** Kills the sub-agent process tree once exceeded. Defaults to `DEFAULT_TASK_TIMEOUT_MS`. */
	timeoutMs?: number;
}

export interface RunPiAgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens?: number;
	turns?: number;
}

export interface RunPiAgentResult {
	exitCode: number;
	text: string;
	stderr: string;
	usage?: RunPiAgentUsage;
	/** True when the process was killed for exceeding `timeoutMs`. */
	timedOut: boolean;
}

/**
 * Spawns a fresh, session-less `pi` subprocess in JSON mode to execute one delegated task, and
 * collects its final assistant text. `--no-extensions` keeps the child from loading this very
 * extension (or any project extension that might otherwise interfere with a scoped implementer
 * run). A child `pi -p` process can't be talked to mid-run, so a stalled or looping implementer is
 * handled by killing it once it exceeds its time budget (`timeoutMs`) — the coordinator then
 * decides whether to resume it (see `resume.ts`).
 */
export async function runPiAgent(opts: RunPiAgentOptions): Promise<RunPiAgentResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (opts.model) args.push("--model", opts.model);
	const tools = opts.tools ?? DEFAULT_TOOLS;
	args.push("--tools", tools.join(","));

	let tmpDir: string | undefined;
	let tmpFile: string | undefined;
	const usage: RunPiAgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	let lastAssistantText = "";
	let stderr = "";
	let timedOut = false;

	try {
		const promptFile = await writePromptToTempFile("implementer", opts.systemPrompt);
		tmpDir = promptFile.dir;
		tmpFile = promptFile.filePath;
		args.push("--append-system-prompt", tmpFile);
		args.push(`Task: ${opts.task}`);

		const timeoutMs = opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) {
					const msg = event.message;
					if (msg.role === "assistant") {
						usage.turns = (usage.turns ?? 0) + 1;
						const u = msg.usage;
						if (u) {
							usage.input += u.input || 0;
							usage.output += u.output || 0;
							usage.cacheRead += u.cacheRead || 0;
							usage.cacheWrite += u.cacheWrite || 0;
							usage.cost += u.cost?.total || 0;
							usage.contextTokens = u.totalTokens ?? usage.contextTokens;
						}
						for (const part of msg.content ?? []) {
							if (part.type === "text" && typeof part.text === "string") lastAssistantText = part.text;
						}
					}
				}
			};

			const timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessTree(proc.pid);
			}, timeoutMs);

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				clearTimeout(timeoutHandle);
				if (buffer.trim()) processLine(buffer);
				resolve(timedOut ? 124 : code ?? 0);
			});
			proc.on("error", (err) => {
				clearTimeout(timeoutHandle);
				stderr += `\nSpawn error: ${err instanceof Error ? err.message : String(err)}`;
				resolve(127);
			});

			if (opts.signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});

		return { exitCode, text: lastAssistantText, stderr, usage, timedOut };
	} finally {
		if (tmpFile) {
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				/* ignore */
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				/* ignore */
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

/** Groups tasks into dependency waves. Throws on a cycle. Same implementation as `topologicalWaves`. */
export const topoWaves = topologicalWaves;

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export interface DelegateDeps {
	cwd: string;
	runId: string;
	/** "provider/id", or undefined to let pi use its default model. */
	resolveModel(tier: ExecutorTier): string | undefined;
	signal?: AbortSignal;
	onProgress?(runs: TaskRun[]): void;
	/** Injectable for tests. Defaults to `runPiAgent`. */
	runAgent?: typeof runPiAgent;
	/** Per-task time budget passed to `runPiAgent`. Defaults to `DEFAULT_TASK_TIMEOUT_MS`. */
	taskTimeoutMs?: number;
	/** Cap on concurrently running implementer processes (worktree tasks and the main-tree chain). Defaults to 4. */
	maxParallel?: number;
}

export const DEFAULT_MAX_PARALLEL = 4;

export const IMPLEMENTER_SYSTEM_PROMPT = [
	"You are an implementer executing one pinned task from a larger plan.",
	"Stay strictly in scope: implement only what the task spec below describes, and do not touch files or behavior outside it.",
	"Run the verification commands listed in the task before you report done.",
	"If the spec does not cover something, stop and write a line starting with `SPEC GAP:` describing the question; do not improvise scope.",
	"End your final message with a report: what changed, what you verified (and the result), and any spec gap you found.",
].join(" ");

/** Matches every `SPEC GAP: ...` line an implementer's report wrote (delegate.md / supervise.md). */
export function parseSpecGaps(report: string): string[] {
	const gaps: string[] = [];
	const regex = /^\s*SPEC GAP:\s*(.+)$/gim;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(report)) !== null) {
		gaps.push(match[1].trim());
	}
	return gaps;
}

/**
 * Stages and commits everything in `worktree`. Returns `{ committed: false }` (no throw) when
 * there is nothing to commit or the commit itself fails, so callers can fold that into their own
 * run status/error handling.
 */
export async function commitWorktree(worktree: string, taskId: string, message?: string): Promise<{ committed: boolean; head?: string }> {
	await git(["add", "-A"], worktree);
	const statusResult = await git(["status", "--porcelain"], worktree);
	if (statusResult.stdout.trim() === "") {
		return { committed: false };
	}
	const commitResult = await git(["commit", "-m", message ?? `wip(${taskId}): implementer output`, "--no-verify"], worktree);
	if (commitResult.code !== 0) {
		return { committed: false };
	}
	const headResult = await git(["rev-parse", "HEAD"], worktree);
	return { committed: true, head: headResult.code === 0 ? headResult.stdout.trim() : undefined };
}

// ---------------------------------------------------------------------------
// Scope check: did the implementer stay inside the task's declared `paths`?
// ---------------------------------------------------------------------------

/** Prefix of the spec-gap line recorded for a run that changed files outside its declared paths. */
export const SCOPE_GAP_PREFIX = "changed files outside its declared paths:";

async function gitLines(args: string[], cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await git(["-c", "core.quotepath=false", ...args], cwd, signal);
	if (result.code !== 0) return [];
	return result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map(normalizePath);
}

/** Files that differ from `base` in `dir`'s working tree (committed, staged or unstaged), plus untracked files. Repo-relative. */
export async function changedFilesSince(dir: string, base: string, signal?: AbortSignal): Promise<string[]> {
	const [tracked, untracked] = await Promise.all([
		gitLines(["diff", "--name-only", "--no-renames", base], dir, signal),
		gitLines(["ls-files", "--others", "--exclude-standard", "--full-name"], dir, signal),
	]);
	return [...new Set([...tracked, ...untracked])].sort();
}

/** Dirty-file snapshot of the main tree (name -> size:mtime), taken before a main-tree implementer runs. */
export type MainTreeSnapshot = Map<string, string>;

export async function snapshotMainTree(cwd: string, signal?: AbortSignal): Promise<MainTreeSnapshot> {
	const rootResult = await git(["rev-parse", "--show-toplevel"], cwd, signal);
	const root = rootResult.code === 0 && rootResult.stdout.trim() ? rootResult.stdout.trim() : cwd;
	const snapshot: MainTreeSnapshot = new Map();
	for (const file of await changedFilesSince(cwd, "HEAD", signal)) {
		try {
			const stat = await fs.promises.stat(path.join(root, file));
			snapshot.set(file, `${stat.size}:${stat.mtimeMs}`);
		} catch {
			snapshot.set(file, "missing");
		}
	}
	return snapshot;
}

/** Files that are new, newly modified, or no longer dirty compared with `before`. */
export async function mainTreeChangesSince(cwd: string, before: MainTreeSnapshot, signal?: AbortSignal): Promise<string[]> {
	const after = await snapshotMainTree(cwd, signal);
	const changed = new Set<string>();
	for (const [file, signature] of after) {
		if (before.get(file) !== signature) changed.add(file);
	}
	for (const file of before.keys()) {
		if (!after.has(file)) changed.add(file);
	}
	return [...changed].sort();
}

/**
 * The commit a worktree's own work started from: the latest dependency-merge commit on its branch
 * (changes brought in by earlier tasks are not this task's), else the fork point from the main tree's HEAD
 * (or from `snapshot`, the commit of uncommitted changes the worktree branched from, when given).
 */
export async function deriveWorktreeBase(
	worktree: string,
	mainCwd: string,
	signal?: AbortSignal,
	snapshot?: string,
): Promise<string | undefined> {
	let head = snapshot;
	if (!head) {
		const mainHead = await git(["rev-parse", "HEAD"], mainCwd, signal);
		if (mainHead.code !== 0) return undefined;
		head = mainHead.stdout.trim();
	}
	const merges = await git(["rev-list", "--merges", "-n", "1", "HEAD", `^${head}`], worktree, signal);
	if (merges.code === 0 && merges.stdout.trim()) return merges.stdout.trim();
	const forkPoint = await git(["merge-base", "HEAD", head], worktree, signal);
	return forkPoint.code === 0 && forkPoint.stdout.trim() ? forkPoint.stdout.trim() : undefined;
}

/**
 * Commits the main tree's full working state (tracked changes plus untracked, non-ignored files)
 * without touching the real index or working tree: a temporary index is filled from HEAD, `add -A`
 * picks up the working tree, and the resulting tree becomes a commit on top of HEAD. Returns the
 * commit sha, or undefined when the tree is clean or the snapshot could not be built. The commit is
 * unreferenced, so `git gc` eventually reclaims it.
 */
export async function snapshotDirtyTree(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	const status = await git(["status", "--porcelain"], cwd, signal);
	if (status.code !== 0 || status.stdout.trim() === "") return undefined;
	const indexFile = path.join(os.tmpdir(), `pi-cc-snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`);
	const env = { GIT_INDEX_FILE: indexFile };
	try {
		if ((await git(["read-tree", "HEAD"], cwd, signal, env)).code !== 0) return undefined;
		if ((await git(["add", "-A"], cwd, signal, env)).code !== 0) return undefined;
		const tree = await git(["write-tree"], cwd, signal, env);
		if (tree.code !== 0 || !tree.stdout.trim()) return undefined;
		const commit = await git(
			[
				"-c",
				"user.name=pi-cc",
				"-c",
				"user.email=pi-cc@localhost",
				"commit-tree",
				tree.stdout.trim(),
				"-p",
				"HEAD",
				"-m",
				"pi-cc snapshot of uncommitted changes",
			],
			cwd,
			signal,
			env,
		);
		return commit.code === 0 && commit.stdout.trim() ? commit.stdout.trim() : undefined;
	} finally {
		try {
			await fs.promises.unlink(indexFile);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Lands a worktree branch on the main tree when the worktree started from a snapshot of the main
 * tree's uncommitted changes: applies the task's own diff (snapshot..branch) to the working tree
 * only. On failure the patch file is kept and its path returned so the coordinator can inspect it.
 */
export async function applySnapshotDiff(
	cwd: string,
	snapshot: string,
	branch: string,
	label: string,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; patchFile: string; error: string }> {
	const diff = await git(["diff", "--binary", snapshot, branch], cwd, signal);
	const patchFile = path.join(os.tmpdir(), `pi-cc-merge-${sanitizeTaskId(label)}-${Date.now()}.patch`);
	if (diff.code !== 0) return { ok: false, patchFile, error: `git diff failed: ${tail(diff.stderr || diff.stdout)}` };
	if (diff.stdout.trim() === "") return { ok: true };
	await fs.promises.writeFile(patchFile, diff.stdout, "utf-8");
	const applyResult = await git(["apply", "--whitespace=nowarn", patchFile], cwd, signal);
	if (applyResult.code !== 0) return { ok: false, patchFile, error: tail(applyResult.stderr || applyResult.stdout) };
	try {
		await fs.promises.unlink(patchFile);
	} catch {
		/* ignore */
	}
	return { ok: true };
}

/** The changed files that fall outside `task.paths` (none when the task declares no paths). */
export function outOfScopeFiles(files: string[], task: PlanTask): string[] {
	if (!task.paths || task.paths.length === 0) return [];
	return files.filter((file) => !matchesAnyPath(file, task.paths as string[]));
}

/** Records the scope-check result on a run: `out_of_scope`, plus one (replaced, not duplicated) spec-gap line. */
export function recordScope(run: TaskRun, outOfScope: string[]): void {
	const gaps = (run.spec_gaps ?? []).filter((gap) => !gap.startsWith(SCOPE_GAP_PREFIX));
	if (outOfScope.length > 0) {
		run.out_of_scope = outOfScope;
		gaps.push(`${SCOPE_GAP_PREFIX} ${outOfScope.join(", ")}`);
	} else {
		run.out_of_scope = undefined;
	}
	run.spec_gaps = gaps;
}

// ---------------------------------------------------------------------------
// Concurrency helpers
// ---------------------------------------------------------------------------

/** Minimal counting semaphore: caps concurrent implementer processes without extra dependencies. */
class Semaphore {
	private free: number;
	private waiters: Array<() => void> = [];

	constructor(count: number) {
		this.free = count;
	}

	async acquire(): Promise<() => void> {
		if (this.free > 0) {
			this.free -= 1;
		} else {
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) next();
			else this.free += 1;
		};
	}
}

/** `git worktree add` writes shared refs; run those one at a time even when the tasks themselves run in parallel. */
let worktreeAddQueue: Promise<unknown> = Promise.resolve();
function serializeWorktreeAdd<T>(fn: () => Promise<T>): Promise<T> {
	const result = worktreeAddQueue.then(fn, fn);
	worktreeAddQueue = result.catch(() => undefined);
	return result;
}

function buildTaskPrompt(spec: string, verificationCommands: string[], standingInstructions: string): string {
	const verificationBlock =
		verificationCommands.length > 0 ? verificationCommands.map((c) => `- ${c}`).join("\n") : "- (none specified)";
	return [spec.trim(), `Verification commands:\n${verificationBlock}`, standingInstructions.trim()]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function tail(text: string, maxChars = 2000): string {
	return text.length > maxChars ? text.slice(-maxChars) : text;
}

function sanitizeTaskId(id: string): string {
	return id.replace(/[^\w.-]+/g, "_");
}

function taskPacketPrompt(task: PlanTask, packet: DelegationPacket | undefined): string {
	if (packet) return buildTaskPrompt(packet.spec, packet.verification_commands, packet.standing_instructions);
	return buildTaskPrompt(task.spec, task.verification_commands, "");
}

async function runWorktreeTask(
	task: PlanTask,
	packet: DelegationPacket | undefined,
	run: TaskRun,
	deps: DelegateDeps,
	plan: TaskList,
	decisions: Map<string, WorkspaceDecision>,
	allRuns: TaskRun[],
	notify: () => void,
	snapshot?: string,
): Promise<void> {
	run.status = "running";
	notify();

	const sanitized = sanitizeTaskId(task.id);
	const branch = `pi-cc/${deps.runId}/${sanitized}`;
	const worktreePath = path.join(os.tmpdir(), "pi-cc", `${deps.runId}-${sanitized}`);

	await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
	const addResult = await serializeWorktreeAdd(() => git(["worktree", "add", "-b", branch, worktreePath, snapshot ?? "HEAD"], deps.cwd, deps.signal));
	if (addResult.code !== 0) {
		run.status = "failed";
		run.error = `git worktree add failed: ${tail(addResult.stderr || addResult.stdout)}`;
		notify();
		return;
	}
	run.worktree = worktreePath;
	run.branch = branch;
	run.base_snapshot = snapshot;

	// Pull in any earlier-wave worktree dependency's changes: this worktree branched from the start commit
	// and never saw them otherwise (see module doc comment).
	for (const depId of task.dependencies) {
		const depTask = plan.tasks.find((t) => t.id === depId);
		if (!depTask || decisions.get(depTask.id)?.workspace !== "worktree") continue;
		const depRun = allRuns.find((r) => r.task_id === depId);
		if (!depRun || depRun.status !== "succeeded" || !depRun.branch) continue;
		const mergeResult = await git(["merge", "--no-edit", depRun.branch], worktreePath, deps.signal);
		if (mergeResult.code !== 0) {
			run.status = "failed";
			run.error = `failed to merge dependency branch ${depRun.branch}: ${tail(mergeResult.stderr || mergeResult.stdout)}`;
			notify();
			return;
		}
	}

	// Everything up to here (including merged dependency branches) is not this task's work.
	const baseResult = await git(["rev-parse", "HEAD"], worktreePath, deps.signal);
	const base = baseResult.code === 0 ? baseResult.stdout.trim() : undefined;

	const model = deps.resolveModel(task.executor_tier);
	const runAgent = deps.runAgent ?? runPiAgent;
	const timeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	const result = await runAgent({
		cwd: worktreePath,
		model,
		systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
		task: taskPacketPrompt(task, packet),
		signal: deps.signal,
		timeoutMs,
	});
	run.model = model;
	run.report = result.text;
	run.spec_gaps = [...(run.spec_gaps ?? []), ...parseSpecGaps(result.text)];
	run.stalled = result.timedOut;
	if (base) recordScope(run, outOfScopeFiles(await changedFilesSince(worktreePath, base, deps.signal), task));

	if (result.timedOut) {
		run.status = "failed";
		run.error = `stalled: exceeded ${Math.round(timeoutMs / 60_000)} min budget`;
		notify();
		return;
	}

	if (result.exitCode !== 0) {
		run.status = "failed";
		run.error = tail(result.stderr) || `implementer exited with code ${result.exitCode}`;
		notify();
		return;
	}

	const commit = await commitWorktree(worktreePath, task.id);
	if (!commit.committed) {
		run.status = "failed";
		run.error = "implementer made no changes";
		notify();
		return;
	}

	run.status = "succeeded";
	notify();
}

async function runMainTask(
	task: PlanTask,
	packet: DelegationPacket | undefined,
	run: TaskRun,
	deps: DelegateDeps,
	notify: () => void,
): Promise<void> {
	run.status = "running";
	notify();

	const before = await snapshotMainTree(deps.cwd, deps.signal);
	const model = deps.resolveModel(task.executor_tier);
	const runAgent = deps.runAgent ?? runPiAgent;
	const timeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	const result = await runAgent({
		cwd: deps.cwd,
		model,
		systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
		task: taskPacketPrompt(task, packet),
		signal: deps.signal,
		timeoutMs,
	});
	run.model = model;
	run.report = result.text;
	run.spec_gaps = [...(run.spec_gaps ?? []), ...parseSpecGaps(result.text)];
	run.stalled = result.timedOut;
	recordScope(run, outOfScopeFiles(await mainTreeChangesSince(deps.cwd, before, deps.signal), task));

	if (result.timedOut) {
		run.status = "failed";
		run.error = `stalled: exceeded ${Math.round(timeoutMs / 60_000)} min budget`;
	} else if (result.exitCode !== 0) {
		run.status = "failed";
		run.error = tail(result.stderr) || `implementer exited with code ${result.exitCode}`;
	} else {
		run.status = "succeeded";
	}
	notify();
}

/**
 * Runs a plan's tasks wave by wave: coordinator-direct tasks are marked (not spawned); tasks whose
 * effective workspace is a worktree (declared, or moved there by the harness so independent tasks can
 * run in parallel) run concurrently, main-tree tasks in a wave run sequentially in `deps.cwd`, and at
 * most `deps.maxParallel` implementer processes run at once. After every wave has finished,
 * successful worktree branches are squash-merged into `deps.cwd` in `merge_plan` order (or plan
 * order), stopping at the first conflict so the coordinator can resolve it in Supervise.
 */
export async function runDelegation(
	plan: TaskList,
	packets: DelegationPacket[],
	deps: DelegateDeps,
): Promise<{ runs: TaskRun[]; mergeLog: string[] }> {
	const mergeLog: string[] = [];
	const allRuns: TaskRun[] = plan.tasks.map((t) => ({ task_id: t.id, status: "pending" as const }));
	const notify = () => deps.onProgress?.(allRuns.slice());

	const decisions = planWorkspaces(plan);
	const waves = topoWaves(plan.tasks);
	const slots = new Semaphore(Math.max(1, Math.floor(deps.maxParallel ?? DEFAULT_MAX_PARALLEL)));

	const statusResult = await git(["status", "--porcelain"], deps.cwd, deps.signal);
	const dirty = statusResult.stdout.trim() !== "";
	let snapshot: string | undefined;
	if (dirty) {
		snapshot = await snapshotDirtyTree(deps.cwd, deps.signal);
		mergeLog.push(
			snapshot
				? `main tree has uncommitted changes; worktrees branch from snapshot ${snapshot.slice(0, 8)} so they see them`
				: "main tree has uncommitted changes, but a snapshot could not be built; worktrees branch from HEAD and will not see them",
		);
	}

	for (const t of plan.tasks) {
		const decision = decisions.get(t.id);
		const run = allRuns.find((r) => r.task_id === t.id);
		if (!decision?.auto || !run) continue;
		run.auto_worktree = true;
		mergeLog.push(`task ${t.id} moved to a worktree ${decision.reason}`);
	}

	for (const wave of waves) {
		const coordinatorTasks = wave.filter((t) => !isSubAgentTask(t));
		const subAgentTasks = wave.filter(isSubAgentTask);
		const worktreeTasks = subAgentTasks.filter((t) => decisions.get(t.id)?.workspace === "worktree");
		const mainTasks = subAgentTasks.filter((t) => decisions.get(t.id)?.workspace !== "worktree");

		for (const t of coordinatorTasks) {
			const run = allRuns.find((r) => r.task_id === t.id);
			if (!run) continue;
			run.status = "coordinator";
		}
		if (coordinatorTasks.length > 0) notify();

		const worktreePromise = Promise.all(
			worktreeTasks.map(async (t) => {
				const run = allRuns.find((r) => r.task_id === t.id);
				if (!run) return;
				const packet = packets.find((p) => p.task_id === t.id);
				const release = await slots.acquire();
				try {
					await runWorktreeTask(t, packet, run, deps, plan, decisions, allRuns, notify, snapshot);
				} finally {
					release();
				}
			}),
		);

		const mainPromise = (async () => {
			for (const t of mainTasks) {
				const run = allRuns.find((r) => r.task_id === t.id);
				if (!run) continue;
				const packet = packets.find((p) => p.task_id === t.id);
				const release = await slots.acquire();
				try {
					await runMainTask(t, packet, run, deps, notify);
				} finally {
					release();
				}
			}
		})();

		await Promise.all([worktreePromise, mainPromise]);
	}

	// Merge worktree branches back into the main tree, in merge_plan order (default: plan order).
	const worktreeTaskIdsInPlanOrder = plan.tasks
		.filter((t) => isSubAgentTask(t) && decisions.get(t.id)?.workspace === "worktree")
		.map((t) => t.id);
	const declaredOrder = plan.merge_plan?.order;
	const mergeOrder = declaredOrder
		? [...declaredOrder, ...worktreeTaskIdsInPlanOrder.filter((id) => !declaredOrder.includes(id))]
		: worktreeTaskIdsInPlanOrder;
	const unmergedRemaining: string[] = [];
	let stopMerging = false;

	for (const taskId of mergeOrder) {
		const run = allRuns.find((r) => r.task_id === taskId);
		if (!run || run.status !== "succeeded" || !run.branch) continue;
		if (stopMerging) {
			unmergedRemaining.push(taskId);
			continue;
		}
		if (snapshot) {
			// The main tree already holds the snapshot's content: apply only this task's own diff.
			const applied = await applySnapshotDiff(deps.cwd, snapshot, run.branch, taskId, deps.signal);
			if (!applied.ok) {
				run.conflict = true;
				mergeLog.push(`conflict applying ${run.branch} (${taskId}) to the main tree: ${applied.error}; patch kept at ${applied.patchFile}`);
				stopMerging = true;
				continue;
			}
			run.merged = true;
			mergeLog.push(`merged ${run.branch} (${taskId})`);
			continue;
		}
		const mergeResult = await git(["merge", "--squash", run.branch], deps.cwd, deps.signal);
		if (mergeResult.code !== 0) {
			run.conflict = true;
			const conflictFiles = await git(["diff", "--name-only", "--diff-filter=U"], deps.cwd, deps.signal);
			mergeLog.push(
				`conflict merging ${run.branch} (${taskId}): ${tail(mergeResult.stderr || mergeResult.stdout)}; conflicted files: ${
					conflictFiles.stdout.trim() || "(none reported)"
				}`,
			);
			stopMerging = true;
			continue;
		}
		run.merged = true;
		mergeLog.push(`merged ${run.branch} (${taskId})`);
	}
	if (unmergedRemaining.length > 0) {
		mergeLog.push(`unmerged, coordinator must resolve the conflict above first: ${unmergedRemaining.join(", ")}`);
	}
	notify();

	return { runs: allRuns, mergeLog };
}

/** Removes a run's worktree and its branch, best-effort. Worktrees are never auto-removed by `runDelegation`. */
export async function cleanupWorktrees(runs: TaskRun[], cwd: string): Promise<void> {
	for (const run of runs) {
		if (!run.worktree) continue;
		await git(["worktree", "remove", "--force", run.worktree], cwd);
		if (run.branch) await git(["branch", "-D", run.branch], cwd);
	}
}

/**
 * Builds the reviewable diff for Supervise: staged + unstaged changes against `HEAD` (this is
 * where `git merge --squash` leaves its result), plus untracked files, plus a stat summary against
 * `baseRef` when it differs from `HEAD` (e.g. commits landed during Verify retries). Returns "" if
 * there is nothing to show.
 */
export async function mergedDiff(cwd: string, baseRef: string | undefined, maxChars = 60000): Promise<string> {
	const [statResult, diffResult, untrackedResult, headResult] = await Promise.all([
		git(["diff", "HEAD", "--stat"], cwd),
		git(["diff", "HEAD"], cwd),
		git(["ls-files", "--others", "--exclude-standard"], cwd),
		git(["rev-parse", "HEAD"], cwd),
	]);

	const parts: string[] = [];
	if (statResult.stdout.trim()) parts.push(`## Diff stat (HEAD)\n${statResult.stdout.trim()}`);
	if (diffResult.stdout.trim()) parts.push(`## Diff (HEAD)\n${diffResult.stdout}`);
	if (untrackedResult.stdout.trim()) parts.push(`## Untracked files\n${untrackedResult.stdout.trim()}`);

	const head = headResult.stdout.trim();
	if (baseRef && baseRef !== head) {
		const baseDiffResult = await git(["diff", baseRef, "HEAD", "--stat"], cwd);
		if (baseDiffResult.stdout.trim()) parts.push(`## Diff stat (${baseRef}..HEAD)\n${baseDiffResult.stdout.trim()}`);
	}

	if (parts.length === 0) return "";

	const combined = parts.join("\n\n");
	if (combined.length <= maxChars) return combined;
	const headLen = Math.floor(maxChars * 0.7);
	const tailLen = maxChars - headLen;
	return `${combined.slice(0, headLen)}\n\n[... ${combined.length - maxChars} chars truncated ...]\n\n${combined.slice(combined.length - tailLen)}`;
}
