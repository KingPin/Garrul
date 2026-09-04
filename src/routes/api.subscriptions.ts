/**
 * POST /api/v1/subscribe                          { post_slug, email? }
 * GET  /api/v1/subscribe/confirm/:token
 * GET  /api/v1/subscribe/unsubscribe/:token       offers to unsubscribe
 * POST /api/v1/subscribe/unsubscribe/:token       does it (human form)
 * POST /api/v1/subscribe/unsubscribe/:token/all   every thread for that address
 * POST /api/v1/subscribe/unsubscribe/:token/row/:id  one listed thread
 * POST /api/v1/subscribe/unsubscribe/:token/one-click   does it (RFC 8058)
 * GET  /api/v1/subscribe/mine[?post_slug=]        what this session follows
 * DELETE /api/v1/subscribe/mine/:id               cancels one of them
 *
 * Subscription model:
 *   - One row per (post_slug, email). This endpoint is unauthenticated and
 *     takes an arbitrary address, so re-subscribing an existing address is
 *     deliberately non-destructive: it keeps the row's unsubscribe token and
 *     does not un-cancel it. See `upsertSubscription` for what each branch is
 *     allowed to touch and why.
 *   - Tokens are 32 random bytes hex-encoded. We don't sign them with
 *     JWT_SECRET because storage + lookup is just as cheap and avoids
 *     a class of "I forgot to invalidate the secret" bugs.
 *
 * Double-opt-in (added 2026-05-20):
 *   - `confirm_token` + `confirmed_at` columns gate the row from receiving
 *     digests. POST stores `confirmed_at = NULL` and emails the confirm
 *     link. GET /confirm/:token sets `confirmed_at = now`.
 *   - Fast path: when a logged-in user subscribes their own email AND the
 *     session user is provider-verified (github/google), we auto-confirm.
 *     A signed-in caller may omit `email` entirely — the session supplies
 *     it, which is what the widget relies on.
 *     The user already proved control of the inbox to the provider, so a
 *     second loop adds friction without security.
 *   - A per-email pending cap (5) prevents amplifying the confirmation
 *     email itself into a mailbomb — without it an attacker could forge
 *     5 confirm-emails per minute per IP without consuming any of them.
 *
 * Mailbomb defence, in the order it applies (issue #64):
 *   1. The IP-keyed rate limiter. Racy on the default Cache API backend — N
 *      concurrent requests from one identity sustain ~N x the cap — so it
 *      raises cost but is not a ceiling. Binding RATE_LIMIT_DO fixes that, and
 *      is opt-in.
 *   2. `PENDING_PER_EMAIL_CAP`. Atomic, but keyed on the address, so an attacker
 *      cycling addresses never touches it.
 *   3. `reserveSend` — a global, atomic, D1-counted ceiling on
 *      confirmation email. The only one of the three that an address-cycling
 *      concurrent burst cannot get past on a default install. See
 *      src/lib/email-budget.ts for why it is global and what that costs.
 */
import { Hono, type Context } from "hono";
import type { Bindings } from "../index";
import {
	adminGetSubscription,
	confirmSubscription,
	countPendingSubscriptionsForEmail,
	getPost,
	getSubscriptionByConfirmToken,
	getSubscriptionByToken,
	getSubscriptionForEmailAndSlug,
	listActiveSubscriptionsForEmail,
	markAllSubscriptionsUnsubscribedForEmail,
	markSubscriptionUnsubscribed,
	upsertSubscription,
} from "../db/queries";
import { requireActiveUser } from "../lib/active-user";
import { confirmSendBudgets, reserveSend } from "../lib/email-budget";
import { requireIpHash } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { renderConfirmEmailHtml } from "../lib/digest";
import { sendEmail } from "../lib/email";
import { fillSubject, subjectTitle, substituteTitle } from "../lib/post-title";
import { readSession } from "../lib/session";
import { SLUG_RE } from "../lib/slug";
import { loadNumbers } from "../lib/settings";
import { FALLBACK_LOCALE, LOCALES, type Translator, tFor } from "../i18n";
import { matchLocale } from "../i18n/negotiate";
import type { LocaleVars } from "../lib/locale";

const subscriptions = new Hono<{ Bindings: Bindings; Variables: LocaleVars }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PENDING_PER_EMAIL_CAP = 5;
const PROVIDER_VERIFIED = new Set(["github", "google"]);

