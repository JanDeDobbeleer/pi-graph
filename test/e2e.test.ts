/**
 * End-to-end test: drives the REAL pi runtime in-process (createAgentSession, a real
 * ExtensionAPI, real tool_call gating) with a scripted fake model, to prove the harness
 * actually enforces the code-changes gates -- not just that the pure functions in
 * artifacts.ts/gates.ts behave correctly in isolation.
 *
 * No network, no real model calls: model responses come from a scripted queue consumed by a
 * `streamSimple` implementation registered as a custom provider ("fake"). Gating is exercised
 * only through the real tool_call/agent_end/agent_before_settle flow -- never by calling
 * decideToolCall (or any other extension-internal function) directly.
 *
 * API surface verified against: dist/core/sdk.d.ts, dist/core/extensions/types.d.ts,
 * dist/core/agent-session.d.ts, docs/sdk.md, docs/custom-provider.md,
 * examples/sdk/{06-extensions,12-full-control}.ts, examples/extensions/custom-provider-anthropic/index.ts.
 */
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, ToolCall, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import codeChanges from "../extensions/code-changes/index.ts";
import { git } from "../extensions/code-changes/runner.ts";

const TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Temp repo
// ---------------------------------------------------------------------------

async function makeTempRepo(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-e2e-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await fs.promises.writeFile(path.join(dir, "greeting.txt"), "Hello\n", "utf-8");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "chore: initial commit"], dir);
	return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

const cleanupDirs: string[] = [];
afterEach(async () => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Scripted fake model: a queue of steps, one per model turn (one per streamSimple call).
// Each step is either a single tool call or a plain text response. A `before` hook lets a step
// perform a side effect (e.g. writing a file) exactly when that turn is produced, standing in
// for "the model reacted to what it was just told".
// ---------------------------------------------------------------------------

type ScriptStep = { tool: string; args: Record<string, unknown>; before?: () => void } | { text: string; before?: () => void };

function usage() {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantStub(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/**
 * Builds a scripted AssistantMessageEventStream for one queued step, or an idle fallback when the
 * queue is empty. `onIdle` runs on every idle fallback call (there can be more than one: e.g. once
 * for a turn the harness triggered on its own, then again after a stop-hook block feeds back in)
 * and may perform a side effect and/or override the fallback text.
 */
function scriptedStream(model: Model<Api>, step: ScriptStep | undefined, onIdle?: () => string | void): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		step?.before?.();
		const output = assistantStub(model);
		stream.push({ type: "start", partial: output });

		if (!step) {
			// Queue exhausted: settle quietly instead of crashing an unexpected extra turn.
			const text = onIdle?.() || "(no more scripted turns)";
			const idx = output.content.length;
			output.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: idx, partial: output });
			stream.push({ type: "text_end", contentIndex: idx, content: text, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
			return;
		}

		if ("tool" in step) {
			const idx = output.content.length;
			const toolCall: ToolCall = { type: "toolCall", id: `call_${idx}_${Date.now()}`, name: step.tool, arguments: step.args as ToolCall["arguments"] };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
			stream.end();
			return;
		}

		const idx = output.content.length;
		output.content.push({ type: "text", text: step.text });
		stream.push({ type: "text_start", contentIndex: idx, partial: output });
		stream.push({ type: "text_delta", contentIndex: idx, delta: step.text, partial: output });
		stream.push({ type: "text_end", contentIndex: idx, content: step.text, partial: output });
		output.stopReason = "stop";
		stream.push({ type: "done", reason: "stop", message: output });
		stream.end();
	})();
	return stream;
}

/** Registers the "fake" provider and returns { model, queue, setOnIdle } so a test can drive it. */
function makeFakeProvider(): {
	extension: (pi: ExtensionAPI) => void;
	model: Model<Api>;
	queue: ScriptStep[];
	setOnIdle: (fn: (() => string | void) | undefined) => void;
} {
	const queue: ScriptStep[] = [];
	let onIdle: (() => string | void) | undefined;
	const model: Model<Api> = {
		id: "fake-model",
		name: "Fake Model",
		api: "fake-api" as Api,
		provider: "fake",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_000,
	};

	function extension(pi: ExtensionAPI): void {
		pi.registerProvider("fake", {
			api: "fake-api" as Api,
			apiKey: "test-key",
			streamSimple: (m: Model<Api>, _context: TranscriptContext, _options?: SimpleStreamOptions) => scriptedStream(m, queue.shift(), onIdle),
		});
	}

	return { extension, model, queue, setOnIdle: (fn) => (onIdle = fn) };
}

// ---------------------------------------------------------------------------
// Session setup
// ---------------------------------------------------------------------------

