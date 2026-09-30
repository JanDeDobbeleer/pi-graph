/**
 * Gate-decision log: every human decision at the analysis and plan approval gates, recorded with
 * the artifact the human saw and (when a gate advisor ran) what it suggested. Every gate is decided
 * by a human today, so each record is a ground-truth label for "would the human approve this
 * unchanged?" -- the data an advisor's suggestions are measured against before they are trusted.
 *
 * Pure logic plus one best-effort file append; index.ts owns the session entry and the wiring.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { analysisGateChoices, hasProposedChange, optionIdFromChoice } from "./artifacts.ts";
import type { AnalysisReport, TaskList, WorkflowState } from "./state.ts";

export const GATE_DECISION_ENTRY = "code-changes-gate-decision";

export type GateKind = "analysis" | "plan";

/** What the human did at a gate. Everything but approve/approve_push/choose_option means "not as submitted". */
export type GateDecision = "approve" | "approve_push" | "choose_option" | "edit" | "revise" | "done" | "stop";

/** One entry of a gate dialog: the label shown, and the decision it stands for. */
export interface GateChoice {
	label: string;
	decision: GateDecision;
	/** For choose_option: the analysis option this label picks. */
	optionId?: string;
}

export const PLAN_GATE_LABELS = ["Approve — start delegation", "Edit the plan myself", "Send feedback to revise", "Stop the run"];

const DECISION_BY_LABEL: Record<string, GateDecision> = {
	Approve: "approve",
	"Approve and allow push/PR": "approve_push",
	"Approve — start delegation": "approve",
	"Edit the analysis myself": "edit",
	"Edit the plan myself": "edit",
	"Send feedback to revise": "revise",
	"Done — no implementation": "done",
	"Stop the run": "stop",
};

/** The dialog entries for a gate, in dialog order. The labels stay owned by the gate code (analysisGateChoices / PLAN_GATE_LABELS). */
export function gateChoices(gate: GateKind, state: Pick<WorkflowState, "analysis">): GateChoice[] {
	const labels = gate === "analysis" ? (state.analysis ? analysisGateChoices(state.analysis) : []) : PLAN_GATE_LABELS;
	const choices: GateChoice[] = [];
	for (const label of labels) {
		const optionId = gate === "analysis" && state.analysis ? optionIdFromChoice(state.analysis, label) : undefined;
		if (optionId !== undefined) {
			choices.push({ label, decision: "choose_option", optionId });
			continue;
		}
		const decision = DECISION_BY_LABEL[label];
		if (decision) choices.push({ label, decision });
	}
	return choices;
}

/** A gate advisor's suggestion, as shown to the human and stored with their decision. */
export interface GateAdvice {
	provider: string;
	/** Model version the advisor reported, when it did. */
	model?: string;
	decision: GateDecision;
	optionId?: string;
	/** 0..1, as reported by the advisor (uncalibrated until fitted on this log). */
	confidence: number;
	/** Per-choice probabilities keyed by decision (or `choose_option:<id>`), when reported. */
	probabilities?: Record<string, number>;
	latencyMs: number;
	/** Fingerprint of the artifact the advice was computed for. */
	fingerprint: string;
}

/** Past decisions in this run, so a gate knows which round it is in and an advisor can see the history. */
export interface GateHistoryItem {
	gate: GateKind;
	decision: GateDecision;
	optionId?: string;
}

export interface GateDecisionRecord {
	version: 1;
	runId: string;
	task: string;
	entry: WorkflowState["entry"];
	cwd: string;
	gate: GateKind;
	/** 1 for the first time this gate was decided in the run; revise/edit loops increment it. */
	round: number;
	decision: GateDecision;
	optionId?: string;
	/** Revise feedback, when given. */
	feedback?: string;
	via: "dialog" | "command";
	/** Analysis kind, for the analysis gate. */
	kind?: AnalysisReport["kind"];
	/** The artifact exactly as the human saw it when deciding. */
	artifact: AnalysisReport | TaskList;
	fingerprint: string;
	editedByHuman: boolean;
	/** Whether the artifact carried open questions / a proposed change (analysis gate only). */
	openQuestions?: number;
	proposedChange?: boolean;
	/** The advisor's suggestion shown at this gate, and whether the human took it. */
	advice?: GateAdvice & { followed: boolean };
	decidedAt: string;
}

