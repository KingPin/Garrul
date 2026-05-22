/**
 * Outbound webhook for comment events.
 *
 * Operators set WEBHOOK_URL to a private endpoint (Slack incoming webhook,
 * Discord, custom audit log, etc.) and receive a JSON POST whenever a
 * comment is created, edited, deleted, or moderated.
 *
 * Behavior:
 *   - Best-effort. A failed POST is logged via src/lib/log.ts and the
 *     user request completes regardless.
 *   - Callers MUST pass `c.executionCtx` so we can attach the POST to
 *     `waitUntil` — without it, the runtime can cancel the in-flight
 *     fetch once the response settles and the webhook is silently lost.
 *   - HMAC signing is intentionally deferred (v2 backlog). Operators who
 *     need it should put a reverse-proxy in front that adds the sig.
 *
 * Payload shape (stable v1 contract):
 *   {
 *     event: "comment.posted" | "comment.edited" | "comment.deleted"
 *          | "comment.approved" | "comment.spam",
 *     comment_id: string,
 *     post_slug: string,
 *     user_id: string,
 *     ts: number          // ms epoch
 *   }
 */
import { log } from "./log";

export type WebhookEvent =
	| "comment.posted"
	| "comment.edited"
	| "comment.deleted"
	| "comment.approved"
	| "comment.spam";

export type WebhookPayload = {
	event: WebhookEvent;
	comment_id: string;
	post_slug: string;
	user_id: string;
	ts: number;
};

type WebhookCtx = {
	WEBHOOK_URL?: string;
};

const TIMEOUT_MS = 5000;

export const sendWebhook = async (
	env: WebhookCtx,
	payload: WebhookPayload,
): Promise<void> => {
	const url = env.WEBHOOK_URL;
	if (!url) return;
	if (!/^https?:\/\//i.test(url)) return;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "Garrul-Webhook/1.0",
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) {
			log.warn("webhook.non_ok", {
				event: payload.event,
				comment_id: payload.comment_id,
				status: res.status,
			});
		}
	} catch (err) {
		log.warn("webhook.failed", {
			event: payload.event,
			comment_id: payload.comment_id,
			error: String(err),
		});
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Fire-and-forget convenience. `executionCtx` is required: every HTTP
 * request handler in this worker already has `c.executionCtx`, and
 * without `waitUntil` the runtime can cancel the in-flight POST once
 * the response settles. If a caller genuinely has no context, log and
 * skip — better a missed webhook than a misleading "delivered" status.
 */
export const fireWebhook = (
	env: WebhookCtx,
	executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined,
	payload: WebhookPayload,
): void => {
	if (!executionCtx) {
		log.warn("webhook.skipped_no_ctx", {
			event: payload.event,
			comment_id: payload.comment_id,
		});
		return;
	}
	executionCtx.waitUntil(sendWebhook(env, payload));
};
