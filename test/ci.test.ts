import { describe, expect, it, vi } from "vitest";
import { CiWatcher, detectPrFromText, formatCiFailure, isPushCommand, parseChecks, runIdFromLink, summarizeChecks, watchChecks } from "../extensions/code-changes/ci.ts";
import type { CheckRun, CiFailure, PullRequestRef } from "../extensions/code-changes/state.ts";

const PR: PullRequestRef = { number: 42, url: "https://github.com/acme/widgets/pull/42", headSha: "deadbeef" };

function noSleep(_ms: number, _signal?: AbortSignal): Promise<void> {
	return Promise.resolve();
}

describe("detectPrFromText", () => {
	it("returns undefined when no PR URL is present", () => {
		expect(detectPrFromText("no links here")).toBeUndefined();
	});

	it("extracts a single PR URL", () => {
		const text = "Opened https://github.com/acme/widgets/pull/7 for review.";
		expect(detectPrFromText(text)).toEqual({ url: "https://github.com/acme/widgets/pull/7", number: 7 });
	});

	it("returns the last PR URL when multiple are present", () => {
		const text = "See https://github.com/acme/widgets/pull/7 superseded by https://github.com/acme/widgets/pull/9.";
		expect(detectPrFromText(text)).toEqual({ url: "https://github.com/acme/widgets/pull/9", number: 9 });
	});
});

describe("isPushCommand", () => {
	it.each([
		["git push", true],
		["git push origin main", true],
		["git push --force-with-lease", true],
		["npm test && git push", true],
		["git add -A && git commit -m wip && git push origin HEAD", true],
		["gh pr create --fill", true],
		["gh pr create", true],
		["git status && gh pr create", true],
		["gh pr merge --auto", false],
		["git status", false],
		["git pull", false],
		["npm test", false],
		["gh pr view", false],
	])("%s -> %s", (command, expected) => {
		expect(isPushCommand(command)).toBe(expected);
	});
});

describe("parseChecks", () => {
	const sample = JSON.stringify([
		{
			name: "build",
			state: "SUCCESS",
			bucket: "pass",
			link: "https://github.com/acme/widgets/actions/runs/111/job/222",
			workflow: "CI",
			completedAt: "2026-09-28T10:00:00Z",
		},
		{
			name: "test",
			state: "FAILURE",
			bucket: "fail",
			link: "https://github.com/acme/widgets/actions/runs/111/job/333",
			workflow: "CI",
			completedAt: "2026-09-28T10:01:00Z",
		},
		{
			name: "lint",
			state: "IN_PROGRESS",
			bucket: "pending",
			link: "",
			workflow: "CI",
			completedAt: "",
		},
		{
			name: "weird",
			state: "SOME_NEW_STATE",
			bucket: "totally-unknown",
			link: "",
			workflow: "CI",
		},
	]);

	it("normalizes a realistic gh JSON sample", () => {
		const checks = parseChecks(sample);
		expect(checks).toHaveLength(4);
		expect(checks[0]).toEqual({ name: "build", bucket: "pass", link: "https://github.com/acme/widgets/actions/runs/111/job/222", workflow: "CI" });
		expect(checks[1].bucket).toBe("fail");
		expect(checks[2].bucket).toBe("pending");
	});

	it("maps unknown buckets to pending", () => {
		const checks = parseChecks(sample);
		expect(checks[3].bucket).toBe("pending");
	});

	it("returns an empty array for empty or invalid input", () => {
		expect(parseChecks("")).toEqual([]);
		expect(parseChecks("not json")).toEqual([]);
		expect(parseChecks("{}")).toEqual([]);
	});
});

