/**
 * POST /api/v1/subscribe                { post_slug, email }
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
 *   - Fast path: when a logged-in user submits their own email AND the
 *     session user is provider-verified (github/google), we auto-confirm.
 *     The user already proved control of the inbox to the provider, so a
 *     second loop adds friction without security.
 *   - A per-email pending cap (5) prevents amplifying the confirmation
 *     email itself into a mailbomb — without it an attacker could forge
 *     5 confirm-emails per minute per IP without consuming any of them.
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
import { requireIpHash } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { renderConfirmEmailHtml } from "../lib/digest";
import { sendEmail } from "../lib/email";
import { fillSubject, subjectTitle } from "../lib/post-title";
import { readSession } from "../lib/session";
import { t } from "../i18n";

const subscriptions = new Hono<{ Bindings: Bindings }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PENDING_PER_EMAIL_CAP = 5;
const PROVIDER_VERIFIED = new Set(["github", "google"]);

const randomToken = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

subscriptions.post("/", async (c) => {
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
	const email = (body.email ?? "").trim().toLowerCase();
	if (!post_slug || post_slug.length > 200) {
		return c.json({ error: t("err.not_found") }, 400);
	}
	if (!EMAIL_RE.test(email) || email.length > 320) {
		return c.json({ error: "invalid_email" }, 400);
	}

	// Fast-path auto-confirm: logged-in user submitting their own
	// provider-verified email. Provider already vouched for inbox control.
	let autoConfirm = false;
	const session = await readSession(c);
	if (session) {
		// requireActiveUser, not getUser: a banned user must not get the
		// skip-the-confirmation-email fast path, and shouldn't be subscribing
		// under their account at all.
		const user = await requireActiveUser(c.env.DB, session.user_id);
		if (!user) return c.json({ error: t("err.banned") }, 403);
		if (
			user.email &&
			user.email.toLowerCase() === email &&
			PROVIDER_VERIFIED.has(user.provider)
		) {
			autoConfirm = true;
		}
	}

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

	const unsubscribeToken = randomToken();
	const confirm_token = autoConfirm ? null : randomToken();
	const sub = await upsertSubscription(
		c.env.DB,
		post_slug,
		email,
		unsubscribeToken,
		confirm_token,
		autoConfirm,
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
		});
		await sendEmail(c.env, {
			to: email,
			from,
			subject: fillSubject(t("email.confirm.subject"), title),
			html,
		});
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
		return c.html(pageHtml("Link expired or already used."));
	}

	// Idempotent by its WHERE clause, so no pre-read guard is needed: a mail
	// client's prefetch may already have confirmed the row, and the human's later
	// click still has to land on the success page.
	await confirmSubscription(c.env.DB, sub.id);

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	return c.html(
		pageHtml(
			`You're confirmed for comment notifications on "${escapeHtml(postLabel)}".`,
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
		return c.html(pageHtml("Link expired or already used."));
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = escapeHtml(post?.title ?? sub.post_slug);

	if (sub.unsubscribed_at != null) {
		return c.html(
			pageHtml(
				`You're already unsubscribed from comment notifications for "${postLabel}".`,
			),
		);
	}

	return c.html(confirmPageHtml(postLabel));
});

subscriptions.post("/unsubscribe/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		return c.html(pageHtml("Link expired or already used."));
	}

	if (sub.unsubscribed_at == null) {
		await markSubscriptionUnsubscribed(c.env.DB, sub.id);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	return c.html(
		pageHtml(
			`You're unsubscribed from comment notifications for "${escapeHtml(postLabel)}".`,
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

const pageHtml = (message: string, extra = ""): string => `
<!doctype html>
<html lang="en">
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
 * `postLabel` arrives already escaped — it is interpolated as text here.
 */
const confirmPageHtml = (postLabel: string): string =>
	pageHtml(
		`Unsubscribe from comment notifications for "${postLabel}"?`,
		`<form method="post">
  <button type="submit" style="font:inherit;padding:0.5rem 1rem;cursor:pointer">
    Yes, unsubscribe me
  </button>
</form>
<p style="color:#6b7280;font-size:0.875rem">
  Nothing has changed yet — you stay subscribed until you confirm.
</p>`,
	);

export { subscriptions };
