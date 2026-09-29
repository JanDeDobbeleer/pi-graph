/**
 * Detection and backoff for transient provider errors that pi's own agent-level retry does not
 * cover. pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN` (dist/utils/retry.js) already retries the
 * common transient cases (429/500/502/503/504, network errors, timeouts, ...) but lacks 499/408/
 * 409/425 and "client closed"/"no body"-style wording some gateways return. By the time
 * `agent_before_settle` sees `event.outcome === "error"`, pi has already exhausted its own retry
 * budget for the request — this module governs a second, harness-owned retry layer for a bounded
 * number of additional attempts, only while a `/change` run owns a model-driven phase.
 */

export const MAX_TRANSIENT_RETRIES = 3;

// 499/408/409/425 (status codes pi-ai's own pattern doesn't cover), plus common
// "the connection died mid-stream" wording from various gateways/proxies.
const TRANSIENT_PATTERN =
	/\b(499|408|409|425)\b|client closed|no body|ECONNRESET|EPIPE|premature close|stream (?:ended|closed)|aborted by (?:the )?server/i;

// Never retry an error that's actually a quota/billing/auth/validation problem, even if it
// happens to also match the transient wording above (e.g. a 409 that's really a conflict on the
// account, not the connection).
const NON_TRANSIENT_PATTERN = /quota|billing|\blimit\b|\bauth\b|\b401\b|\b403\b|invalid|context length/i;

/** Whether `message` looks like a transient provider error pi's own retry gave up on. */
export function isTransientProviderError(message: string | undefined): boolean {
	if (!message) return false;
	if (NON_TRANSIENT_PATTERN.test(message)) return false;
	return TRANSIENT_PATTERN.test(message);
}

/** Backoff delay for the n-th retry (1-indexed): 2000 * 2^(n-1) ms. */
export function retryBackoffMs(attempt: number): number {
	return 2000 * 2 ** (attempt - 1);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

let sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep;

/** Test hook: override the backoff sleep implementation (so tests don't actually wait). */
export function setRetrySleep(fn: (ms: number, signal?: AbortSignal) => Promise<void>): void {
	sleepImpl = fn;
}

/** Resets the backoff sleep implementation to the real timer-based one. */
export function resetRetrySleep(): void {
	sleepImpl = defaultSleep;
}

/** Waits the backoff delay for retry attempt `n` (1-indexed), abortable via `signal`. */
export async function retryBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
	await sleepImpl(retryBackoffMs(attempt), signal);
}