/**
 * Which language a confirm/unsubscribe landing page renders in.
 *
 * The subscription's own locale first: the reader clicked through from mail
 * that was written in it, and an English page on the other end of a German
 * link is the same break the localized mail exists to avoid. Rows predating
 * `subscriptions.locale` have none, and an expired token resolves no row at
 * all, so both fall back to whatever the request negotiated.
 *
 * The final fallback covers this router being mounted without
 * `localeMiddleware` — cheaper than rendering `lang="undefined"` to find out.
 *
 * Both sources go through `matchLocale` because the return value becomes the
 * document's `lang` (and its `dir`), not just the translator's key. The stored
 * locale is negotiated-and-canonical at write time, but the row outlives the
 * registry that validated it: retire a locale and every subscription holding it
 * still resolves. Passed through verbatim that row would render `lang="de"`
 * over English copy, since `tFor` falls back to English for a tag it doesn't
 * carry — a mismatch a screen reader announces and a reader cannot see.
 * Canonicalizing collapses that to "unusable, use the next source".
 */
const landingLocale = (
	rowLocale: string | null | undefined,
	requestLocale: string | undefined,
): string => matchLocale(rowLocale) ?? matchLocale(requestLocale) ?? FALLBACK_LOCALE;

/**
 * The `/unsubscribe/:token` prefix of the request currently being handled,
 * whichever of the four routes under it that is.
 *
 * The landing page's forms post to `${base}/all` and `${base}/row/:id`.
 * Deriving the prefix from the request rather than writing `/api/v1/subscribe/…`
 * into the HTML keeps the page correct if this router is ever mounted under a
 * different prefix, and keeps the token in exactly the form the reader's client
 * already sent — no re-serialization, so no chance of mangling it.
 */
const unsubBasePath = (url: string): string =>
	new URL(url).pathname.replace(/\/(all|row\/[^/]+)$/, "");

const randomToken = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

