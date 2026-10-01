/**
 * resume_task: the coordinator's answer to a stalled or spec-gap-blocked implementer.
 *
 * A child `pi -p` process can't be talked to mid-run (see delegate.ts), so "resuming" a task means
 * starting a fresh implementer turn in the same workspace — the original packet, plus the previous
 * attempt's report and the coordinator's decision — and letting it continue from whatever state the
 * workspace is already in. This is the mechanism behind supervise.md's "stop it, diagnose the
 * problem yourself, hand it the answer, and let it proceed" and escalate.md's repeated-spec-gap
 * trigger.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	applySnapshotDiff,
	changedFilesSince,
	commitWorktree,
	DEFAULT_TASK_TIMEOUT_MS,
	deriveWorktreeBase,
	IMPLEMENTER_SYSTEM_PROMPT,
	mainTreeChangesSince,
	outOfScopeFiles,
	parseSpecGaps,
	recordScope,
	runPiAgent,
	snapshotMainTree,
	type MainTreeSnapshot,
} from "./delegate.ts";
import { git } from "./runner.ts";
import { isActive, type Escalation, type ExecutorTier, type TaskRun, type WorkflowState } from "./state.ts";

export const RESUME_TOOL = "resume_task";

const ResumeSchema = Type.Object({
	task_id: Type.String({ description: "The task to resume." }),
	answer: Type.String({
		description: "The coordinator's decision, missing information, or diagnosis to hand back to the implementer.",
	}),
});

export interface ResumeDeps {
	getState(): WorkflowState | undefined;
	/** Persist + update UI, same contract as index.ts's own `setState`. */
	commit(next: WorkflowState, ctx: ExtensionContext): void;
	/** "provider/id", or undefined to let pi use its default model. */
	resolveModel(tier: ExecutorTier, ctx: ExtensionContext): string | undefined;
	escalate(
		q: { question: string; evidence: string; hypothesis: string },
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ decision: string; model: string }>;
	/** Injectable for tests. Defaults to `runPiAgent`. */
	runAgent?: typeof runPiAgent;
	taskTimeoutMs?: number;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} more characters]`;
}

function sanitizeTaskId(id: string): string {
	return id.replace(/[^\w.-]+/g, "_");
}

interface PacketLike {
	spec: string;
	verification_commands: string[];
	standing_instructions: string;
}

function packetForTask(state: WorkflowState, taskId: string): PacketLike {
	const packet = state.packets.find((p) => p.task_id === taskId);
	if (packet) return packet;
	const task = state.plan?.tasks.find((t) => t.id === taskId);
	return { spec: task?.spec ?? "", verification_commands: task?.verification_commands ?? [], standing_instructions: "" };
}

function resumePrompt(packet: PacketLike, run: TaskRun, answer: string): string {
	const verificationBlock =
		packet.verification_commands.length > 0 ? packet.verification_commands.map((c) => `- ${c}`).join("\n") : "- (none specified)";
	return [
		packet.spec.trim(),
		`Verification commands:\n${verificationBlock}`,
		packet.standing_instructions.trim(),
		`Previous attempt report:\n${truncate(run.report ?? "(no report)", 6000)}`,
		`Coordinator decision:\n${answer}`,
		"Continue from the current state of the workspace; do not redo finished work.",
	]
		.filter((part) => part.length > 0)
		.join("\n\n");
}

/** escalate.md: "an implementer has reported a spec gap or contradiction more than once on the same task." */
export function needsSpecGapEscalation(run: TaskRun): boolean {
	return (run.spec_gaps?.length ?? 0) >= 2 && !run.escalated;
}

/**
 * Runs the bounded escalation side-call for a task whose spec gaps have repeated, and folds the
 * result into `state` (the run marked `escalated`, an `Escalation` record appended). Exported so
 * index.ts can call it right after `run_delegation` too — the initial delegation run can trip the
 * same trigger, not just a resume.
 */
export async function escalateSpecGaps(
	run: TaskRun,
	state: WorkflowState,
	deps: Pick<ResumeDeps, "escalate">,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<{ state: WorkflowState; decision: string }> {
	const packet = packetForTask(state, run.task_id);
	const gaps = run.spec_gaps ?? [];
	const gapsText = gaps.map((g, i) => `${i + 1}. ${g}`).join("\n");
	const question = `Implementer for task ${run.task_id} reported spec gaps more than once:\n${gapsText}`;
	const evidence = truncate(
		[`Spec:\n${packet.spec}`, `Spec gaps reported:\n${gapsText}`, `Latest report:\n${run.report ?? ""}`].join("\n\n"),
		2000,
	);
	const hypothesis = run.report ?? "";

	const result = await deps.escalate({ question, evidence, hypothesis }, ctx, signal);

	const updatedRun: TaskRun = { ...run, escalated: true };
	const record: Escalation = { phase: "supervise", question, evidence, hypothesis, model: result.model, decision: result.decision };
	const nextState: WorkflowState = {
		...state,
		runs: state.runs.map((r) => (r.task_id === run.task_id ? updatedRun : r)),
		escalations: [...state.escalations, record],
	};
	return { state: nextState, decision: result.decision };
}

export function createResumeTaskTool(deps: ResumeDeps): ToolDefinition<typeof ResumeSchema, { run: TaskRun }> {
	return {
		name: RESUME_TOOL,
		label: "Resume task",
		description:
			"Resume a stalled or spec-gap-blocked implementer with the coordinator's decision, continuing in its own workspace (worktree or main tree).",
		parameters: ResumeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const state = deps.getState();
			if (!state || !isActive(state) || state.phase !== "supervise") {
				throw new Error(`resume_task is only valid in the Supervise phase of an active run (current: ${state ? state.phase : "no active run"}).`);
			}

			const task = state.plan?.tasks.find((t) => t.id === params.task_id);
			const run = state.runs.find((r) => r.task_id === params.task_id);
			if (!task || !run) {
				throw new Error(`resume_task: unknown task "${params.task_id}".`);
			}
			if (task.executor_tier === "coordinator-direct") {
				throw new Error(`resume_task: task "${params.task_id}" is coordinator-direct and has no implementer to resume.`);
			}

			const packet = packetForTask(state, params.task_id);
			const prompt = resumePrompt(packet, run, params.answer);
			const runAgent = deps.runAgent ?? runPiAgent;
			const timeoutMs = deps.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
			const model = deps.resolveModel(task.executor_tier, ctx);

			const isWorktree = !!run.worktree;
			const workDir = run.worktree ?? ctx.cwd;

			let beforeHead: string | undefined;
			if (isWorktree) {
				const headResult = await git(["rev-parse", "HEAD"], workDir, signal);
				beforeHead = headResult.code === 0 ? headResult.stdout.trim() : undefined;
			}

			const mainBefore: MainTreeSnapshot | undefined = isWorktree ? undefined : await snapshotMainTree(workDir, signal);

			onUpdate?.({ content: [{ type: "text", text: `Resuming task ${params.task_id}...` }], details: { run } });

			const result = await runAgent({
				cwd: workDir,
				model,
				systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
				task: prompt,
				signal,
				timeoutMs,
			});

			const resumes = (run.resumes ?? 0) + 1;
			const updatedRun: TaskRun = {
				...run,
				model: model ?? run.model,
				report: result.text,
				spec_gaps: [...(run.spec_gaps ?? []), ...parseSpecGaps(result.text)],
				stalled: result.timedOut,
				resumes,
			};

			// Recompute the scope check. A worktree's whole diff against its starting commit is still
			// available; for the main tree only this resume's changes are, so earlier violations that are
			// still dirty are kept.
			if (isWorktree) {
				const base = await deriveWorktreeBase(workDir, ctx.cwd, signal, run.base_snapshot);
				const files = base ? await changedFilesSince(workDir, base, signal) : [];
				recordScope(updatedRun, base ? outOfScopeFiles(files, task) : (run.out_of_scope ?? []));
			} else if (mainBefore) {
				const changed = await mainTreeChangesSince(workDir, mainBefore, signal);
				const stillDirty = new Set(await changedFilesSince(workDir, "HEAD", signal));
				const carried = (run.out_of_scope ?? []).filter((f) => stillDirty.has(f));
				recordScope(updatedRun, [...new Set([...carried, ...outOfScopeFiles(changed, task)])].sort());
			}

			if (result.timedOut) {
				updatedRun.status = "failed";
				updatedRun.error = `stalled: exceeded ${Math.round(timeoutMs / 60_000)} min budget`;
			} else if (result.exitCode !== 0) {
				updatedRun.status = "failed";
				updatedRun.error = result.stderr.slice(-2000) || `implementer exited with code ${result.exitCode}`;
			} else {
				updatedRun.status = "succeeded";
				updatedRun.error = undefined;
			}

			let mergeNote = "";
			if (isWorktree && updatedRun.status === "succeeded") {
				const commit = await commitWorktree(workDir, params.task_id, `wip(${params.task_id}): resume ${resumes}`);
				if (commit.committed) {
					if (run.merged) {
						// Already merged into the main tree: apply only the delta this resume produced.
						const afterHead = commit.head;
						if (beforeHead && afterHead && beforeHead !== afterHead) {
							const diffResult = await git(["diff", beforeHead, afterHead], workDir, signal);
							const patch = diffResult.stdout;
							if (patch.trim().length === 0) {
								mergeNote = "Resume made no new commits beyond the merged state.";
							} else {
								const patchFile = path.join(os.tmpdir(), `pi-cc-resume-${sanitizeTaskId(params.task_id)}-${Date.now()}.patch`);
								await fs.promises.writeFile(patchFile, patch, "utf-8");
								try {
									const applyResult = await git(["apply", "--index", "--3way", patchFile], ctx.cwd, signal);
									if (applyResult.code !== 0) {
										updatedRun.conflict = true;
										const conflictFiles = await git(["diff", "--name-only", "--diff-filter=U"], ctx.cwd, signal);
										mergeNote = `Applying the resume delta conflicted: ${applyResult.stderr || applyResult.stdout}. Conflicted files: ${
											conflictFiles.stdout.trim() || "(none reported)"
										}`;
									} else {
										mergeNote = "Resume delta applied to the main tree.";
									}
								} finally {
									try {
										await fs.promises.unlink(patchFile);
									} catch {
										/* ignore */
									}
								}
							}
						} else {
							mergeNote = "Resume made no new commits beyond the merged state.";
						}
					} else if (run.branch) {
						// Not merged yet (e.g. the initial run failed before merge): squash-merge like
						// runDelegation's own merge step.
						if (run.base_snapshot) {
							const applied = await applySnapshotDiff(ctx.cwd, run.base_snapshot, run.branch, params.task_id, signal);
							if (applied.ok) {
								updatedRun.merged = true;
								mergeNote = `Merged ${run.branch} into the main tree.`;
							} else {
								updatedRun.conflict = true;
								mergeNote = `Applying ${run.branch} to the main tree failed: ${applied.error}. Patch kept at ${applied.patchFile}`;
							}
						} else {
							const mergeResult = await git(["merge", "--squash", run.branch], ctx.cwd, signal);
							if (mergeResult.code !== 0) {
								updatedRun.conflict = true;
								const conflictFiles = await git(["diff", "--name-only", "--diff-filter=U"], ctx.cwd, signal);
								mergeNote = `Merge conflict merging ${run.branch}: ${mergeResult.stderr || mergeResult.stdout}. Conflicted files: ${
									conflictFiles.stdout.trim() || "(none reported)"
								}`;
							} else {
								updatedRun.merged = true;
								mergeNote = `Merged ${run.branch} into the main tree.`;
							}
						}
					}
				}
			}

			let nextState: WorkflowState = { ...state, runs: state.runs.map((r) => (r.task_id === params.task_id ? updatedRun : r)) };

			let escalationNote = "";
			if (needsSpecGapEscalation(updatedRun)) {
				try {
					const { state: escalatedState, decision } = await escalateSpecGaps(updatedRun, nextState, deps, ctx, signal);
					nextState = escalatedState;
					escalationNote = `\n\nEscalation: ${decision}\n\nApply this decision: update the answer and call resume_task again, or cut scope and document it in submit_review overrides.`;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					escalationNote = `\n\nEscalation failed: ${message}`;
				}
			}

			deps.commit(nextState, ctx);

			const finalRun = nextState.runs.find((r) => r.task_id === params.task_id) ?? updatedRun;
			const text = [`Task ${params.task_id} resumed (attempt ${resumes}): ${finalRun.status}.`, mergeNote, escalationNote]
				.filter((s) => s.length > 0)
				.join("\n\n");

			return { content: [{ type: "text", text }], details: { run: finalRun } };
		},
	};
}