async function makeSession(repo: string, extraExtensions: ((pi: ExtensionAPI) => void)[], model: Model<Api>) {
	const agentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cc-e2e-agentdir-"));
	cleanupDirs.push(agentDir);

	const resourceLoader = new DefaultResourceLoader({
		cwd: repo,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [codeChanges, ...extraExtensions],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: repo,
		agentDir,
		model,
		resourceLoader,
		sessionManager: SessionManager.inMemory(repo),
		// No `tools` allowlist: it would filter the tool *registry* itself (not just what's
		// active), which would silently drop every custom code-changes tool before our own
		// per-phase pi.setActiveTools(...) calls ever get a chance to run.
	});
	return session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("code-changes e2e (real pi runtime, scripted fake model)", () => {
	it(
		"enforces every gate across the full graph, with no PR to watch",
		async () => {
			const repo = await makeTempRepo();
			cleanupDirs.push(repo);
			const { extension: fakeProvider, model, queue } = makeFakeProvider();
			const session = await makeSession(repo, [fakeProvider], model);

			try {
				// --- Analyze: the model tries to write before analyzing; the harness must block it. ---
				queue.push({ tool: "write", args: { path: "sneaky.txt", content: "should never land" } });
				queue.push({
					tool: "submit_analysis",
					args: {
						root_cause: "greeting.txt says Hello instead of Hi",
						proposed_change: "change the greeting text to Hi",
						out_of_scope: "nothing else",
						repro_status: "reproduced: read greeting.txt",
						open_questions: [],
					},
				});

				await session.prompt("/change fix the greeting");
				await session.waitForIdle();

				if (process.env.E2E_DEBUG) {
					console.log(JSON.stringify(session.messages.map((m: any) => ({ role: m.role, customType: m.customType, toolName: m.toolName, isError: m.isError, content: m.content })), null, 2));
				}

				expect(fs.existsSync(path.join(repo, "sneaky.txt"))).toBe(false);
				const blockedResult = session.messages.find(
					(m) => m.role === "toolResult" && m.toolName === "write" && m.isError,
				);
				expect(blockedResult).toBeDefined();
				const blockedText = (blockedResult as any)?.content?.map((c: any) => c.text).join(" ") ?? "";
				// "write" isn't even declared active during Analyze (setActiveTools per phase), so the
				// harness's own tool dispatch rejects it before our tool_call gate ever runs -- an even
				// stronger guarantee than a same-turn block. Either rejection form proves the gate held.
				expect(blockedText.toLowerCase()).toMatch(/not found|analyze/);

				// --- awaiting_approval: no UI in this session, so the run parks; /change approve continues it. ---
				const readyMessage = session.messages.find((m) => {
					const content = (m as any).content;
					const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? "").join(" ") : "";
					return /ready for approval/i.test(text);
				});
				expect(readyMessage).toBeDefined();

				queue.push({
					tool: "submit_plan",
					args: {
						tasks: [
							{
								id: "t1",
								spec: "Change greeting.txt to say Hi instead of Hello.",
								verification_commands: ['node -e "process.exit(0)"'],
								executor_tier: "coordinator-direct",
								workspace: "main",
								dependencies: [],
							},
						],
					},
				});
				queue.push({ tool: "run_delegation", args: {} });
				// Supervise: make the real edit, then submit the review.
				queue.push({ tool: "write", args: { path: "greeting.txt", content: "Hi\n" } });
				queue.push({ tool: "submit_review", args: { overrides: [], tests_kept: [], tests_cut: [] } });
				// Verify: a pass without running gates first must be rejected...
				queue.push({ tool: "submit_verification", args: { outcome: "pass", functional_proof: "read greeting.txt: Hi" } });
				// ...then the model runs the required gate and passes for real.
				queue.push({ tool: "run_gates", args: { commands: ['node -e "process.exit(0)"'] } });
				queue.push({ tool: "submit_verification", args: { outcome: "pass", functional_proof: "read greeting.txt: Hi" } });
				// Deliver: commit with a conventional-commit subject, then report.
				queue.push({ tool: "bash", args: { command: 'git add -A && git commit -m "fix: greeting"' } });
				queue.push({ tool: "submit_delivery", args: { report: "Changed the greeting from Hello to Hi." } });

				await session.prompt("/change approve");
				await session.waitForIdle();

				// The whole graph ran without a PR (no gh / no remote): the run must have completed at "done".
				expect(fs.readFileSync(path.join(repo, "greeting.txt"), "utf-8").trim()).toBe("Hi");

				const rejectedPass = session.messages.find(
					(m) => m.role === "toolResult" && m.toolName === "submit_verification" && m.isError,
				);
				expect(rejectedPass).toBeDefined();
				const rejectedText = (rejectedPass as any)?.content?.map((c: any) => c.text).join(" ") ?? "";
				expect(rejectedText.toLowerCase()).toContain("gate");

				const log = await git(["log", "--format=%s"], repo);
				expect(log.stdout.split("\n").filter(Boolean)).toContain("fix: greeting");

				const finalMessage = session.messages
					.slice()
					.reverse()
					.find((m) => m.role !== "user" && (m as any).customType === "code-changes-phase");
				expect(finalMessage).toBeDefined();
			} finally {
				session.dispose();
			}
		},
		TIMEOUT,
	);

	it(
		"blocks finishing on a repo Stop hook and gives the model the feedback for another turn",
		async () => {
			const repo = await makeTempRepo();
			cleanupDirs.push(repo);

			// An agentStop hook (Copilot format) that blocks until MARKER exists in the repo root.
			await writeJson(path.join(repo, ".github", "hooks", "quality.json"), {
				version: 1,
				hooks: {
					agentStop: [
						{
							type: "command",
							bash: "node -e \"process.exit(require('fs').existsSync('MARKER') ? 0 : 2)\"",
							// powershell.exe -Command does not auto-propagate a native command's own exit code as
						// its own (it maps any nonzero exit to 1) unless the script ends with an explicit
						// `exit $LASTEXITCODE` -- true of the real Claude Code / Copilot CLI harnesses too,
						// since they invoke the configured script the same way; this is how a hook author
						// writing a powershell block has to end it, not something the harness works around.
						powershell: "node -e \"process.exit(require('fs').existsSync('MARKER') ? 0 : 2)\"; exit $LASTEXITCODE",
						},
					],
				},
			});

			const { extension: fakeProvider, model, queue, setOnIdle } = makeFakeProvider();
			const session = await makeSession(repo, [fakeProvider], model);

			// The harness only re-checks "should this turn settle?" (agent_before_settle) once its
			// whole chain of automatically-triggered turns would otherwise go idle -- not after every
			// individual tool call, and that chain can include more than one idle turn before it ever
			// gets there. So the marker that satisfies the Stop hook must not be written eagerly; it
			// has to appear only once the harness has actually fed a hook block back in.
			let sawHookFeedback = false;
			setOnIdle(() => {
				// Once the harness has actually fed a stop-hook block back in (a "code-changes-hook"
				// custom message appears), fix it; otherwise stay idle. This is robust to however many
				// turns the harness's own chaining needs before it first attempts to settle.
				if (!sawHookFeedback) {
					sawHookFeedback = session.messages.some((m: any) => m.customType === "code-changes-hook");
				}
				if (sawHookFeedback && !fs.existsSync(path.join(repo, "MARKER"))) {
					fs.writeFileSync(path.join(repo, "MARKER"), "1");
					return "Investigated the stop-hook block and satisfied it.";
				}
				return "(waiting)";
			});

			try {
				queue.push({
					tool: "submit_analysis",
					args: {
						root_cause: "greeting.txt says Hello instead of Hi",
						proposed_change: "change the greeting text to Hi",
						out_of_scope: "nothing else",
						repro_status: "reproduced: read greeting.txt",
						open_questions: [],
					},
				});
				queue.push({
					tool: "submit_plan",
					args: {
						tasks: [
							{
								id: "t1",
								spec: "Change greeting.txt to say Hi instead of Hello.",
								verification_commands: ['node -e "process.exit(0)"'],
								executor_tier: "coordinator-direct",
								workspace: "main",
								dependencies: [],
							},
						],
					},
				});
				queue.push({ tool: "run_delegation", args: {} });
				// Dirty the tree, then try to end the phase: the Stop hook fires and blocks (no MARKER yet).
				queue.push({ tool: "write", args: { path: "greeting.txt", content: "Hi\n" } });
				queue.push({ tool: "submit_review", args: { overrides: [], tests_kept: [], tests_cut: [] } });

				await session.prompt("/change --approved fix the greeting");
				await session.waitForIdle();

				if (process.env.E2E_DEBUG) {
					console.log(JSON.stringify(session.messages.map((m: any) => ({ role: m.role, customType: m.customType, toolName: m.toolName, isError: m.isError, content: m.content })), null, 2));
				}

				const hookFeedback = session.messages.find((m) => (m as any).customType === "code-changes-hook");
				expect(hookFeedback).toBeDefined();
				const feedbackText =
					typeof (hookFeedback as any)?.content === "string" ? (hookFeedback as any).content : ((hookFeedback as any)?.content ?? []).map((c: any) => c.text).join(" ");
				expect(feedbackText.toLowerCase()).toContain("stop hook");

				expect(fs.existsSync(path.join(repo, "MARKER"))).toBe(true);
			} finally {
				session.dispose();
			}
		},
		TIMEOUT,
	);
});