subscriptions.post("/", async (c) => {
	// Shadows the module-level English `t` for the whole handler, so every
	// string below — errors, the JSON message, the confirmation email — comes
	// out in the language of the page the reader subscribed from.
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);
	const locale = c.get("locale") ?? null;

	// Rate-limit before any DB work. Subscribing is otherwise free for
	// anyone with a valid email shape and a post slug, so without this
	// the endpoint is an enumeration / spam vector.
	const ipHash = await requireIpHash(c);
	if (ipHash instanceof Response) return ipHash;
	const rl = await checkRateLimit(c.req.url, ipHash, {
		scope: "subscribe",
		env: c.env,
	});
	if (!rl.ok) {
		return c.json(
			{ error: t("err.ratelimit"), reason: rl.reason ?? null },
			429,
		);
	}

	const body = await c.req.json<{
		post_slug?: string;
		email?: string;
	}>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	// The same alphabet the read side accepts (SLUG_RE), not a bare length cap:
	// this slug is stored as-is, becomes the subject-line fallback when the post
	// has no title, and is rendered on the confirm and unsubscribe pages, so a
	// CR, LF or angle bracket here would reach a mail header and an HTML body.
	const post_slug = (body.post_slug ?? "").trim();
	if (!SLUG_RE.test(post_slug)) {
		return c.json({ error: t("err.post.invalid") }, 400);
	}

	// Session first, because it can supply the address. requireActiveUser,
	// not getUser: a banned user must not get the skip-the-confirmation-email
	// fast path below, and shouldn't be subscribing under their account at all.
	const session = await readSession(c);
	const user = session
		? await requireActiveUser(c.env.DB, session.user_id)
		: null;
	if (session && !user) return c.json({ error: t("err.banned") }, 403);

	// `email` is optional for a signed-in caller, and that is not a
	// convenience — it is the only way the widget's opt-in works for them.
	// The composer renders an email field only for anonymous visitors
	// ("Signed-in: we already have their email so just the box",
	// src/widget/embed.ts), so an OAuth reader ticking the box posts no
	// address at all. Before this fallback the request was never sent, the
	// checkbox was a silent no-op for every signed-in reader, and the
	// auto-confirm path below was unreachable from the widget.
	//
	// Anonymous callers are unchanged: no session, no fallback, a missing
	// address is still a 400.
	const email = ((body.email ?? "").trim() || (user?.email ?? ""))
		.trim()
		.toLowerCase();
	if (!EMAIL_RE.test(email) || email.length > 320) {
		return c.json({ error: "invalid_email" }, 400);
	}

	// Fast-path auto-confirm: logged-in user subscribing their own
	// provider-verified email. Provider already vouched for inbox control.
	const autoConfirm =
		user != null &&
		user.email != null &&
		user.email.toLowerCase() === email &&
		PROVIDER_VERIFIED.has(user.provider);

	// Bound never-confirmed rows per email to keep the confirmation email
	// itself from being weaponized as a mailbomb. The cap is generous so
	// real users juggling threads aren't rejected.
	if (!autoConfirm) {
		const pending = await countPendingSubscriptionsForEmail(c.env.DB, email);
		if (pending >= PENDING_PER_EMAIL_CAP) {
			return c.json(
				{ error: t("err.ratelimit"), reason: "pending_limit_exceeded" },
				429,
			);
		}
	}

	// Fail closed when the operator hasn't configured outbound email.
	// Without these we'd persist a pending row that the user can never
	// confirm (no email sent), and after five attempts the pending-cap
	// would lock the address out entirely.
	const publicBase = c.env.PUBLIC_BASE_URL;
	const from = c.env.EMAIL_FROM;
	if (!autoConfirm && (!publicBase || !from)) {
		return c.json({ error: t("err.internal") }, 503);
	}

	// The one control an address-cycling concurrent burst cannot get past on a
	// default install. Reserved BEFORE the upsert on purpose: denying after it
	// would leave behind exactly what the guard above exists to prevent — a
	// pending row whose confirmation email never went out, which the reader can
	// never confirm and which still consumes their per-email cap.
	//
	// The auto-confirm path sends no confirmation email, so it spends no budget —
	// and skips the settings read too, since the caps are the only thing it needs.
	const reservation = autoConfirm
		? null
		: await reserveSend(
				c.env.DB,
				confirmSendBudgets(await loadNumbers(c.env)),
			);
	if (reservation && !reservation.ok) {
		return c.json(
			{ error: t("err.ratelimit"), reason: "send_budget_exhausted" },
			429,
		);
	}

	const unsubscribeToken = randomToken();
	const confirm_token = autoConfirm ? null : randomToken();
	const sub = await upsertSubscription(
		c.env.DB,
		post_slug,
		email,
		unsubscribeToken,
		confirm_token,
		autoConfirm,
		// The digest cron has no request to negotiate from, so the language has
		// to be recorded now or the reader gets English mail forever after.
		locale,
	);

	// Send confirmation email only when actually needed. If the upsert
	// found an already-confirmed row we don't email either — the user is
	// effectively re-confirming an existing subscription, nothing to do.
	if (
		!autoConfirm &&
		sub.confirmed_at == null &&
		sub.confirm_token &&
		publicBase &&
		from
	) {
		const post = await getPost(c.env.DB, post_slug);
		const confirmUrl = `${publicBase}/api/v1/subscribe/confirm/${sub.confirm_token}`;
		// Sanitized again here, not just on the write path: a database upgraded
		// from an earlier version can still hold a title with a CR/LF in it, and
		// a mail subject is a header value.
		const title = subjectTitle(post?.title, post_slug);
		const html = renderConfirmEmailHtml({
			postTitle: title,
			confirmUrl,
			t,
		});
		const sent = await sendEmail(c.env, {
			to: email,
			from,
			subject: fillSubject(t("email.confirm.subject"), title),
			html,
		});
		if (!sent) {
			// The budget counts sends, so a send that didn't happen must not stay
			// counted. `sendEmail` returns false and logs when RESEND_API_KEY is
			// missing or the provider rejects the call; without this refund, an
			// install with EMAIL_FROM set but the secret unset would spend the
			// whole daily ceiling on zero mail and then start refusing new
			// subscribers. Safe to refund here where it isn't on a budget denial:
			// provider failure is not something a caller can induce on demand.
			await reservation?.release();
		}
	} else {
		// No mail went out — the upsert found an already-confirmed row. Hand the
		// slot back so a reader re-subscribing to a thread they already confirmed
		// doesn't silently spend global budget on an email nobody sent.
		await reservation?.release();
	}

	// Constant unless *this* caller proved they own the inbox. Mirroring the
	// stored `confirmed_at` made this a silent subscription oracle: a "confirmed"
	// answer told an unauthenticated prober the address is already subscribed to
	// this post, and that branch sends no mail, so the victim saw nothing.
	// `subscription_id` is gone for the same reason — a ULID also leaks *when*
	// they subscribed. Nothing consumes it: the widget ignores the body entirely.
	return c.json({
		ok: true,
		status: autoConfirm ? "confirmed" : "pending",
		message: autoConfirm
			? t("ui.subscribe.confirmed")
			: t("ui.subscribe.pending"),
	});
});

