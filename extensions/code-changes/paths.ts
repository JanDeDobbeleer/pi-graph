/**
 * Pure path-scope helpers for parallel delegation: which folders/files/globs a task may change,
 * whether two tasks' scopes can collide, and whether a changed file falls inside a task's scope.
 *
 * Patterns are repo-relative and use "/" separators (Windows backslashes are normalized). Overlap
 * checks are deliberately conservative: when in doubt, two patterns overlap, since a false
 * "overlap" only costs parallelism while a false "disjoint" costs a merge conflict.
 */

import type { PlanTask } from "./state.ts";

/**
 * Normalizes a repo-relative path or pattern: trims, converts "\" to "/", collapses duplicate
 * separators and "." segments, and drops a trailing "/". "." (or "./") becomes "" — everything.
 */
export function normalizePath(p: string): string {
	let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	while (s.startsWith("./")) s = s.slice(2);
	s = s.replace(/\/\.(?=\/|$)/g, "");
	if (s === ".") s = "";
	return s.replace(/\/+$/, "");
}

function hasGlob(p: string): boolean {
	return p.includes("*") || p.includes("?");
}

/**
 * The directory-ish prefix a pattern is anchored under: a plain path is its own prefix; a glob is
 * cut at its first glob character, then back to the last "/" (so "src/a*" anchors at "src").
 * "" (from "**", "*.md", ".", or "") means "anywhere".
 */
function staticPrefix(p: string): string {
	const index = p.search(/[*?]/);
	if (index === -1) return p;
	const head = p.slice(0, index);
	const slash = head.lastIndexOf("/");
	return slash === -1 ? "" : head.slice(0, slash);
}

/** True when `x` equals `y` or is a parent directory of `y` ("" is a parent of everything). */
function isDirPrefix(x: string, y: string): boolean {
	return x === "" || x === y || y.startsWith(`${x}/`);
}

/** Do two single patterns possibly cover a common file? Conservative. */
function patternsOverlap(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (na === nb) return true;
	const pa = staticPrefix(na);
	const pb = staticPrefix(nb);
	return isDirPrefix(pa, pb) || isDirPrefix(pb, pa);
}

/** The pairs (one pattern from each side) that overlap, for error messages. */
export function overlappingPatterns(a: string[], b: string[]): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const pa of a) {
		for (const pb of b) {
			if (patternsOverlap(pa, pb)) pairs.push([normalizePath(pa) || ".", normalizePath(pb) || "."]);
		}
	}
	return pairs;
}

/** Can any pattern in `a` possibly cover the same file as any pattern in `b`? */
export function pathsOverlap(a: string[], b: string[]): boolean {
	for (const pa of a) {
		for (const pb of b) {
			if (patternsOverlap(pa, pb)) return true;
		}
	}
	return false;
}

function globToRegExp(pattern: string): RegExp {
	let re = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				re += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			re += "[^/]";
			i += 1;
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i += 1;
		}
	}
	// A pattern that matches a directory also covers its whole subtree.
	return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Does `file` fall inside any of `patterns`? `*` stays within a path segment, `**` crosses
 * segments, a trailing "/" or a bare directory name covers that directory's subtree, and "." or
 * an empty pattern covers everything.
 */
export function matchesAnyPath(file: string, patterns: string[]): boolean {
	const f = normalizePath(file);
	for (const raw of patterns) {
		const p = normalizePath(raw);
		if (p === "") return true;
		if (!hasGlob(p)) {
			if (f === p || f.startsWith(`${p}/`)) return true;
		} else if (globToRegExp(p).test(f)) {
			return true;
		}
	}
	return false;
}

/** Does `from` depend, directly or transitively, on `target`? */
function dependsOn(from: string, target: string, byId: Map<string, PlanTask>): boolean {
	const seen = new Set<string>();
	const stack = [...(byId.get(from)?.dependencies ?? [])];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...(byId.get(id)?.dependencies ?? []));
	}
	return false;
}

/** True when neither task transitively depends on the other (so they may run at the same time). */
export function independent(a: PlanTask | string, b: PlanTask | string, tasks: PlanTask[]): boolean {
	const idA = typeof a === "string" ? a : a.id;
	const idB = typeof b === "string" ? b : b.id;
	if (idA === idB) return false;
	const byId = new Map(tasks.map((t) => [t.id, t]));
	return !dependsOn(idA, idB, byId) && !dependsOn(idB, idA, byId);
}