describe("summarizeChecks", () => {
	function check(bucket: CheckRun["bucket"], name = bucket): CheckRun {
		return { name, bucket, link: "" };
	}

	it("is none for an empty list", () => {
		expect(summarizeChecks([]).state).toBe("none");
	});

	it("is pass when everything passes or skips", () => {
		const s = summarizeChecks([check("pass"), check("skipping")]);
		expect(s.state).toBe("pass");
		expect(s.failed).toEqual([]);
	});

	it("is pending when nothing failed but something is pending", () => {
		const s = summarizeChecks([check("pass"), check("pending")]);
		expect(s.state).toBe("pending");
		expect(s.pending).toHaveLength(1);
	});

	it("is fail when any check fails, even with pending checks outstanding", () => {
		const s = summarizeChecks([check("pending"), check("fail")]);
		expect(s.state).toBe("fail");
		expect(s.failed).toHaveLength(1);
	});

	it("treats cancel as fail", () => {
		const s = summarizeChecks([check("cancel"), check("pass")]);
		expect(s.state).toBe("fail");
		expect(s.failed).toHaveLength(1);
	});
});

describe("runIdFromLink", () => {
	it("extracts run and job id", () => {
		expect(runIdFromLink("https://github.com/acme/widgets/actions/runs/123/job/456")).toEqual({ runId: "123", jobId: "456" });
	});

	it("extracts run id only when no job segment", () => {
		expect(runIdFromLink("https://github.com/acme/widgets/actions/runs/123")).toEqual({ runId: "123", jobId: undefined });
	});

	it("returns undefined for a non-actions link", () => {
		expect(runIdFromLink("https://github.com/acme/widgets/pull/7")).toBeUndefined();
	});
});

describe("watchChecks", () => {
	it("resolves pass after a pending then passing poll", async () => {
		let call = 0;
		const fetchChecks = vi.fn(async (): Promise<{ headSha: string; checks: CheckRun[] }> => {
			call++;
			if (call === 1) return { headSha: PR.headSha, checks: [{ name: "build", bucket: "pending", link: "" }] };
			return { headSha: PR.headSha, checks: [{ name: "build", bucket: "pass", link: "" }] };
		});
		const result = await watchChecks({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks });
		expect(result.kind).toBe("pass");
		expect(fetchChecks).toHaveBeenCalledTimes(2);
	});

	it("returns fail immediately once any check fails, without waiting for the rest", async () => {
		const fetchChecks = vi.fn(async () => ({
			headSha: PR.headSha,
			checks: [
				{ name: "build", bucket: "fail", link: "https://github.com/acme/widgets/actions/runs/1/job/2" },
				{ name: "slow-job", bucket: "pending", link: "" },
			] as CheckRun[],
		}));
		const collectLogs = vi.fn(async () => "boom log");
		const result = await watchChecks({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks, collectLogs });
		expect(result.kind).toBe("fail");
		if (result.kind === "fail") {
			expect(result.failure.failed).toHaveLength(1);
			expect(result.failure.logs).toBe("boom log");
			expect(result.failure.pr).toEqual(PR);
		}
		expect(fetchChecks).toHaveBeenCalledTimes(1);
	});

	it("returns stale when the PR head has moved past the watched sha", async () => {
		const fetchChecks = vi.fn(async () => ({ headSha: "newsha", checks: [] as CheckRun[] }));
		const result = await watchChecks({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks });
		expect(result).toEqual({ kind: "stale", headSha: "newsha" });
	});

	it("returns none when no checks appear before the appear timeout", async () => {
		let now = 0;
		const realNow = Date.now;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const fetchChecks = vi.fn(async () => ({ headSha: PR.headSha, checks: [] as CheckRun[] }));
		const sleep = async () => {
			now += 60_000;
		};
		try {
			const result = await watchChecks({ cwd: "/repo", pr: PR, sleep, fetchChecks, appearTimeoutMs: 100_000, timeoutMs: 10_000_000 });
			expect(result.kind).toBe("none");
		} finally {
			Date.now = realNow;
		}
	});

	it("returns aborted when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchChecks = vi.fn(async () => ({ headSha: PR.headSha, checks: [] as CheckRun[] }));
		const result = await watchChecks({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks, signal: controller.signal });
		expect(result.kind).toBe("aborted");
	});

	it("returns error when fetchChecks throws", async () => {
		const fetchChecks = vi.fn(async () => {
			throw new Error("network down");
		});
		const result = await watchChecks({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks });
		expect(result).toEqual({ kind: "error", message: "network down" });
	});
});