/**
 * Confirm is POST-confirmed, exactly like unsubscribe below. The GET the mail
 * links to only renders a form; the write happens on the same-origin POST. A
 * GET that wrote let every link-scanning gateway and prefetching mail client
 * complete a double-opt-in the recipient never saw — which is the one thing
 * double-opt-in exists to rule out. The token stays the capability; the POST
 * exists to make sure a human pressed the button.
 */
subscriptions.get("/confirm/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByConfirmToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	const locale = landingLocale(sub.locale, c.get("locale"));
	const t = tFor(locale);

	// Already confirmed (an earlier click, or auto_confirm): land on the success
	// page rather than offering to confirm again.
	if (sub.confirmed_at != null) {
		return c.html(
			pageHtml(fillTitleHtml(t("ui.subscribe.confirmed_page"), postLabel), locale),
		);
	}

	return c.html(
		actionPageHtml(
			{
				prompt: "ui.subscribe.confirm_prompt",
				cta: "ui.subscribe.confirm_cta",
				note: "ui.subscribe.confirm_note",
			},
			postLabel,
			locale,
			t,
		),
	);
});

subscriptions.post("/confirm/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByConfirmToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	// Idempotent by its WHERE clause: a second submit lands on the same page.
	await confirmSubscription(c.env.DB, sub.id);

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	const locale = landingLocale(sub.locale, c.get("locale"));
	return c.html(
		pageHtml(
			fillTitleHtml(tFor(locale)("ui.subscribe.confirmed_page"), postLabel),
			locale,
		),
	);
});

/**
 * The GET only *offers* to unsubscribe. Mail clients, link scanners and
 * corporate security gateways prefetch every URL in a message, so a GET that
 * wrote silently unsubscribed people who never clicked — and the row is
 * `unsubscribed_at`-stamped, so their next reply notification just never
 * arrived. `confirmSubscription` has carried a note about exactly this hazard
 * since it shipped; unsubscribe never got the same treatment.
 *
 * The POST below does the write. It is same-origin-checked (see
 * SELF_ORIGIN_POST_PATHS in lib/cors.ts) and the token stays the capability.
 */
subscriptions.get("/unsubscribe/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	const locale = landingLocale(sub.locale, c.get("locale"));
	const t = tFor(locale);
	// Everything else this address follows. Rendered on the already-unsubscribed
	// page too: that reader has finished with this thread and is exactly the one
	// who may want out of the rest.
	const manage = await manageHtml(
		c.env.DB,
		sub.email,
		sub.id,
		unsubBasePath(c.req.url),
		t,
	);

	if (sub.unsubscribed_at != null) {
		return c.html(
			pageHtml(
				fillTitleHtml(t("ui.subscribe.already_unsubscribed"), postLabel),
				locale,
				manage,
			),
		);
	}

	return c.html(unsubscribeConfirmPageHtml(postLabel, locale, t, manage));
});

subscriptions.post("/unsubscribe/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	if (sub.unsubscribed_at == null) {
		await markSubscriptionUnsubscribed(c.env.DB, sub.id);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	const locale = landingLocale(sub.locale, c.get("locale"));
	const t = tFor(locale);
	return c.html(
		pageHtml(
			fillTitleHtml(t("ui.subscribe.unsubscribed"), postLabel),
			locale,
			// Listed after the write, so the thread just cancelled is already gone
			// from it and the reader sees only what is still live.
			await manageHtml(
				c.env.DB,
				sub.email,
				sub.id,
				unsubBasePath(c.req.url),
				t,
			),
		),
	);
});

/**
 * Unsubscribe every thread this address follows.
 *
 * The token proves mailbox access, which is the same thing it proves for the
 * single-thread POST above — it just acts on every row keyed to that address
 * rather than the one row the token names. No confirmation step beyond the
 * button itself: the reader clicked something labelled "unsubscribe from all
 * threads", and a second are-you-sure on a leave action is the friction that
 * makes people hit the spam button instead.
 *
 * Not reachable by prefetch: POST only, same-origin-checked (the form is served
 * by this Worker — see SELF_ORIGIN_POST_PATHS in lib/cors.ts).
 */
subscriptions.post("/unsubscribe/:token/all", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	await markAllSubscriptionsUnsubscribedForEmail(c.env.DB, sub.email);

	const locale = landingLocale(sub.locale, c.get("locale"));
	return c.html(
		pageHtml(
			escapeHtml(tFor(locale)("ui.subscribe.unsubscribed_all")),
			locale,
		),
	);
});

