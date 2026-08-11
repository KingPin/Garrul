/**
 * POST /api/v1/votes
 *   { comment_id, value: -1 | 0 | 1 }
 *
 * value=1 upvotes, value=-1 downvotes, value=0 clears the calling user's
 * vote. Same row can be flipped any number of times — the (comment_id,
 * user_id) PK enforces strict single-vote-per-user.
 *
 * Identity rules match reactions: authed users vote with their session
 * user_id; anonymous viewers vote as the ip_hash-keyed ghost user. The
 * per-IP rate-limit bucket is shared with comments/reactions so a
 * scripted clicker can't grind the counters.
 *
 * Cache: a successful vote does NOT bust the per-post tree cache —
 * authed viewers already bypass the cache (their list response carries
 * per-user my_vote), and the widget patches the DOM with the returned
 * counters so anonymous-viewer pages converge on the next comment write.
 * This keeps a noisy thread from burning KV writes on every click.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { castVote, getComment, type VoteValue } from "../db/queries";
import { resolveActor } from "../lib/active-user";
import { requireIpHash } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { writeEvent } from "../lib/analytics";
import { loadFlags } from "../lib/settings";
import { FALLBACK_LOCALE, tFor } from "../i18n";
import type { LocaleVars } from "../lib/locale";

const votes = new Hono<{ Bindings: Bindings; Variables: LocaleVars }>();

type VoteBody = {
	comment_id?: string;
	value?: unknown;
};

const normalizeValue = (raw: unknown): VoteValue | null => {
	if (raw === 1 || raw === -1 || raw === 0) return raw;
	if (typeof raw === "string") {
		if (raw === "1") return 1;
		if (raw === "-1") return -1;
		if (raw === "0") return 0;
	}
	return null;
};

votes.post("/", async (c) => {
	// Shadows the module-level English `t` for the whole handler, so the error
	// bodies below come out in the language of the page the reader is on — the
	// widget renders `json.error` verbatim.
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);
	const flags = await loadFlags(c.env);
	if (!flags.votes_enabled) {
		return c.json({ error: "voting_disabled" }, 403);
	}

	const body = await c.req.json<VoteBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	const comment_id = (body.comment_id ?? "").trim();
	if (!comment_id) return c.json({ error: t("err.not_found") }, 400);

	const value = normalizeValue(body.value);
	if (value === null) return c.json({ error: "invalid_value" }, 400);

	// Optional site-wide brigading mitigation. We reject downvotes outright
	// — telling the client value=-1 is not allowed is a more honest UX than
	// silently clamping to 0.
	if (value === -1 && !flags.downvotes_enabled) {
		return c.json({ error: "downvotes_disabled" }, 403);
	}

	const comment = await getComment(c.env.DB, comment_id);
	if (!comment) return c.json({ error: t("err.not_found") }, 404);
	// Only an approved comment is votable, and every other state answers 404
	// exactly like a missing row. Accepting a vote on a `pending` or `spam`
	// comment confirmed to anyone holding the id that a moderator had held it,
	// and returned the live tallies for content no reader can see — so a
	// scripted clicker could pre-load a score onto a comment before it was ever
	// approved.
	if (comment.status !== "approved") {
		return c.json({ error: t("err.not_found") }, 404);
	}

	const ipHash = await requireIpHash(c);
	if (ipHash instanceof Response) return ipHash;
	const rl = await checkRateLimit(c.req.url, ipHash, {
		scope: "vote",
		env: c.env,
	});
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: comment.post_slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	const actor = await resolveActor(c, ipHash);
	if (!actor.ok) return c.json({ error: t("err.banned") }, 403);
	const userId = actor.userId;

	// Authors can't vote on their own comment. Works for both authenticated
	// users (session user_id) and anonymous viewers (IP-hash ghost) because
	// comments.user_id is whichever identity posted. Without this guard a
	// self-upvote silently floats your own thread under sort=top.
	if (userId === comment.user_id) {
		return c.json({ error: "vote_self_forbidden" }, 403);
	}

	const result = await castVote(c.env.DB, comment_id, userId, value);

	writeEvent(c.env.ANALYTICS, "vote.cast", {
		post_slug: comment.post_slug,
		outcome: value === 0 ? "cleared" : value === 1 ? "up" : "down",
	});

	return c.json({
		ok: true,
		comment_id,
		score_up: result.score_up,
		score_down: result.score_down,
		my_vote: result.my_vote,
	});
});

export { votes };
