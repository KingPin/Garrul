/**
 * POST /api/v1/subscribe                { post_slug, email }
 * GET  /api/v1/subscribe/confirm/:token
 * GET  /api/v1/subscribe/unsubscribe/:token
 *
 * Subscription model:
 *   - One row per (post_slug, email). Re-subscribing the same address
 *     re-activates the row and rotates its unsubscribe token (the old
 *     unsubscribe link becomes inert).
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
	getUser,
	markSubscriptionUnsubscribed,
	upsertSubscription,
} from "../db/queries";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { renderConfirmEmailHtml } from "../lib/digest";
import { sendEmail } from "../lib/email";
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
	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash);
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
		const user = await getUser(c.env.DB, session.user_id);
		if (
			user &&
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
	if (!autoConfirm && sub.confirmed_at == null && sub.confirm_token) {
		const post = await getPost(c.env.DB, post_slug);
		const publicBase = c.env.PUBLIC_BASE_URL;
		const from = c.env.EMAIL_FROM;
		if (publicBase && from) {
			const confirmUrl = `${publicBase}/api/v1/subscribe/confirm/${sub.confirm_token}`;
			const html = renderConfirmEmailHtml({
				postTitle: post?.title ?? post_slug,
				confirmUrl,
			});
			await sendEmail(c.env, {
				to: email,
				from,
				subject: t("email.confirm.subject").replace(
					"{title}",
					post?.title ?? post_slug,
				),
				html,
			});
		}
	}

	return c.json({
		ok: true,
		subscription_id: sub.id,
		status: sub.confirmed_at != null ? "confirmed" : "pending",
		message:
			sub.confirmed_at != null
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

	if (sub.confirmed_at == null) {
		await confirmSubscription(c.env.DB, sub.id);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	return c.html(
		pageHtml(
			`You're confirmed for comment notifications on "${escape(postLabel)}".`,
		),
	);
});

subscriptions.get("/unsubscribe/:token", async (c) => {
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
			`You're unsubscribed from comment notifications for "${escape(postLabel)}".`,
		),
	);
});

const escape = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const pageHtml = (message: string): string => `
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
</body>
</html>`;

export { subscriptions };
