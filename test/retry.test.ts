import { afterEach, describe, expect, it } from "vitest";
import { isTransientProviderError, MAX_TRANSIENT_RETRIES, resetRetrySleep, retryBackoff, retryBackoffMs, setRetrySleep } from "../extensions/code-changes/retry.ts";

afterEach(() => {
	resetRetrySleep();
});

describe("isTransientProviderError", () => {
	it.each(["499 status code (no body)", "client closed request", "ECONNRESET", "EPIPE", "premature close", "stream ended unexpectedly", "aborted by the server", "408 request timeout", "409 conflict from gateway", "425 too early"])(
		"treats %s as transient",
		(message) => {
			expect(isTransientProviderError(message)).toBe(true);
		},
	);

	it.each([
		undefined,
		"",
		"insufficient_quota: you exceeded your current quota",
		"401 Unauthorized",
		"403 Forbidden",
		"rate limit exceeded",
		"context length exceeded",
		"invalid request: bad parameter",
		"billing issue on this account",
	])("does not treat %s as transient", (message) => {
		expect(isTransientProviderError(message)).toBe(false);
	});

	it("caps retries at 3", () => {
		expect(MAX_TRANSIENT_RETRIES).toBe(3);
	});
});

describe("retryBackoffMs", () => {
	it("doubles per attempt starting at 2000ms", () => {
		expect(retryBackoffMs(1)).toBe(2000);
		expect(retryBackoffMs(2)).toBe(4000);
		expect(retryBackoffMs(3)).toBe(8000);
	});
});

describe("retryBackoff", () => {
	it("uses the injectable sleep implementation", async () => {
		const calls: number[] = [];
		setRetrySleep(async (ms) => {
			calls.push(ms);
		});
		await retryBackoff(1);
		await retryBackoff(2);
		expect(calls).toEqual([2000, 4000]);
	});

	it("propagates an aborted signal instead of waiting", async () => {
		setRetrySleep(async (_ms, signal) => {
			if (signal?.aborted) throw new Error("aborted");
		});
		const controller = new AbortController();
		controller.abort();
		await expect(retryBackoff(1, controller.signal)).rejects.toThrow();
	});
});
