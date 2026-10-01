/**
 * Pure, dependency-free naming helpers for code-changes runs.
 *
 * Slugs intentionally use only a small English filler list. This is conservative request
 * cleanup, not stemming or broad natural-language processing; domain words such as "run",
 * "name", and "slug" remain meaningful.
 */

const REQUEST_FILLER = new Set([
	"a",
	"add",
	"able",
	"an",
	"and",
	"are",
	"be",
	"build",
	"but",
	"can",
	"change",
	"could",
	"create",
	"currently",
	"do",
	"fix",
	"for",
	"have",
	"help",
	"implement",
	"is",
	"it",
	"make",
	"me",
	"more",
	"my",
	"need",
	"no",
	"please",
	"really",
	"remove",
	"should",
	"the",
	"these",
	"this",
	"to",
	"update",
	"us",
	"we",
	"with",
	"would",
	"you",
	"your",
]);

const MAX_TOKENS = 5;
const MAX_SLUG_LENGTH = 48;

/** Builds a stable, readable slug from task text and the run's existing technical ID. */
export function generateRunSlug(task: string, id: string): string {
	const normalized = task
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase();
	const seen = new Set<string>();
	const tokens: string[] = [];

	for (const token of normalized.split(/[^a-z0-9]+/)) {
		if (!token || REQUEST_FILLER.has(token) || seen.has(token)) continue;
		seen.add(token);
		tokens.push(token);
		if (tokens.length === MAX_TOKENS) break;
	}

	if (tokens.length === 0) {
		return `run-${id.slice(-6) || id}`;
	}

	return tokens.join("-").slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/** Formats a user-facing label while preserving a short correlation to the technical ID. */
export function formatRunLabel(run: { id: string; slug?: string }): string {
	const slug = run.slug?.trim();
	if (!slug) return run.id;
	return `${slug} · ${run.id.slice(-4) || run.id}`;
}
