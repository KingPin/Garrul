/**
 * Edge response cache (Cloudflare Cache API).
 *
 * Expensive-to-rebuild GET responses — the first page of a comment tree, the
 * multi-slug counts roll-up — are cached at the edge via `caches.default`
 * instead of Workers KV.
 *
 * Why not KV: KV's free tier caps writes at 1,000/day, account-wide. These are
 * write-through HTTP-response caches, so every cache miss costs a KV write. A
 * crawler sweeping many distinct pages forces one write per page — pure write
 * amplification (each entry is written once and never re-read before it
 * expires) that exhausts the daily cap with no upside. The Cache API has no
 * per-day write limit and is the correct home for response caching.
 *
 * Caveats vs KV: the Cache API is per-colo and offers no prefix-list or global
 * invalidation. Callers bound staleness with a short max-age and best-effort,
 * current-colo deletes (see tree-cache.ts for the first-page contract).
 */

// Minimal shape of the Cache API surface we use, typed locally so the module
// doesn't depend on whether `caches.default` resolves via lib.dom or
// @cloudflare/workers-types.
type EdgeCache = {
	match(req: Request): Promise<Response | undefined>;
	put(req: Request, res: Response): Promise<void>;
	delete(req: Request): Promise<boolean>;
};

/**
 * The edge cache, or null when unavailable (e.g. node unit tests without a
 * `caches` polyfill). Callers treat null as "no cache": correct, just
 * uncached — the read falls through to D1.
 */
export const edgeCache = (): EdgeCache | null => {
	const cs = (globalThis as { caches?: { default: EdgeCache } }).caches;
	return cs ? cs.default : null;
};

/**
 * Hono's `c.executionCtx` getter THROWS when there is no ExecutionContext
 * (unit tests via app.request, or non-HTTP entry points). Resolve a waitUntil
 * fn safely, or undefined when none is available.
 */
export const tryWaitUntil = (c: {
	executionCtx: { waitUntil(p: Promise<unknown>): void };
}): ((p: Promise<unknown>) => void) | undefined => {
	try {
		const ctx = c.executionCtx;
		return (p) => ctx.waitUntil(p);
	} catch {
		return undefined;
	}
};

/**
 * Build a stable cache-key Request from a synthetic, normalized URL. Params are
 * sorted so call-order doesn't matter, and only the params we pass select an
 * entry — junk query params on the real request (utm_*, cache-busting noise)
 * can't fragment or poison the cache.
 */
export const cacheKey = (
	kind: string,
	params: Record<string, string | number>,
): Request => {
	const u = new URL(`https://cache.garrul.internal/${kind}`);
	for (const k of Object.keys(params).sort()) {
		u.searchParams.set(k, String(params[k]));
	}
	return new Request(u.toString());
};

/** Read a cached Response for `key`, or null on miss / cache unavailable. */
export const matchCache = async (key: Request): Promise<Response | null> => {
	const cache = edgeCache();
	if (!cache) return null;
	const hit = await cache.match(key).catch(() => undefined);
	return hit ?? null;
};

/** A JSON Response for the client, with an optional Cache-Control header. */
export const jsonResponse = (
	json: string,
	clientCacheControl?: string,
): Response => {
	const headers: Record<string, string> = {
		"content-type": "application/json; charset=UTF-8",
	};
	if (clientCacheControl) headers["cache-control"] = clientCacheControl;
	return new Response(json, { headers });
};

/**
 * Cache `json` under `key` for `ttlSec` (edge copy), returning the Response to
 * send to the client.
 *
 * The edge copy always carries `public, max-age=<ttl>` so the Cache API stores
 * it. The CLIENT copy's Cache-Control is controlled separately by
 * `clientCacheControl` (omitted → no Cache-Control, i.e. the browser does not
 * cache it). This split matters for personalized-by-cookie endpoints: the edge
 * holds an anonymous copy (keyed by our synthetic URL, never by cookie) while
 * the browser is told not to reuse it across auth states.
 *
 * Best-effort: a cache error never fails the read. When `waitUntil` is given
 * the put runs after the response is sent; otherwise it is awaited (keeps unit
 * tests deterministic).
 */
export const cacheJson = async (
	key: Request,
	json: string,
	ttlSec: number,
	waitUntil?: (p: Promise<unknown>) => void,
	clientCacheControl?: string,
): Promise<Response> => {
	const cache = edgeCache();
	if (cache) {
		const stored = new Response(json, {
			headers: {
				"content-type": "application/json; charset=UTF-8",
				"cache-control": `public, max-age=${ttlSec}`,
			},
		});
		const put = cache.put(key, stored).catch(() => {});
		if (waitUntil) waitUntil(put);
		else await put;
	}
	return jsonResponse(json, clientCacheControl);
};

/** Best-effort delete of `key` from the current colo's edge cache. */
export const dropCache = async (key: Request): Promise<void> => {
	const cache = edgeCache();
	if (!cache) return;
	await cache.delete(key).catch(() => {});
};