/**
 * Unsubscribe one row from the list, addressed by subscription id.
 *
 * The id is not a capability and is not treated as one: the token still is.
 * This re-loads the row and requires it to belong to the token's address,
 * exactly as `DELETE /mine/:id` requires it to belong to the session's — a
 * scraped id from someone else's page cancels nothing.
 *
 * A mismatch renders the same "link expired or already used" page as an unknown
 * token, under a 404. Distinguishing "that id isn't yours" from "no such id"
 * would confirm the id exists, which is the only thing an id-guesser could
 * learn here.
 */
subscriptions.post("/unsubscribe/:token/row/:id", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		const locale = landingLocale(null, c.get("locale"));
		return c.html(
			pageHtml(escapeHtml(tFor(locale)("ui.subscribe.link_expired")), locale),
		);
	}

	const locale = landingLocale(sub.locale, c.get("locale"));
	const t = tFor(locale);

	const id = c.req.param("id");
	const row = id ? await adminGetSubscription(c.env.DB, id) : null;
	if (!row || row.email.toLowerCase() !== sub.email.toLowerCase()) {
		return c.html(
			pageHtml(escapeHtml(t("ui.subscribe.link_expired")), locale),
			404,
		);
	}

	if (row.unsubscribed_at == null) {
		await markSubscriptionUnsubscribed(c.env.DB, row.id);
	}

	const post = await getPost(c.env.DB, row.post_slug);
	return c.html(
		pageHtml(
			fillTitleHtml(t("ui.subscribe.unsubscribed"), post?.title ?? row.post_slug),
			locale,
			// `sub.id` stays the excluded row: the reader is still on the landing
			// page for the thread the mail was about, and it keeps its own form
			// above rather than appearing twice.
			await manageHtml(
				c.env.DB,
				sub.email,
				sub.id,
				unsubBasePath(c.req.url),
				t,
			),
		),
	);
});

/**
 * RFC 8058 one-click unsubscribe. The target of the `List-Unsubscribe` header
 * the digest sets, so this is what Gmail's and Apple Mail's native Unsubscribe
 * button hits.
 *
 * Separate from the human POST above rather than folded into it, on three
 * counts:
 *
 *   - **Caller.** This arrives from the mail provider's servers with no Origin
 *     header, which needs its own CORS class (NO_ORIGIN_POST_PATHS in
 *     lib/cors.ts). The human form's same-origin check must not be relaxed to
 *     accommodate that.
 *   - **Response.** No human reads this. It returns a bare text/plain 200 and
 *     must never echo the address or the post — the response goes to a third
 *     party's fetcher, not to the subscriber.
 *   - **Method.** POST-only, so the mail-client *prefetchers* that motivated
 *     the GET/POST split above cannot reach it either. RFC 8058 requires the
 *     one-click target to be POST-only for exactly this reason.
 *
 * Unknown or expired token also answers 200. A non-2xx here is reported by the
 * mail client as "unsubscribe failed" to a reader who has no way to act on it,
 * and repeated failures count against sender reputation — while the only thing
 * a differential response buys an attacker is confirmation that a 256-bit token
 * they already hold is real.
 *
 * **Deliberately not IP-rate-limited**, which is a departure from every other
 * write on this router. The identity here is a mail provider's shared egress —
 * every Gmail user's unsubscribe leaves from the same handful of Google IPs, so
 * an IP bucket (or the global envelope, 200/10min) throttles legitimate
 * unsubscribes on any instance with real traffic while costing an attacker
 * nothing: the sibling GET /unsubscribe/:token does the identical unindexed
 * token lookup with no limit at all. The bound on abuse is the token's
 * unguessability, same as the GET.
 */
subscriptions.post("/unsubscribe/:token/one-click", async (c) => {
	const token = c.req.param("token");
	if (token) {
		const sub = await getSubscriptionByToken(c.env.DB, token);
		// Same idempotent write as the human POST: only the first call stamps
		// the row, so a provider retry is a no-op rather than a second audit
		// entry.
		if (sub && sub.unsubscribed_at == null) {
			await markSubscriptionUnsubscribed(c.env.DB, sub.id);
		}
	}
	return c.text("ok", 200);
});

