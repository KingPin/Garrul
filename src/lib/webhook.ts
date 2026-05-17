/**
 * Outbound webhook for comment events.
 *
 * Operators set WEBHOOK_URL to a private endpoint (Slack incoming webhook,
 * Discord, custom audit log, etc.) and receive a JSON POST whenever a
 * comment is created, edited, deleted, or moderated.
 *
 * Behavior:
 *   - Best-effort. A failed POST is logged and dropped; the user request
 *     completes regardless.
 *   - Use `ctx.waitUntil(...)` if available so the request handler can
 *     return while the POST is still in flight. We don't require the
 *     ExecutionContext to be passed in (most call sites don't have it),
 *     so the fallback is "fire the promise and let the worker keep it
 *     alive."
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
			console.error(
				JSON.stringify({
					level: "warn",
					msg: "webhook.non_ok",
					event: payload.event,
					comment_id: payload.comment_id,
					status: res.status,
				}),
			);
		}
	} catch (err) {
		console.error(
			JSON.stringify({
				level: "warn",
				msg: "webhook.failed",
				event: payload.event,
				comment_id: payload.comment_id,
				error: String(err),
			}),
		);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Fire-and-forget convenience. Callers that have an ExecutionContext
 * should pass it so the worker keeps the request alive past response
 * send; without one, the promise is started but the runtime may drop it
 * if the request settles first.
 */
export const fireWebhook = (
	env: WebhookCtx,
	executionCtx: { waitUntil(p: Promise<unknown>): void } | undefined,
	payload: WebhookPayload,
): void => {
	const p = sendWebhook(env, payload);
	if (executionCtx) executionCtx.waitUntil(p);
};
