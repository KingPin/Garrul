/**
 * POST /api/v1/reactions
 *   { comment_id, kind }  — toggle a reaction
 *
 * Reactions require a session. Anonymous ghost users (auto-created on
 * comment POST via IP hash) are allowed too — same identity rules as
 * comments. We rate-limit reactions through the same per-IP bucket so a
 * scripted clicker can't blow up the row count.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getComment, getOrCreateGhost, toggleReaction } from "../db/queries";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { t } from "../i18n";

const reactions = new Hono<{ Bindings: Bindings }>();

const ALLOWED_KINDS = new Set(["like", "love", "laugh", "hmm", "cry"]);

type ReactionBody = {
	comment_id?: string;
	kind?: string;
};

reactions.post("/", async (c) => {
	const body = await c.req.json<ReactionBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	const comment_id = (body.comment_id ?? "").trim();
	const kind = (body.kind ?? "").trim();
	if (!comment_id) return c.json({ error: t("err.not_found") }, 400);
	if (!ALLOWED_KINDS.has(kind)) {
		return c.json({ error: "invalid_kind" }, 400);
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
		// Anonymous reactor: reuse the ghost user keyed on ip_hash so
		// repeated clicks from the same browser/IP toggle the same row.
		const ghost = await getOrCreateGhost(c.env.DB, ipHash, "anon");
		userId = ghost.id;
	}

	const result = await toggleReaction(c.env.DB, comment_id, userId, kind);

	// Bust the cached first page so reaction counts reflect immediately.
	await c.env.TREE_CACHE.delete(`tree:${comment.post_slug}:first`);

	writeEvent(c.env.ANALYTICS, "reaction.toggled", {
		post_slug: comment.post_slug,
		outcome: result.added ? "added" : "removed",
	});

	return c.json({ ok: true, added: result.added });
});

export { reactions };