export function gateForPhase(phase: WorkflowState["phase"]): GateKind | undefined {
	if (phase === "awaiting_approval") return "analysis";
	if (phase === "awaiting_plan_approval") return "plan";
	return undefined;
}

export function gateArtifact(gate: GateKind, state: Pick<WorkflowState, "analysis" | "plan">): AnalysisReport | TaskList | undefined {
	return gate === "analysis" ? state.analysis : state.plan;
}

/** Stable across key order, so a re-render of the same artifact reuses cached advice. */
export function fingerprint(artifact: unknown): string {
	return createHash("sha256").update(stableStringify(artifact)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function gateRound(history: GateHistoryItem[] | undefined, gate: GateKind): number {
	return (history ?? []).filter((h) => h.gate === gate).length + 1;
}

/** Whether a suggestion matches what the human did (same decision, same option for choose_option). */
export function adviceFollowed(advice: Pick<GateAdvice, "decision" | "optionId">, decision: GateDecision, optionId?: string): boolean {
	return advice.decision === decision && (decision !== "choose_option" || advice.optionId === optionId);
}

export interface DecisionInput {
	gate: GateKind;
	decision: GateDecision;
	optionId?: string;
	feedback?: string;
	via: "dialog" | "command";
	cwd: string;
	now?: Date;
}

/**
 * Build the record for a decision made on `state` (the state *before* the decision is applied, so
 * the artifact is the one the human saw). Advice is attached only when it was computed for this
 * exact artifact. Returns undefined when the gate has no artifact (nothing to label).
 */
export function buildDecisionRecord(state: WorkflowState, input: DecisionInput): GateDecisionRecord | undefined {
	const artifact = gateArtifact(input.gate, state);
	if (!artifact) return undefined;
	const fp = fingerprint(artifact);
	const cached = state.gateAdvice;
	const advice = cached && cached.gate === input.gate && cached.advice.fingerprint === fp ? cached.advice : undefined;
	const analysis = input.gate === "analysis" ? state.analysis : undefined;
	return {
		version: 1,
		runId: state.id,
		task: state.task,
		entry: state.entry,
		cwd: input.cwd,
		gate: input.gate,
		round: gateRound(state.gateHistory, input.gate),
		decision: input.decision,
		optionId: input.optionId,
		feedback: input.feedback?.trim() || undefined,
		via: input.via,
		kind: analysis?.kind,
		artifact,
		fingerprint: fp,
		editedByHuman: (input.gate === "analysis" ? state.analysisEditedByHuman : state.planEditedByHuman) ?? false,
		openQuestions: analysis ? analysis.open_questions.length : undefined,
		proposedChange: analysis ? hasProposedChange(analysis) : undefined,
		advice: advice ? { ...advice, followed: adviceFollowed(advice, input.decision, input.optionId) } : undefined,
		decidedAt: (input.now ?? new Date()).toISOString(),
	};
}

/** The state after recording a decision: history grows, cached advice is dropped (the next round gets fresh advice). */
export function withDecisionRecorded(state: WorkflowState, record: GateDecisionRecord): WorkflowState {
	return {
		...state,
		gateHistory: [...(state.gateHistory ?? []), { gate: record.gate, decision: record.decision, optionId: record.optionId }],
		gateAdvice: undefined,
	};
}

/** Best effort: a log that cannot be written never blocks a gate. Returns the error message, if any. */
export function appendDecisionLog(file: string, record: GateDecisionRecord): string | undefined {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
		return undefined;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