describe("CiWatcher", () => {
	it("supersedes an existing watch for the same PR when a new one starts", async () => {
		const watcher = new CiWatcher();
		let firstAborted = false;

		const firstDone = vi.fn();
		const secondDone = vi.fn();

		const firstFetch = (): Promise<{ headSha: string; checks: CheckRun[] }> =>
			new Promise((_resolve, reject) => {
				// Never resolves on its own; only settles via abort below.
				setTimeout(() => {
					if (firstAborted) reject(new Error("aborted-marker"));
				}, 0);
			});

		watcher.start(
			{
				cwd: "/repo",
				pr: PR,
				sleep: noSleep,
				fetchChecks: async (pr) => {
					// Block until the controller for this watch is aborted.
					return new Promise((resolve, reject) => {
						const check = () => {
							if (firstAborted) reject(new Error("superseded"));
							else setTimeout(check, 1);
						};
						check();
					});
				},
			},
			firstDone,
		);

		expect(watcher.active()).toEqual([PR.number]);

		firstAborted = true;
		watcher.start(
			{
				cwd: "/repo",
				pr: PR,
				sleep: noSleep,
				fetchChecks: async () => ({ headSha: PR.headSha, checks: [{ name: "build", bucket: "pass", link: "" }] }),
			},
			secondDone,
		);

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(secondDone).toHaveBeenCalledWith({ kind: "pass", checks: [{ name: "build", bucket: "pass", link: "" }] });
		expect(watcher.active()).toEqual([]);
	});

	it("stop() aborts the active watch for a PR", async () => {
		const watcher = new CiWatcher();
		const onDone = vi.fn();
		watcher.start(
			{
				cwd: "/repo",
				pr: PR,
				sleep: noSleep,
				fetchChecks: () => new Promise(() => {}),
			},
			onDone,
		);
		expect(watcher.active()).toEqual([PR.number]);
		watcher.stop(PR.number);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(onDone).toHaveBeenCalledWith({ kind: "aborted" });
		expect(watcher.active()).toEqual([]);
	});

	it("stopAll() aborts every active watch", async () => {
		const watcher = new CiWatcher();
		const onDoneA = vi.fn();
		const onDoneB = vi.fn();
		watcher.start({ cwd: "/repo", pr: PR, sleep: noSleep, fetchChecks: () => new Promise(() => {}) }, onDoneA);
		watcher.start({ cwd: "/repo", pr: { ...PR, number: 99 }, sleep: noSleep, fetchChecks: () => new Promise(() => {}) }, onDoneB);
		expect(watcher.active().sort()).toEqual([42, 99]);
		watcher.stopAll();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(onDoneA).toHaveBeenCalledWith({ kind: "aborted" });
		expect(onDoneB).toHaveBeenCalledWith({ kind: "aborted" });
		expect(watcher.active()).toEqual([]);
	});
});

describe("formatCiFailure", () => {
	it("includes PR link, failed check names/links, and logs", () => {
		const failure: CiFailure = {
			pr: PR,
			failed: [{ name: "test", bucket: "fail", link: "https://github.com/acme/widgets/actions/runs/1/job/2", workflow: "CI" }],
			logs: "Error: assertion failed",
		};
		const md = formatCiFailure(failure);
		expect(md).toContain(PR.url);
		expect(md).toContain("test");
		expect(md).toContain("https://github.com/acme/widgets/actions/runs/1/job/2");
		expect(md).toContain("Error: assertion failed");
		expect(md.toLowerCase()).toContain("classify");
	});
});
