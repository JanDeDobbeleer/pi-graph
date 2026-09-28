/**
 * Escalation side-call: a single bounded question sent to the escalation-tier model.
 * The escalation tool factory itself lives in index.ts, which owns tool registration.
 */

import type { Model, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Phase } from "./state.ts";

export const ESCALATION_SYSTEM_PROMPT = `You are the escalation-tier reviewer for a coding-agent workflow. The coordinator
running the task has hit one specific judgment call it cannot resolve on its own and is asking you to answer it.

Answer ONLY the question asked. Do not take over the task, do not expand its scope, and do not propose unrelated
changes. Use the evidence and hypothesis given to reach a decision, state any assumptions you had to make, and hand
control back to the coordinator.

Respond in exactly this format:

Decision: <the answer to the question, stated plainly>
Rationale: <why, grounded in the evidence given>`;

export interface EscalationQuestion {
	phase: Phase;
	question: string;
	evidence: string;
	hypothesis: string;
}

const MAX_EVIDENCE_CHARS = 20000;

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} more characters]`;
}

function buildUserMessage(q: EscalationQuestion): UserMessage {
	const evidence = truncate(q.evidence, MAX_EVIDENCE_CHARS);
	const text = `Question:\n${q.question}\n\nEvidence:\n${evidence}\n\nHypothesis so far:\n${q.hypothesis}`;
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export async function runEscalation(
	registry: ModelRegistry,
	model: Model<any>,
	q: EscalationQuestion,
	signal?: AbortSignal,
): Promise<{ decision: string; usage?: unknown }> {
	const response = await registry.complete(model, { systemPrompt: ESCALATION_SYSTEM_PROMPT, messages: [buildUserMessage(q)] }, { signal });

	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(`Escalation call failed: ${response.errorMessage ?? response.stopReason}`);
	}

	const decision = response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (decision.length === 0) {
		throw new Error("Escalation call returned no text content.");
	}

	return { decision, usage: response.usage };
}
