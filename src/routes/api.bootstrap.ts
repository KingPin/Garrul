/**
 * GET /api/v1/bootstrap?slug=<slug> — every mount-time payload, one request.
 *
 * The widget used to open with up to six Worker calls per pageview: `/config`,
 * then `/auth/me` + `/comments` in parallel, plus `/page-engagement`,
 * `/subscribe/mine` and `/comments/form-token` when the relevant surfaces are
 * on. This folds the first five into one invocation, which is the whole point:
 * the Workers free tier allows 100,000 requests/day (see
 * `src/admin-ui/pages/usage.ts`), so mount cost is what sets the ceiling on
 * pageviews an install can serve.
 *
 * Measured against a real browser mount, a post with the composer rendered now
 * costs **two** Worker requests, not one: this endpoint and
 * `/comments/form-token`, which is prefetched when the composer renders (see
 * `prefetchFormToken` in the widget) and stays separate on purpose — see below.
 * That is a ~50k pageview/day ceiling, up from ~25k at the four calls a default
 * install used to make and ~16k with every surface on. `/embed.js` is not in the
 * count: it ships `s-maxage=86400`, so the edge serves it and the Worker sees it
 * once per colo per day rather than once per pageview.
 *
 * It is also a latency win, not just an accounting one. The old boot fully
 * awaited `/config` before it could fetch the tree, because the tree request
 * needs the resolved locale — two serial round trips before the first comment
 * could paint. This is one.
 *
 * Response:
 *   {
 *     config:       { …exactly GET /api/v1/config… },
 *     user:         { …exactly GET /api/v1/auth/me's `user`… } | null,
 *     comments:     { …exactly GET /api/v1/comments… },
 *     engagement:   { reactions?, my_reactions?, votes? },  // page_* flags only
 *     subscription: { subscribed, pending, id }             // signed-in + mail only
 *   }
 *
 * **Every section is byte-identical to what its standalone endpoint returns**,
 * and `tests/bootstrap.test.ts` pins that by diffing the two. That invariant is
 * what lets the widget reuse one set of parsing code for both boot paths, and
 * what makes the fallback below equivalent rather than merely similar.
 *
 * The old endpoints all remain — they are public API, `/comments` is still how
 * load-more pages, and a widget built from this repo has to keep working against
 * an older self-hosted Worker that has no `/bootstrap` (the widget falls back to
 * the legacy calls on a 404).
 *
 * `/comments/form-token` deliberately stays a separate call. Its signed
 * timestamp is the anti-spam minimum-elapsed-time heuristic
 * (`lib/spam/heuristics.ts`); baking one into a shared, cached payload would
 * hand every reader the same start time and defeat it.
 *
 * **This response carries no cache headers**, for the same reason `/config`
 * carries none: it varies by locale and by session. The *comments* section is
 * still edge-cached — see `buildTreePage`, which reuses the very cache entry
 * `/comments` uses, so bootstrap adds no second key and `bustTreeCache` keeps
 * covering both paths.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	getPageVote,
	getSubscriptionForEmailAndSlug,
	getUser,
	listPageReactions,
	listUserPageReactions,
} from "../db/queries";
import { isActiveUser } from "../lib/active-user";
import { readSession } from "../lib/session";
import { loadSettings } from "../lib/settings";
import { putCache, tryWaitUntil } from "../lib/response-cache";
import { TREE_CACHE_TTL } from "../lib/tree-cache";
import { buildTreePage, SLUG_RE } from "./api.comments";
import { buildConfigPayload, resolveConfigLocale } from "./api.config";
import { reactionTotals } from "./api.page-engagement";
import { publicUser } from "./auth";
import { FALLBACK_LOCALE, tFor } from "../i18n";
import type { LocaleVars } from "../lib/locale";

type SessionVars = {
	userId: string | null;
	sessionId: string | null;
};

const bootstrap = new Hono<{
	Bindings: Bindings;
	Variables: SessionVars & LocaleVars;
}>();

bootstrap.get("/", async (c) => {
	// Shadows the module-level English `t` for the whole handler, so an error
	// body matches the language the rest of the widget is in.
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);
	const slug = (c.req.query("slug") ?? "").trim();
	if (!slug) return c.json({ error: t("err.post.required") }, 400);
	if (!SLUG_RE.test(slug)) return c.json({ error: t("err.post.invalid") }, 400);

	const sortParam = (c.req.query("sort") ?? "new").trim();
	const sort: "new" | "top" = sortParam === "top" ? "top" : "new";

	// One settings read and one session read for what used to be three and four.
	// `readSession` costs two KV reads and, once a session ages past its refresh
	// window, a KV *write* to slide the TTL. Those calls used to be concurrent
	// across the mount's requests, so they all saw the same aged record and all
	// decided to write — up to ~5 writes where 1 would do, against a 1000/day
	// account-wide KV write cap.
	const resolved = await loadSettings(c.env);
	const { flags, numbers } = resolved;
	const session = await readSession(c);

	// Full locale negotiation, including the operator's default_locale — the
	// same call `/config` makes, so the widget learns its language here and
	// echoes it back as `?lang=` on every later request.
	const locale = resolveConfigLocale(
		c.req.query("lang"),
		c.req.query("hl"),
		resolved.strings.default_locale,
	);

	// One row serving both the `user` section and the subscription gate below;
	// `/auth/me` and `/subscribe/mine` each read it separately today.
	const user = session ? await getUser(c.env.DB, session.user_id) : null;

	const tree = await buildTreePage(c.env, c.req.url, {
		slug,
		sort,
		beforeRaw: c.req.query("before") ?? null,
		session,
		flags,
		numbers,
	});
	// A hit is already-serialized JSON; embed it as-is rather than parse-and-
	// re-stringify, which is both wasted work and a chance to alter the bytes.
	const comments =
		"cached" in tree ? JSON.parse(tree.cached) : tree.payload;
	// Warm the shared entry when this page is storable. Same key, same TTL, same
	// body as `/comments` would have written, so a tree warmed by either route
	// serves the other.
	if (!("cached" in tree) && tree.store) {
		await putCache(
			tree.store,
			JSON.stringify(tree.payload),
			TREE_CACHE_TTL,
			tryWaitUntil(c),
		);
	}

	const payload: Record<string, unknown> = {
		config: buildConfigPayload(c.env, resolved, locale),
		// Identity, not authorization: a banned or erased reader still gets a
		// `user` here, exactly as `/auth/me` does. See `publicUser`.
		user: user ? publicUser(user) : null,
		comments,
	};

	// Page-level reactions/votes, both default OFF. Omitted entirely when
	// neither surface is on, so the common install pays no bytes for them.
	if (flags.page_reactions_enabled || flags.page_votes_enabled) {
		const engagement: Record<string, unknown> = {};
		// Anonymous viewers get totals only; we deliberately do not mint a ghost
		// user on a GET just to look up "my" state (their own state appears after
		// they first interact).
		const userId = session?.user_id ?? null;
		if (flags.page_reactions_enabled) {
			engagement.reactions = reactionTotals(
				await listPageReactions(c.env.DB, slug),
			);
			engagement.my_reactions = userId
				? [...(await listUserPageReactions(c.env.DB, slug, userId))]
				: [];
		}
		if (flags.page_votes_enabled) {
			engagement.votes = await getPageVote(c.env.DB, slug, userId);
		}
		payload.engagement = engagement;
	}

	// Bell state for this thread. Requires a session that may act (a banned or
	// erased identity gets the section omitted, which is how `/subscribe/mine`'s
	// 403 reads once folded into a 200 envelope) and an install that can send
	// mail at all — the same EMAIL_FROM + PUBLIC_BASE_URL pair `POST /subscribe`
	// fails closed on.
	//
	// Unlike `/subscribe/mine` this is NOT rate-limited, and that is deliberate.
	// That limiter exists because a standalone per-pageview read spends budget an
	// unbounded number of times; here the read is one indexed lookup on
	// UNIQUE(post_slug, email) inside a request the caller was making anyway, so
	// a limiter would only add a bucket to maintain. `/subscribe/mine` keeps
	// its own.
	const canMail = !!(c.env.EMAIL_FROM && c.env.PUBLIC_BASE_URL);
	if (user && isActiveUser(user) && canMail) {
		const email = user.email ? user.email.toLowerCase() : null;
		const row = email
			? await getSubscriptionForEmailAndSlug(c.env.DB, email, slug)
			: null;
		const subscribed = row != null && row.unsubscribed_at == null;
		payload.subscription = {
			subscribed,
			pending: subscribed && row?.confirmed_at == null,
			id: subscribed ? (row?.id ?? null) : null,
		};
	}

	return c.json(payload);
});

export { bootstrap };
