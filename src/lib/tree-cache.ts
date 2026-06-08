/**
 * First-page comment-tree cache: key builder + invalidation.
 *
 * GET /api/v1/comments caches the first page per (slug, sort, page-size) at the
 * edge — see response-cache.ts for why the Cache API and not KV. Page size is
 * stamped into the key so a changed `comments_per_page` can't serve a
 * stale-sized slice. Only anonymous, first-page (cursorless) reads are cached;
 * signed-in viewers carry per-user my_vote/mine flags and bypass entirely.
 *
 * Invalidation is best-effort and current-colo only: the Cache API can't be
 * listed or globally busted. Every comment mutation (create / edit / delete /
 * moderate / react) drops the slug's first-page entries in the handling colo,
 * and the short max-age (`TREE_CACHE_TTL`) bounds staleness everywhere else. A
 * just-posted comment shows immediately to its author (signed-in → uncached,
 * or a same-colo drop) and within the TTL to other readers — the prior
 * "best-effort; a brief stale first page is acceptable" contract.
 */
import { cacheKey, dropCache } from "./response-cache";
import { loadNumbers } from "./settings";
import type { Bindings } from "../index";

// Edge cache max-age for the first page. Shorter than the old 300s KV TTL
// because the Cache API can't be globally busted — the TTL is what bounds
// cross-colo staleness after a mutation.
export const TREE_CACHE_TTL = 60; // seconds

export type CommentSort = "new" | "top";

/**
 * Cache-key Request for a first-page response. `reqUrl` is the handling
 * request's URL (`c.req.url`); only its origin is used, so the key lands on the
 * Worker's own in-zone host (see response-cache.ts/cacheKey).
 */
export const treeCacheKey = (
	reqUrl: string,
	slug: string,
	sort: CommentSort,
	pageSize: number,
): Request => cacheKey(reqUrl, "tree-first", { slug, sort, n: pageSize });

/**
 * Drop a slug's cached first pages (both sorts, current page size) in the
 * handling colo. Best-effort: never rejects, because every comment mutation
 * awaits it on the user-visible path. Resolving the page size needs a settings
 * read; if that fails we skip the drop and let the TTL expire the entry.
 * `reqUrl` (the mutation's `c.req.url`) keys the deletes on the same Worker
 * origin the GET reads used.
 */
export const bustTreeCache = async (
	env: Bindings,
	reqUrl: string,
	slug: string,
): Promise<void> => {
	const numbers = await loadNumbers(env).catch(() => null);
	if (!numbers) return;
	const pageSize = numbers.comments_per_page;
	await Promise.all([
		dropCache(treeCacheKey(reqUrl, slug, "new", pageSize)),
		dropCache(treeCacheKey(reqUrl, slug, "top", pageSize)),
	]);
};
