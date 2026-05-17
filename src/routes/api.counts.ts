/**
 * GET /api/v1/counts?slugs=a,b,c — approved-comment counts for many
 * slugs in one round-trip. Used by blog index/archive pages that want to
 * show "12 comments" badges without mounting the widget on each card.
 *
 * Response shape: { counts: { [slug]: number } } — slugs with zero
 * comments are omitted, so the client should default missing keys to 0.
 *
 * Cached per (sorted-slug-list) for 60s in KV. The slug list is
 * canonicalized (trimmed, lowercased, sorted, deduped, capped at 100)
 * so different orderings of the same slugs share a cache entry.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { countApprovedCommentsBySlugs } from "../db/queries";

const counts = new Hono<{ Bindings: Bindings }>();

const COUNTS_CACHE_TTL = 60;
const MAX_SLUGS = 100;

const canonicalize = (raw: string): string[] => {
	const parts = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && s.length <= 200);
	const dedup = Array.from(new Set(parts));
	dedup.sort();
	return dedup.slice(0, MAX_SLUGS);
};

counts.get("/", async (c) => {
	const raw = c.req.query("slugs") ?? "";
	const slugs = canonicalize(raw);
	if (slugs.length === 0) {
		return c.json({ counts: {} });
	}

	const cacheKey = `counts:${slugs.join(",")}`;
	const cached = await c.env.TREE_CACHE.get(cacheKey, { type: "json" });
	if (cached) {
		c.header("cache-control", "public, max-age=60");
		return c.json(cached as { counts: Record<string, number> });
	}

	const map = await countApprovedCommentsBySlugs(c.env.DB, slugs);
	const result: Record<string, number> = {};
	for (const [slug, count] of map) {
		result[slug] = count;
	}
	const payload = { counts: result };
	await c.env.TREE_CACHE.put(cacheKey, JSON.stringify(payload), {
		expirationTtl: COUNTS_CACHE_TTL,
	});
	c.header("cache-control", "public, max-age=60");
	return c.json(payload);
});

export { counts };
