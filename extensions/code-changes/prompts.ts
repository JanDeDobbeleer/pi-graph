/**
 * Prompt assembly for the code-changes workflow: resolves the bundled skill directory, reads
 * per-phase reference files, and builds the instruction text sent into the conversation on every
 * phase transition (`phasePrompt`) and on every user prompt while a run is active (`phaseReminder`).
 *
 * No pi runtime calls here — this module only reads files under `skills/code-changes/` and formats
 * strings from `WorkflowState`. `index.ts` calls into it and owns actually sending the message.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredGateCommands, summarizeState } from "./artifacts.ts";
import { PHASE_ARTIFACT_TOOL, PHASE_TOOLS } from "./gates.ts";
import { PHASE_LABEL, type Phase, type WorkflowState } from "./state.ts";

// ---------------------------------------------------------------------------
// Skill directory resolution
// ---------------------------------------------------------------------------

function resolveSkillDir(): string {
	let here: string;
	try {
		here = path.dirname(fileURLToPath(import.meta.url));
	} catch {
		// import.meta.url can be unavailable under some loaders (e.g. jiti in certain configs).
		// eslint-disable-next-line no-undef
		here = typeof __dirname !== "undefined" ? __dirname : process.cwd();
	}
	return path.resolve(here, "../../skills/code-changes");
}

export const SKILL_DIR = resolveSkillDir();

// ---------------------------------------------------------------------------
// Reference file loading
// ---------------------------------------------------------------------------

const referenceCache = new Map<string, string>();

/** Reads `references/<name>.md` from the skill directory. Cached; missing files return a warning comment. */
export function readReference(name: string): string {
	const cached = referenceCache.get(name);
	if (cached !== undefined) return cached;

	const filePath = path.join(SKILL_DIR, "references", `${name}.md`);
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		content = `<!-- code-changes: reference file "${name}.md" not found at ${filePath} -->`;
	}
	referenceCache.set(name, content);
	return content;
}

/** Which reference files back each model-driven phase's instructions. */
export const PHASE_REFERENCE: Partial<Record<Phase, string[]>> = {
	analyze: ["analyze", "escalate"],
	plan: ["plan"],
	delegate: ["delegate"],
	supervise: ["supervise", "escalate"],
	verify: ["verify", "escalate"],
	deliver: ["deliver"],
};

let artifactsDoc: string | undefined;
function artifactsReference(): string {
	if (artifactsDoc === undefined) artifactsDoc = readReference("artifacts");
	return artifactsDoc;
}

// ---------------------------------------------------------------------------
// Phase prompt
// ---------------------------------------------------------------------------

function toolsLine(phase: Phase): string {
	return PHASE_TOOLS[phase].join(", ");
}

