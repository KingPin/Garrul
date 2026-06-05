/**
 * Page-level engagement — react / vote on the article itself, no comment.
 *
 *   GET  /api/v1/page-engagement?slug=<slug>
 *        → current totals + the caller's own state, for initial widget render.
 *   POST /api/v1/page-engagement/reactions   { slug, kind }   toggle a reaction
 *   POST /api/v1/page-engagement/votes       { slug, value }  cast/clear a vote
 *
 * Gated behind page_reactions_enabled / page_votes_enabled (both default OFF).
 * Identity mirrors comments/reactions: authed users by session user_id,
 * anonymous viewers by the ip_hash-keyed ghost user, so a repeat click
 * toggles the same row. Shares the per-IP rate-limit bucket.
 *
 * Like comment votes, a successful write does NOT bust any cache — the widget
 * patches the DOM from the returned totals.
 */
import { Hono, type Context } from "hono";
import type { Bindings } from "../index";
import {
	castPageVote,
	getOrCreateGhost,
	getPageVote,
	listPageReactions,
	listUserPageReactions,
	togglePageReaction,
	upsertPost,
	type VoteValue,
} from "../db/queries";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { loadFlags } from "../lib/settings";
import { t } from "../i18n";

const pageEngagement = new Hono<{ Bindings: Bindings }>();

const SLUG_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;
const ALLOWED_KINDS = new Set(["like", "love", "laugh", "hmm", "cry"]);

const normalizeValue = (raw: unknown): VoteValue | null => {
	if (raw === 1 || raw === -1 || raw === 0) return raw;
	if (typeof raw === "string") {
		if (raw === "1") return 1;
		if (raw === "-1") return -1;
		if (raw === "0") return 0;
	}
	return null;
};

const validateSlug = (raw: string): string | null => {
	const slug = raw.trim();
	if (!slug || !SLUG_RE.test(slug)) return null;
	return slug;
};

// Resolve the acting identity: session user, else the ip_hash ghost.
const resolveUserId = async (
	c: Context<{ Bindings: Bindings }>,
	ipHash: string,
): Promise<string> => {
	const session = await readSession(c);
	if (session) return session.user_id;
	const ghost = await getOrCreateGhost(c.env.DB, ipHash, "anon");
	return ghost.id;
};

const reactionTotals = (
	rows: { kind: string; count: number }[],
): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const r of rows) out[r.kind] = r.count;
	return out;
};

// -- GET initial state -------------------------------------------------------

pageEngagement.get("/", async (c) => {
	const slug = validateSlug(c.req.query("slug") ?? "");
	if (!slug) return c.json({ error: t("err.post.invalid") }, 400);

	const flags = await loadFlags(c.env);
	// Resolve identity only if at least one surface is on AND a session/ghost
	// is cheap to read — but we avoid creating a ghost on a pure GET. Use the
	// session user when present; anonymous viewers get totals only (their own
	// state shows after they first interact).
	const session = await readSession(c);
	const userId = session?.user_id ?? null;

	const out: Record<string, unknown> = {};

	if (flags.page_reactions_enabled) {
		const totals = reactionTotals(await listPageReactions(c.env.DB, slug));
		const mine = userId
			? [...(await listUserPageReactions(c.env.DB, slug, userId))]
			: [];
		out.reactions = totals;
		out.my_reactions = mine;
	}

	if (flags.page_votes_enabled) {
		out.votes = await getPageVote(c.env.DB, slug, userId);
	}

	return c.json(out);
});

// -- POST a reaction ---------------------------------------------------------

type ReactionBody = { slug?: string; kind?: string };

pageEngagement.post("/reactions", async (c) => {
	const flags = await loadFlags(c.env);
	if (!flags.page_reactions_enabled) {
		return c.json({ error: "page_reactions_disabled" }, 403);
	}

	const body = await c.req.json<ReactionBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	const slug = validateSlug(body.slug ?? "");
	if (!slug) return c.json({ error: t("err.post.invalid") }, 400);
	const kind = (body.kind ?? "").trim();
	if (!ALLOWED_KINDS.has(kind)) return c.json({ error: "invalid_kind" }, 400);

	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash);
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	// The post row must exist (FK). Create it lazily — a reader may react
	// before anyone has commented.
	await upsertPost(c.env.DB, slug, null, null);
	const userId = await resolveUserId(c, ipHash);
	const result = await togglePageReaction(c.env.DB, slug, userId, kind);
	const totals = reactionTotals(await listPageReactions(c.env.DB, slug));

	writeEvent(c.env.ANALYTICS, "page_reaction.toggled", {
		post_slug: slug,
		outcome: result.added ? "added" : "removed",
	});

	return c.json({ ok: true, added: result.added, reactions: totals });
});

// -- POST a vote -------------------------------------------------------------

type VoteBody = { slug?: string; value?: unknown };

pageEngagement.post("/votes", async (c) => {
	const flags = await loadFlags(c.env);
	if (!flags.page_votes_enabled) {
		return c.json({ error: "page_votes_disabled" }, 403);
	}

	const body = await c.req.json<VoteBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	const slug = validateSlug(body.slug ?? "");
	if (!slug) return c.json({ error: t("err.post.invalid") }, 400);
	const value = normalizeValue(body.value);
	if (value === null) return c.json({ error: "invalid_value" }, 400);

	// Downvotes on the page vote follow the same operator switch as comment
	// downvotes — a page vote is a "helpful?" up/down tally.
	if (value === -1 && !flags.downvotes_enabled) {
		return c.json({ error: "downvotes_disabled" }, 403);
	}

	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash);
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	await upsertPost(c.env.DB, slug, null, null);
	const userId = await resolveUserId(c, ipHash);
	const result = await castPageVote(c.env.DB, slug, userId, value);

	writeEvent(c.env.ANALYTICS, "page_vote.cast", {
		post_slug: slug,
		outcome: value === 0 ? "cleared" : value === 1 ? "up" : "down",
	});

	return c.json({
		ok: true,
		score_up: result.score_up,
		score_down: result.score_down,
		my_vote: result.my_vote,
	});
});

export { pageEngagement };