/**
 * ─── Session-scoped management ───────────────────────────────────────────
 *
 *   GET    /api/v1/subscribe/mine?post_slug=X   → { subscribed, pending }
 *   GET    /api/v1/subscribe/mine               → { subscriptions: [...] }
 *   DELETE /api/v1/subscribe/mine/:id           → unsubscribe one row
 *
 * The second of two management surfaces, and it exists *because* the emailed
 * one cannot cover it. A hosted "manage your subscriptions" page on this
 * Worker's own origin is impossible here: the session cookie is
 * `SameSite=None; Secure; Partitioned`, so it materializes in the *embedder's*
 * cookie partition (that is what `POST /auth/session/exchange` is for), and a
 * top-level page on comments.example.com is a different partition that cannot
 * see it. The signed-in surface therefore has to live inside the widget, and
 * these three routes are what it calls.
 *
 * **The gate is `user.email != null`, deliberately not `PROVIDER_VERIFIED`.**
 * The two sets answer different questions and reusing the wrong one here is
 * the mistake worth naming. `PROVIDER_VERIFIED` (github, google) decides
 * whether we trust a provider enough to *skip sending* a confirmation mail —
 * it is a mailbomb-economics judgement, not an identity one. Gating `/mine` on
 * it would let Facebook and Discord readers subscribe and then refuse them any
 * way to see or cancel what they follow, which is the exact gap this work
 * exists to close.
 *
 * What makes `user.email != null` sufficient is a contract stated upstream:
 * `ProviderProfile.email` is null unless the provider vouched for the address
 * as verified (src/lib/oauth.ts, where every fetcher upholds it). A provider
 * that returned an unverified claim would turn these routes into an oracle
 * against someone else's mailbox — sign in asserting victim@example.com, read
 * back what they follow. That the claim can't be unverified is a property of
 * oauth.ts, not of this file, which is why it is written down in both places.
 *
 * A reader with no address at all — an anonymous ghost, or X/Twitter, whose v2
 * API exposes no email under our scopes — is signed in but owns nothing here.
 * That is an empty account, not an error: they get an empty list and an unlit
 * bell rather than a status code they can do nothing about.
 *
 * **Known limitation, deliberately not reconciled.** `POST /subscribe` takes
 * the address from the request body *or* the session (see :160), so a signed-in
 * reader who types some other address creates a row keyed to that address —
 * which their own `/mine` will never show, and which stays reachable only
 * through its emailed unsubscribe link. Closing the gap means either refusing
 * signed-in readers a second address or letting a session cancel rows for an
 * address it has not proven; both are worse than the gap.
 */

/**
 * Reads are cheap and session-gated, but they fire on every widget mount, so
 * the shared `DEFAULTS` (1/10s, 5/600s) would cut a reader off after their
 * fifth post in ten minutes. Its own scope because it has its own config —
 * see the note on `RateLimitOptions.scope` for what sharing one costs.
 */
const MINE_LIMITS = {
	short: { max: 10, windowSec: 10 },
	long: { max: 60, windowSec: 600 },
};

/**
 * Session gate and rate limit for both `/mine` routes, in that order, plus the
 * address they act on — or the response that refuses.
 *
 * `email: null` is not a failure: it is a signed-in reader whose account
 * carries no address (ghost, X/Twitter), and each caller decides what empty
 * means for it. The 401/403 split mirrors `POST /subscribe` at :143-147 — a
 * session pointing at a refused user is banned, not unauthenticated.
 *
 * **The limiter keys on the account, not the client IP, and that is the whole
 * reason this helper exists.** `GET /mine` fires on every widget mount, so an
 * IP-keyed check spends one token of the shared per-IP `GLOBAL_ENVELOPE`
 * (20/10s, 200/10min) per *page view* — a budget every write endpoint on this
 * Worker draws from. Behind one office NAT or a carrier CGNAT, readers merely
 * *loading* the page would drain the short bucket, and the resulting 429 would
 * land on somebody trying to post a comment: a symptom nowhere near its cause.
 * Every other rate-limited route here is a write, so this is the first read on
 * a per-page-view path and the first that could do that. Keying on `user:`
 * gives each account its own envelope and leaves the IP budget to the writes it
 * was sized for.
 *
 * Session first, D1 second — same order as `PATCH /comments/:id`
 * (api.comments.ts:1021) and for the same reason. A caller with no cookie is
 * refused before spending either a KV or a D1 read, because `readSession`
 * returns null without touching KV when the cookie is absent or malformed.
 */
