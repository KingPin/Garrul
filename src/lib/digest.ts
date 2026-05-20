/**
 * Notification digest job.
 *
 * Runs from the worker's `scheduled` export (see src/index.ts). Each
 * tick:
 *   1. Find pending notifications older than DEBOUNCE_MS (5 min) so a
 *      thread burst coalesces.
 *   2. Group by subscription → one digest per subscriber.
 *   3. Render the digest HTML, send via Resend.
 *   4. Mark the digest's notification_ids as sent_at = now.
 *
 * If sending fails for a digest, the notification rows stay pending and
 * we'll retry on the next cron tick. We process up to MAX_DIGESTS_PER_TICK
 * subscribers per run so a backlog doesn't blow past the 30-second
 * scheduled-handler budget.
 *
 * The digest email is plain-HTML with text-only fallback. Each comment
 * line is a permalink to /c/<id> which redirects to the post page anchor.
 */
import {
	getCommentsByIds,
	getPost,
	getUsersByIds,
	listPendingDigests,
	markNotificationsSent,
	updateSubscriptionLastNotified,
} from "../db/queries";
import { sendEmail } from "./email";
import { sanitizeForEmail } from "./markdown";

type DigestEnv = {
	DB: D1Database;
	EMAIL_PROVIDER?: string;
	RESEND_API_KEY?: string;
	EMAIL_FROM?: string;
	PUBLIC_BASE_URL?: string;
};

const DEBOUNCE_MS = 5 * 60 * 1000;
const MAX_DIGESTS_PER_TICK = 50;

const escape = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
};

export const renderConfirmEmailHtml = (params: {
	postTitle: string;
	confirmUrl: string;
}): string => {
	return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111827;">
<h1 style="font-size:18px;margin:0 0 12px;">Confirm your subscription</h1>
<p>You're being asked to confirm a subscription to reply notifications for
<strong>${escape(params.postTitle)}</strong>.</p>
<p>If this wasn't you, ignore this email — without the confirmation click
below, no further messages will be sent to this address for this thread.</p>
<p style="margin-top:20px;"><a href="${params.confirmUrl}"
   style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;
   text-decoration:none;display:inline-block;">Confirm subscription</a></p>
<p style="margin-top:20px;font-size:12px;color:#6b7280;">Or paste this link
into your browser:<br>${escape(params.confirmUrl)}</p>
</body></html>`;
};

const renderDigestHtml = (params: {
	postTitle: string;
	publicBase: string;
	unsubscribeUrl: string;
	items: { author: string; commentId: string; html: string; createdAt: number }[];
}): string => {
	const rows = params.items
		.map(
			(it) => `
<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb;">
  <div style="font-size:13px;color:#6b7280;">
    ${escape(it.author)} · <a href="${params.publicBase}/c/${it.commentId}">permalink</a>
  </div>
  <div style="margin-top:6px;font-size:14px;color:#111827;">${it.html}</div>
</td></tr>`,
		)
		.join("");
	const count = params.items.length;
	return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;padding:24px;color:#111827;">
<h1 style="font-size:18px;margin:0 0 12px;">${count} new comment${count === 1 ? "" : "s"} on "${escape(params.postTitle)}"</h1>
<table style="width:100%;border-collapse:collapse;">${rows}</table>
<p style="margin-top:24px;font-size:12px;color:#6b7280;">
  <a href="${params.unsubscribeUrl}" style="color:#6b7280;">Unsubscribe from this thread</a>
</p>
</body></html>`;
};

export const runDigest = async (env: DigestEnv, now: number = Date.now()): Promise<void> => {
	if (env.EMAIL_PROVIDER !== "resend" || !env.RESEND_API_KEY) return;
	const from = env.EMAIL_FROM;
	const publicBase = env.PUBLIC_BASE_URL;
	if (!from || !publicBase) return;

	const digests = await listPendingDigests(
		env.DB,
		now - DEBOUNCE_MS,
		MAX_DIGESTS_PER_TICK,
	);
	if (digests.length === 0) return;

	for (const d of digests) {
		const post = await getPost(env.DB, d.post_slug);
		// Batch the per-digest lookups: one query for all comments referenced
		// by this digest, then one for all unique authors. Avoids N+1 inside
		// the per-subscriber loop on a busy thread.
		const commentsById = await getCommentsByIds(env.DB, d.comment_ids);
		const userIds = Array.from(
			new Set(
				d.comment_ids
					.map((cid) => commentsById.get(cid))
					.filter((c): c is NonNullable<typeof c> => c != null && c.status === "approved")
					.map((c) => c.user_id),
			),
		);
		const usersById = await getUsersByIds(env.DB, userIds);
		const items: { author: string; commentId: string; html: string; createdAt: number }[] = [];
		for (const cid of d.comment_ids) {
			const comment = commentsById.get(cid);
			if (!comment || comment.status !== "approved") continue;
			const author = usersById.get(comment.user_id);
			items.push({
				author: author?.name ?? "Anonymous",
				commentId: comment.id,
				// Re-sanitize for email: stored body_html is already sanitized for
				// browser rendering, but email clients have a different threat
				// model (some strip scripts, others execute attribute handlers).
				// Strip everything except inline text formatting + safe anchors.
				html: sanitizeForEmail(comment.body_html),
				createdAt: comment.created_at,
			});
		}
		if (items.length === 0) {
			// Every comment was moderated/deleted in the debounce window;
			// just clear the rows so we don't retry forever.
			await markNotificationsSent(env.DB, d.notification_ids);
			await updateSubscriptionLastNotified(env.DB, d.subscription_id);
			continue;
		}

		const unsubscribeUrl = `${publicBase}/api/v1/subscribe/unsubscribe/${d.token}`;
		const html = renderDigestHtml({
			postTitle: post?.title ?? d.post_slug,
			publicBase,
			unsubscribeUrl,
			items,
		});

		const ok = await sendEmail(env, {
			to: d.email,
			from,
			subject: `New replies on "${post?.title ?? d.post_slug}"`,
			html,
		});

		if (ok) {
			await markNotificationsSent(env.DB, d.notification_ids);
			await updateSubscriptionLastNotified(env.DB, d.subscription_id);
		}
		// On send failure, leave rows pending — the next tick retries.
	}
};
