/**
 * POST /api/v1/subscribe                { post_slug, email? }
 * GET  /api/v1/subscribe/confirm/:token
 * GET  /api/v1/subscribe/unsubscribe/:token
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
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	confirmSubscription,
	countPendingSubscriptionsForEmail,
	getPost,
	getSubscriptionByConfirmToken,
	getSubscriptionByToken,
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

	const post_slug = (body.post_slug ?? "").trim();
	if (!post_slug || post_slug.length > 200) {
		return c.json({ error: t("err.not_found") }, 400);
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

	// Idempotent by its WHERE clause, so no pre-read guard is needed: a mail
	// client's prefetch may already have confirmed the row, and the human's later
	// click still has to land on the success page.
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

	if (sub.unsubscribed_at != null) {
		return c.html(
			pageHtml(
				fillTitleHtml(t("ui.subscribe.already_unsubscribed"), postLabel),
				locale,
			),
		);
	}

	return c.html(confirmPageHtml(postLabel, locale, t));
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
	return c.html(
		pageHtml(
			fillTitleHtml(tFor(locale)("ui.subscribe.unsubscribed"), postLabel),
			locale,
		),
	);
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
const confirmPageHtml = (postLabel: string, locale: string, t: Translator): string =>
	pageHtml(
		fillTitleHtml(t("ui.subscribe.unsubscribe_confirm"), postLabel),
		locale,
		`<form method="post">
  <button type="submit" style="font:inherit;padding:0.5rem 1rem;cursor:pointer">
    ${escapeHtml(t("ui.subscribe.unsubscribe_cta"))}
  </button>
</form>
<p style="color:#6b7280;font-size:0.875rem">
  ${escapeHtml(t("ui.subscribe.unsubscribe_note"))}
</p>`,
	);

export { subscriptions };
