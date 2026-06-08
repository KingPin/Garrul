/**
 * GET /api/v1/counts?slugs=a,b,c — approved-comment counts for many
 * slugs in one round-trip. Used by blog index/archive pages that want to
 * show "12 comments" badges without mounting the widget on each card.
 *
 * Response shape: { counts: { [slug]: number } } — slugs with zero
 * comments are omitted, so the client should default missing keys to 0.
 *
 * Opt-in extras via ?include=votes,reactions (comma-separated):
 *   - votes     → { votes: { [slug]: { score_up, score_down } } }
 *   - reactions → { reactions: { [slug]: { [kind]: count } } }
 * Each extra is only included when its page-level feature flag is enabled;
 * a disabled feature's totals are never exposed, even if requested. The
 * comment count stays the default so existing callers are unaffected.
 *
 * Cached per (canonical-slug-list + include set) for 60s at the edge (Cache
 * API, not KV — see lib/response-cache.ts). The slug
 * list is canonicalized — trimmed, deduped, sorted, capped at 100; slug case
 * is preserved (slugs are case-sensitive) — so different orderings of the
 * same slugs share a cache entry. The include set is folded into the key so
 * a plain call and an extras call never collide.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	countApprovedCommentsBySlugs,
	countPageReactionsBySlugs,
	countPageVotesBySlugs,
	type PageVoteTally,
} from "../db/queries";
import { loadFlags } from "../lib/settings";
import { cacheJson, cacheKey, matchCache, tryWaitUntil } from "../lib/response-cache";

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

// Parse ?include= into a normalized, sorted set of recognized extras. Unknown
// tokens are dropped so a typo can't poison the cache key with junk.
const parseInclude = (raw: string): ("votes" | "reactions")[] => {
	const want = new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s === "votes" || s === "reactions"),
	);
	return [...want].sort() as ("votes" | "reactions")[];
};

type CountsPayload = {
	counts: Record<string, number>;
	votes?: Record<string, PageVoteTally>;
	reactions?: Record<string, Record<string, number>>;
};

counts.get("/", async (c) => {
	const raw = c.req.query("slugs") ?? "";
	const slugs = canonicalize(raw);
	if (slugs.length === 0) {
		return c.json({ counts: {} });
	}

	const include = parseInclude(c.req.query("include") ?? "");

	// Resolve flags up front so the cache key reflects only the extras we
	// will actually compute — a requested-but-disabled extra collapses to the
	// same key (and payload) as not requesting it, maximizing cache reuse.
	const flags = include.length ? await loadFlags(c.env) : null;
	const wantVotes = include.includes("votes") && !!flags?.page_votes_enabled;
	const wantReactions =
		include.includes("reactions") && !!flags?.page_reactions_enabled;

	const effective = [
		...(wantVotes ? ["votes"] : []),
		...(wantReactions ? ["reactions"] : []),
	];
	const keySuffix = effective.length ? `:${effective.join(",")}` : "";
	const cacheReq = cacheKey(c.req.url, "counts", {
		k: `${slugs.join(",")}${keySuffix}`,
	});

	const hit = await matchCache(cacheReq);
	if (hit) return hit;

	const map = await countApprovedCommentsBySlugs(c.env.DB, slugs);
	const result: Record<string, number> = {};
	for (const [slug, count] of map) {
		result[slug] = count;
	}
	const payload: CountsPayload = { counts: result };

	if (wantVotes) {
		const tallies = await countPageVotesBySlugs(c.env.DB, slugs);
		const votes: Record<string, PageVoteTally> = {};
		for (const [slug, tally] of tallies) votes[slug] = tally;
		payload.votes = votes;
	}

	if (wantReactions) {
		const totals = await countPageReactionsBySlugs(c.env.DB, slugs);
		const reactions: Record<string, Record<string, number>> = {};
		for (const [slug, byKind] of totals) reactions[slug] = byKind;
		payload.reactions = reactions;
	}

	// Counts are non-personalized, so the client copy stays publicly cacheable
	// for the same window (preserving the prior Cache-Control behavior).
	return cacheJson(
		cacheReq,
		JSON.stringify(payload),
		COUNTS_CACHE_TTL,
		tryWaitUntil(c),
		`public, max-age=${COUNTS_CACHE_TTL}`,
	);
});

export { counts };
