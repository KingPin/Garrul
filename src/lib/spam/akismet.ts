/**
 * Akismet content classifier.
 *
 * Privacy note: this sends `body_md`, the author's display name, and the
 * post URL to Automattic. We deliberately do NOT forward the raw client IP
 * or the hashed IP — Akismet can't do anything useful with a Garrul-specific
 * HMAC, and shipping the raw IP would break the project's privacy posture
 * (see src/lib/ip-hash.ts). Operators who enable Akismet must disclose this
 * in their privacy policy; the template at docs/privacy-policy.template.md
 * has a stub for it.
 *
 * API: https://akismet.com/developers/comment-check/
 * Endpoint: POST https://{api-key}.rest.akismet.com/1.1/comment-check
 * Body: application/x-www-form-urlencoded
 * Response: "true" (spam) or "false" (ham). An "X-akismet-pro-tip: discard"
 * header marks high-confidence "blatant spam" that's safe to silently drop —
 * we still flag to `pending` rather than dropping, but it's recorded.
 */

import type { SpamCheckInput, SpamVerdict } from "./index";

type AkismetConfig = {
	apiKey: string;
	siteUrl: string;
};

export const checkAkismet = async (
	cfg: AkismetConfig,
	input: SpamCheckInput,
): Promise<SpamVerdict | null> => {
	const form = new URLSearchParams();
	form.set("blog", cfg.siteUrl);
	form.set("comment_type", "comment");
	form.set("comment_author", input.author_name);
	if (input.author_email) form.set("comment_author_email", input.author_email);
	form.set("comment_content", input.body_md);
	if (input.post_url) form.set("permalink", input.post_url);
	if (input.user_agent) form.set("user_agent", input.user_agent);
	// Akismet expects user_ip; we don't send the real IP for privacy reasons,
	// but a missing value makes the call less accurate. Send 127.0.0.1 as a
	// neutral placeholder so the request passes Akismet's required-fields
	// check; the model is robust to a uniform constant.
	form.set("user_ip", "127.0.0.1");
	if (input.is_first_comment) form.set("is_test", "0");

	try {
		const res = await fetch(
			`https://${cfg.apiKey}.rest.akismet.com/1.1/comment-check`,
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form.toString(),
			},
		);
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.error(
				JSON.stringify({
					level: "warn",
					msg: "spam.adapter.error",
					provider: "akismet",
					status: res.status,
					body: body.slice(0, 200),
				}),
			);
			return null;
		}
		const text = (await res.text()).trim().toLowerCase();
		const proTip = res.headers.get("x-akismet-pro-tip");
		if (text === "true") {
			return {
				spam: true,
				reason: proTip === "discard" ? "akismet.discard" : "akismet.spam",
			};
		}
		if (text === "false") return { spam: false };
		console.error(
			JSON.stringify({
				level: "warn",
				msg: "spam.adapter.error",
				provider: "akismet",
				unexpected_body: text.slice(0, 60),
			}),
		);
		return null;
	} catch (err) {
		console.error(
			JSON.stringify({
				level: "warn",
				msg: "spam.adapter.error",
				provider: "akismet",
				error: String(err),
			}),
		);
		return null;
	}
};