function phaseExtra(state: WorkflowState): string | undefined {
	switch (state.phase) {
		case "analyze":
			return "Edit and write are blocked in this phase. When the analysis report is submitted, a human must approve it (or revise it) before Plan begins.";
		case "delegate":
			return "Call run_delegation now; it dispatches the plan's tasks.";
		case "supervise": {
			const lines: string[] = [];
			const coordinatorTasks = state.runs.filter((r) => r.status === "coordinator");
			if (coordinatorTasks.length > 0) {
				lines.push(
					`Coordinator-direct task(s) the coordinator must implement itself: ${coordinatorTasks.map((r) => r.task_id).join(", ")}.`,
				);
			}
			const conflicts = state.runs.filter((r) => r.conflict);
			if (conflicts.length > 0) {
				lines.push(`Run(s) with an unresolved merge conflict that must be resolved before review: ${conflicts.map((r) => r.task_id).join(", ")}.`);
			}
			lines.push("The implementer report for each dispatched task is in the run_delegation result above.");
			return lines.join("\n");
		}
		case "verify": {
			const lines: string[] = [];
			const required = requiredGateCommands(state);
			lines.push(
				required.length > 0
					? `Required gate commands (run them through run_gates, not through bash directly): ${required.join(", ")}`
					: "This plan listed no verification_commands; running run_gates with an empty list is not valid — report the gap instead.",
			);
			lines.push("Bash results do not count as gate evidence. A pass is rejected unless every required gate is green in the latest run_gates result.");
			const lastFailure = state.failures[state.failures.length - 1];
			if (lastFailure) {
				lines.push("");
				lines.push(`## Latest failure record (attempt ${lastFailure.attempt_number})`);
				lines.push(`- failure_class: ${lastFailure.failure_class}`);
				lines.push(`- destination: ${lastFailure.destination}`);
				lines.push(`- summary: ${lastFailure.summary}`);
				if (lastFailure.escalation_answer) {
					lines.push(`- escalation_answer: ${lastFailure.escalation_answer}`);
				}
			}
			return lines.join("\n");
		}
		case "deliver":
			return (
				"Commit with conventional commits (subjects are validated against git log since the base ref), then call submit_delivery with an outcome-first report. " +
				"If you open a PR or push, the harness watches its checks; the run only completes when they pass."
			);
		case "ci":
			return state.pr
				? `Waiting on CI checks for PR #${state.pr.number} (${state.pr.url}). No tool call is needed: the harness watches the checks and resumes this run automatically when they finish.`
				: "Waiting on CI checks. No tool call is needed: the harness resumes this run automatically when they finish.";
		default:
			return undefined;
	}
}

/** The full instruction sent on entering a model-driven phase. */
export function phasePrompt(state: WorkflowState, extra?: string): string {
	const lines: string[] = [];
	lines.push(`[code-changes] Phase: ${PHASE_LABEL[state.phase]} (run ${state.id})`);
	lines.push("");
	lines.push(`## Task\n${state.task}`);

	const references = PHASE_REFERENCE[state.phase] ?? [];
	for (const name of references) {
		lines.push("");
		lines.push(`## Reference: ${name}.md`);
		lines.push(readReference(name));
	}

	lines.push("");
	lines.push("## Artifact contract (artifacts.md)");
	lines.push(artifactsReference());

	lines.push("");
	lines.push("## Prior state");
	lines.push(summarizeState(state));

	lines.push("");
	lines.push(`## Tools available in this phase\n${toolsLine(state.phase)}`);

	const builtinExtra = phaseExtra(state);
	if (builtinExtra) {
		lines.push("");
		lines.push(builtinExtra);
	}
	if (extra?.trim()) {
		lines.push("");
		lines.push(`## Additional context\n${extra.trim()}`);
	}

	const artifactTool = PHASE_ARTIFACT_TOOL[state.phase];
	lines.push("");
	lines.push(
		artifactTool
			? `This phase ends only when you call \`${artifactTool}\`. The harness blocks tools outside this phase.`
			: "This phase ends only when the workflow advances it. The harness blocks tools outside this phase.",
	);

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Per-turn reminder
// ---------------------------------------------------------------------------

/** Short reminder injected on every user prompt while a run is active. */
export function phaseReminder(state: WorkflowState): string {
	const lines: string[] = [];
	lines.push(`[code-changes] Run ${state.id} — phase: ${PHASE_LABEL[state.phase]}.`);
	lines.push(`Task: ${state.task}`);
	lines.push(`Allowed tools: ${toolsLine(state.phase)}`);
	if (state.phase === "ci") {
		lines.push(
			state.pr
				? `Waiting on CI checks for PR #${state.pr.number}. The harness resumes this run automatically when they finish; use /change status to check, /change watch to restart watching, or /change abort to stop.`
				: "Waiting on CI checks. Use /change status.",
		);
		return lines.join("\n");
	}
	const artifactTool = PHASE_ARTIFACT_TOOL[state.phase];
	lines.push(artifactTool ? `Exit this phase by calling \`${artifactTool}\`.` : "This phase awaits a human decision (/change approve|revise|abort).");
	return lines.join("\n");
}
