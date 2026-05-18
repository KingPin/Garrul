/**
 * POST /api/v1/subscribe        { post_slug, email }
 * GET  /api/v1/unsubscribe/:token
 *
 * Subscription model:
 *   - One row per (post_slug, email). Re-subscribing the same address
 *     re-activates the row and rotates its token (the old unsubscribe
 *     link becomes inert).
 *   - Token is 32 random bytes hex-encoded. We don't sign it with
 *     JWT_SECRET because storage + lookup is just as cheap and avoids
 *     a class of "I forgot to invalidate the secret" bugs.
 *
 * No double-opt-in for v1. The email address is collected at the moment
 * the user posts a comment (or ticks a box on the form) so deliverability
 * spam complaints are bounded — we never email people who didn't ask.
 * If self-hosters want strict double-opt-in later it goes here.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	getPost,
	getSubscriptionByToken,
	markSubscriptionUnsubscribed,
	upsertSubscription,
} from "../db/queries";
import { t } from "../i18n";

const subscriptions = new Hono<{ Bindings: Bindings }>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const randomToken = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

subscriptions.post("/", async (c) => {
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

	// We don't require the post to exist (a comment may not have arrived
	// yet on this slug) but we DO accept the subscription either way.
	// If the slug is wholly unknown later, no notifications will fire.
	const token = randomToken();
	const sub = await upsertSubscription(c.env.DB, post_slug, email, token);

	return c.json({ ok: true, subscription_id: sub.id });
});

subscriptions.get("/unsubscribe/:token", async (c) => {
	const token = c.req.param("token");
	if (!token) return c.text("missing token", 400);

	const sub = await getSubscriptionByToken(c.env.DB, token);
	if (!sub) {
		return c.html(unsubscribeHtml("Link expired or already used."));
	}

	if (sub.unsubscribed_at == null) {
		await markSubscriptionUnsubscribed(c.env.DB, sub.id);
	}

	const post = await getPost(c.env.DB, sub.post_slug);
	const postLabel = post?.title ?? sub.post_slug;
	return c.html(
		unsubscribeHtml(
			`You're unsubscribed from comment notifications for "${escape(postLabel)}".`,
		),
	);
});

const escape = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const unsubscribeHtml = (message: string): string => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Unsubscribed — Garrul</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         max-width: 440px; margin: 4rem auto; padding: 0 1rem;
         line-height: 1.55; }
  h1 { margin-top: 0; font-size: 1.2rem; }
</style>
</head>
<body>
<h1>Unsubscribed</h1>
<p>${message}</p>
</body>
</html>`;

export { subscriptions };