const mineGate = async (
	c: Context<{ Bindings: Bindings; Variables: LocaleVars }>,
	t: Translator,
): Promise<{ email: string | null } | Response> => {
	const session = await readSession(c);
	if (!session) return c.json({ error: t("err.session.expired") }, 401);

	const rl = await checkRateLimit(c.req.url, `user:${session.user_id}`, {
		scope: "subscribe-mine",
		config: MINE_LIMITS,
		env: c.env,
	});
	if (!rl.ok) {
		return c.json({ error: t("err.ratelimit"), reason: rl.reason ?? null }, 429);
	}

	const user = await requireActiveUser(c.env.DB, session.user_id);
	if (!user) return c.json({ error: t("err.banned") }, 403);
	return { email: user.email ? user.email.toLowerCase() : null };
};

subscriptions.get("/mine", async (c) => {
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);

	const gate = await mineGate(c, t);
	if (gate instanceof Response) return gate;
	const { email } = gate;

	const post_slug = (c.req.query("post_slug") ?? "").trim();
	if (post_slug) {
		// Bell state. One read on UNIQUE(post_slug, email) — this is the query
		// the widget makes on every mount, so it must not become a table scan.
		const row = email
			? await getSubscriptionForEmailAndSlug(c.env.DB, email, post_slug)
			: null;
		const subscribed = row != null && row.unsubscribed_at == null;
		// `pending` is the un-confirmed half of `subscribed`. Without it the bell
		// has to either lie (lit, but no mail will ever arrive) or under-report
		// (unlit, so the reader subscribes again and burns another confirmation
		// email against the pending cap). It costs nothing — same row.
		//
		// `id` is what makes the bell a two-way toggle: cancelling goes through
		// `DELETE /mine/:id`, so without it the widget would have to fetch the
		// reader's whole list just to learn the id of the thread it is already
		// looking at. Unlike `POST /subscribe` (see :298), disclosing a ULID here
		// leaks nothing — the session has already proven it owns this address, so
		// there is no third party for the id to be an oracle about.
		return c.json({
			subscribed,
			pending: subscribed && row?.confirmed_at == null,
			id: subscribed ? (row?.id ?? null) : null,
		});
	}

	// Un-confirmed rows are listed too: they are real rows the reader created,
	// they occupy the per-address pending cap, and a subscription you cannot see
	// is one you cannot cancel.
	const list = email
		? await listActiveSubscriptionsForEmail(c.env.DB, email)
		: [];
	return c.json({ subscriptions: list });
});

/**
 * Cancel one subscription by id.
 *
 * **IDOR guard, and the status code is part of it.** A row the session does not
 * own answers 404, not 403: 403 confirms the id exists, which turns a ULID
 * guess into an existence oracle over other readers' subscriptions. The same
 * 404 covers "no such row", "not your address", and "your account has no
 * address at all" — three different reasons the caller has no business
 * distinguishing. (An address-less reader can own no row by construction, and
 * the list above already renders them nothing to click, so this path is only
 * reachable by a hand-made request.)
 */
subscriptions.delete("/mine/:id", async (c) => {
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);

	const gate = await mineGate(c, t);
	if (gate instanceof Response) return gate;
	const { email } = gate;

	const id = c.req.param("id");
	const row = id ? await adminGetSubscription(c.env.DB, id) : null;
	if (!row || !email || row.email.toLowerCase() !== email) {
		return c.json({ error: t("err.not_found") }, 404);
	}

	// Idempotent: a second DELETE reports success without moving the timestamp
	// that records when the reader actually asked to stop.
	if (row.unsubscribed_at == null) {
		await markSubscriptionUnsubscribed(c.env.DB, row.id);
	}
	return c.json({ ok: true });
});

const escapeHtml = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/**
 * Fill a `{title}` template for HTML output.
 *
 * The template is escaped first — it is repo content, but a stray `<` in a
 * translation should render as text rather than open a tag — and the title is
 * escaped separately on the way in. Substitution goes through
 * `substituteTitle`, which is where the replacement-function and global-pattern
 * rules are documented.
 */
const fillTitleHtml = (template: string, title: string): string =>
	substituteTitle(escapeHtml(template), () => escapeHtml(title));

const pageHtml = (message: string, locale: string, extra = ""): string => `
<!doctype html>
<html lang="${escapeHtml(locale)}"${LOCALES[locale]?.rtl ? ' dir="rtl"' : ""}>
<head>
<meta charset="utf-8">
<title>Garrul</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         max-width: 440px; margin: 4rem auto; padding: 0 1rem;
         line-height: 1.55; }
  h1 { margin-top: 0; font-size: 1.2rem; }
</style>
</head>
<body>
<h1>Garrul</h1>
<p>${message}</p>
${extra}
</body>
</html>`;

