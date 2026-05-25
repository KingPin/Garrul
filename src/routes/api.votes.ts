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
import {
	castVote,
	getComment,
	getOrCreateGhost,
	type VoteValue,
} from "../db/queries";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { t } from "../i18n";

const votes = new Hono<{ Bindings: Bindings }>();

type VoteBody = {
	comment_id?: string;
	value?: unknown;
};

const isBoolish = (raw: string | undefined, defaultOn: boolean): boolean => {
	if (raw == null) return defaultOn;
	const v = raw.trim().toLowerCase();
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	return true;
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
	if (!isBoolish(c.env.VOTING_ENABLED, true)) {
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
	if (value === -1 && !isBoolish(c.env.DOWNVOTES_ENABLED, true)) {
		return c.json({ error: "downvotes_disabled" }, 403);
	}

	const comment = await getComment(c.env.DB, comment_id);
	if (!comment) return c.json({ error: t("err.not_found") }, 404);
	if (comment.status === "deleted") {
		return c.json({ error: t("err.not_found") }, 404);
	}

	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash);
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: comment.post_slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	const session = await readSession(c);
	let userId: string;
	if (session) {
		userId = session.user_id;
	} else {
		const ghost = await getOrCreateGhost(c.env.DB, ipHash, "anon");
		userId = ghost.id;
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
