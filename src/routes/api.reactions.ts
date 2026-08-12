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
import {
	getComment,
	listReactionsForComment,
	toggleReaction,
} from "../db/queries";
import { resolveActor } from "../lib/active-user";
import { requireIpHash } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { writeEvent } from "../lib/analytics";
import { loadFlags } from "../lib/settings";
import { bustTreeCache } from "../lib/tree-cache";
import { FALLBACK_LOCALE, tFor } from "../i18n";
import type { LocaleVars } from "../lib/locale";

const reactions = new Hono<{ Bindings: Bindings; Variables: LocaleVars }>();

const ALLOWED_KINDS = new Set(["like", "love", "laugh", "hmm", "cry"]);

type ReactionBody = {
	comment_id?: string;
	kind?: string;
};

reactions.post("/", async (c) => {
	// Shadows the module-level English `t` for the whole handler; the widget
	// renders `json.error` verbatim, so this is what makes the error match the
	// language the rest of the widget is in.
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);
	const flags = await loadFlags(c.env);
	if (!flags.reactions_enabled) {
		return c.json({ error: "reactions_disabled" }, 403);
	}

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
	// Same gate as votes: anything not `approved` is indistinguishable from a
	// missing row here. A 200 on a held comment both confirmed the moderation
	// decision and let reaction rows accumulate on content no reader can see.
	if (comment.status !== "approved") {
		return c.json({ error: t("err.not_found") }, 404);
	}

	const ipHash = await requireIpHash(c);
	if (ipHash instanceof Response) return ipHash;
	const rl = await checkRateLimit(c.req.url, ipHash, {
		scope: "reaction",
		env: c.env,
	});
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: comment.post_slug,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	// Anonymous reactors fall back to the ghost user keyed on ip_hash so
	// repeated clicks from the same browser/IP toggle the same row.
	const actor = await resolveActor(c, ipHash);
	if (!actor.ok) return c.json({ error: t("err.banned") }, 403);
	const userId = actor.userId;

	const result = await toggleReaction(c.env.DB, comment_id, userId, kind);
	// Authoritative counts for this one comment, so the widget can patch the
	// reaction row in place rather than re-fetching the whole thread — which it
	// used to do on every 👍, throwing away scroll position and open composers.
	// `added` covers the caller's own `mine` flag; these counts cover everyone
	// else's, including reactions that landed since the thread was fetched.
	// Same shape as the page-level endpoint (`{ kind: count }`).
	const totals: Record<string, number> = {};
	for (const r of await listReactionsForComment(c.env.DB, comment_id)) {
		totals[r.kind] = r.count;
	}

	// Bust the cached first page so reaction counts reflect immediately.
	await bustTreeCache(c.env, c.req.url, comment.post_slug);

	writeEvent(c.env.ANALYTICS, "reaction.toggled", {
		post_slug: comment.post_slug,
		outcome: result.added ? "added" : "removed",
	});

	return c.json({ ok: true, added: result.added, reactions: totals });
});

export { reactions };