/**
 * The one-click confirmation. No `action` attribute: the form posts back to the
 * current URL, so the token never has to be re-serialized (and can't be
 * mangled) on the way out.
 *
 * `postLabel` is raw — `fillTitleHtml` escapes it along with its template.
 */
type ActionPageKeys = {
	prompt: Parameters<Translator>[0];
	cta: Parameters<Translator>[0];
	note: Parameters<Translator>[0];
};

const actionPageHtml = (
	keys: ActionPageKeys,
	postLabel: string,
	locale: string,
	t: Translator,
	manage = "",
): string =>
	pageHtml(
		fillTitleHtml(t(keys.prompt), postLabel),
		locale,
		`<form method="post">
  <button type="submit" style="font:inherit;padding:0.5rem 1rem;cursor:pointer">
    ${escapeHtml(t(keys.cta))}
  </button>
</form>
<p style="color:#6b7280;font-size:0.875rem">
  ${escapeHtml(t(keys.note))}
</p>${manage}`,
	);

const unsubscribeConfirmPageHtml = (
	postLabel: string,
	locale: string,
	t: Translator,
	manage = "",
): string =>
	actionPageHtml(
		{
			prompt: "ui.subscribe.unsubscribe_confirm",
			cta: "ui.subscribe.unsubscribe_cta",
			note: "ui.subscribe.unsubscribe_note",
		},
		postLabel,
		locale,
		t,
		manage,
	);

const BUTTON_STYLE = "font:inherit;padding:0.35rem 0.75rem;cursor:pointer";

/**
 * The account-level half of the emailed landing page: every *other* thread this
 * address still follows, each with its own unsubscribe button, plus one button
 * that stops all of them.
 *
 * This exists because the per-thread link is only a per-thread exit. A reader
 * who followed twenty posts had to find twenty different emails to leave them,
 * and the row loaded to render this page already carries the address, so the
 * rest is one indexed query.
 *
 * **A widening of what a leaked token discloses, and worth stating plainly.**
 * Before this, a forwarded digest — or a scanning gateway that keeps a copy —
 * exposed one token that could cancel one subscription. Now the page behind
 * that token also lists *which posts this address follows*, with their titles.
 * The mitigating fact is that a token only ever reaches someone who could read
 * the mailbox, and a mailbox holds the same list in the digests themselves; so
 * this discloses to a reader who already had the information by another route.
 * It is still a widening rather than a wash, which is why it is written down.
 * If it is ever judged too wide, the narrow fallback is to keep the
 * unsubscribe-all button and drop the list.
 *
 * **Rows are addressed by subscription id, never by their own token.** Routing
 * per-row actions through each row's token would scatter N unsubscribe
 * capabilities into one HTML page, so a single scraped page would hand over
 * every thread permanently rather than one page-load. The id is not a
 * capability: `POST /unsubscribe/:token/row/:id` re-checks that the id belongs
 * to the token's address.
 *
 * Returns "" when there is nothing else to show, so the single-subscription
 * case renders exactly the page it did before — an "unsubscribe from all
 * threads" button next to the only thread is noise.
 */
const manageHtml = async (
	db: D1Database,
	email: string,
	excludeId: string,
	basePath: string,
	t: Translator,
): Promise<string> => {
	const rows = (await listActiveSubscriptionsForEmail(db, email)).filter(
		(r) => r.id !== excludeId,
	);
	if (rows.length === 0) return "";

	const items = rows
		.map(
			(r) => `<li style="margin:0.5rem 0">
    <form method="post" action="${escapeHtml(basePath)}/row/${escapeHtml(r.id)}"
          style="display:flex;gap:0.75rem;align-items:baseline">
      <span style="flex:1">${escapeHtml(r.title ?? r.post_slug)}</span>
      <button type="submit" style="${BUTTON_STYLE}">
        ${escapeHtml(t("ui.subscribe.unsubscribe_row_cta"))}
      </button>
    </form>
  </li>`,
		)
		.join("");

	return `
<hr style="margin:2rem 0;border:0;border-top:1px solid #e5e7eb">
<p>${escapeHtml(t("ui.subscribe.manage_others"))}</p>
<ul style="list-style:none;padding:0;margin:0">${items}</ul>
<form method="post" action="${escapeHtml(basePath)}/all" style="margin-top:1.5rem">
  <button type="submit" style="${BUTTON_STYLE}">
    ${escapeHtml(t("ui.subscribe.unsubscribe_all_cta"))}
  </button>
</form>`;
};

export { subscriptions };
