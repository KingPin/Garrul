/**
 * Outbound webhook dispatch — multi-endpoint, optionally signed, with a
 * D1-backed retry queue.
 *
 * Endpoints live in `webhook_endpoints` (see migration 0006). Each
 * endpoint has:
 *   - a target URL (validated by checkOutboundUrl on save),
 *   - an optional HMAC secret (signWebhookBody → X-Garrul-Signature),
 *   - an event filter (NULL/empty = all events),
 *   - an adapter that shapes the body for the destination (generic |
 *     slack | discord; slack/discord land in Feature #3).
 *
 * Dispatch flow:
 *   1. fireWebhook(c, payload) returns immediately and runs the dispatch
 *      under ctx.waitUntil. Callers don't await.
 *   2. dispatch loads the enabled endpoint list, filters by event, and
 *      attempts an immediate POST per endpoint.
 *   3. If the POST fails (network error / non-2xx), a webhook_deliveries
 *      row is queued with next_attempt_at = now + RETRY_SCHEDULE[0]. The
 *      scheduled handler in src/index.ts picks up due rows and retries
 *      them, re-signing with a fresh timestamp each time so the receiver's
 *      replay-window check still passes hours later.
 *
 * Backward compatibility:
 *   - Operators with WEBHOOK_URL set and no table rows still get
 *     deliveries — the env URL is synthesized into an in-memory endpoint
 *     (adapter=generic, secret=null, events=null=all). The env shim does
 *     NOT participate in the retry queue (no row to reference) — that's
 *     the operator's nudge to migrate to a real endpoint row if they
 *     want retries.
 *
 * Payload contract (v1, stable):
 *   {
 *     event: WebhookEvent,
 *     comment_id, post_slug, user_id: string,
 *     ts: number   // ms epoch of the EVENT, not the signature
 *   }
 *   Receivers verify with the recipe in docs/webhooks.md.
 */
import {
	enqueueWebhookDelivery,
	getWebhookEndpoint,
	incrementWebhookFailCount,
	listEnabledWebhookEndpoints,
	listPendingWebhookDeliveries,
	markWebhookDelivered,
	markWebhookFailed,
	pruneWebhookDeliveries,
	resetWebhookFailCount,
	type WebhookAdapter,
	type WebhookDelivery,
	type WebhookEndpoint,
} from "../db/queries";
import { log } from "./log";
import { checkOutboundUrl } from "./url-safety";
import {
	type AdapterOpts,
	renderDiscordBody,
	renderSlackBody,
	renderTelegramBody,
} from "./webhook-adapters";
import { signWebhookBody } from "./webhook-sig";

export type WebhookEvent =
	| "comment.posted"
	| "comment.edited"
	| "comment.deleted"
	| "comment.approved"
	| "comment.spam"
	| "comment.reported";

export type WebhookPayload = {
	event: WebhookEvent;
	comment_id: string;
	post_slug: string;
	user_id: string;
	ts: number;
};

type WebhookEnv = {
	DB: D1Database;
	WEBHOOK_URL?: string;
	ENV?: string;
	// Used by the slack/discord adapters to build "Open in admin" links.
	// Optional: a legacy operator with no PUBLIC_BASE_URL still gets
	// deliveries, just without the admin link.
	PUBLIC_BASE_URL?: string;
	// Telegram Bot API token. Required only when an endpoint uses the
	// `telegram` adapter; the chat id lives in the endpoint's `url` column.
	// Kept here (env secret) rather than in D1 so the token is never stored
	// in plaintext alongside the (non-secret) chat id.
	TELEGRAM_BOT_TOKEN?: string;
};

// Fixed, trusted Telegram Bot API host. Telegram endpoints target this URL
// (composed from the env token) rather than the endpoint's stored `url`,
// which instead holds the destination chat id.
const TELEGRAM_API_BASE = "https://api.telegram.org";

const TIMEOUT_MS = 5000;

// Cap on the rendered body we'll persist to webhook_deliveries for retry
// (issue #13). The table stores bodies verbatim so retries can re-send
// them; a chatty event filter pointed at a flapping receiver could grow
// the table inside the 30-day prune window. 64 KB is well above anything
// the adapters emit (Slack/Discord bodies truncate under 2 KB; generic is
// a small fixed-shape payload), so tripping this means something upstream
// is misbehaving — the inline POST still fires, we just skip the queue.
export const MAX_DELIVERY_BODY_BYTES = 64 * 1024;

// Exponential backoff schedule (ms). Index 0 is "first retry after the
// initial inline failure". After we've exhausted this list we mark the
// delivery 'giveup' and bump the endpoint's fail_count.
export const RETRY_SCHEDULE_MS: readonly number[] = [
	60_000,           // +1 min
	5 * 60_000,       // +5 min
	30 * 60_000,      // +30 min
	2 * 60 * 60_000,  // +2 hr
	6 * 60 * 60_000,  // +6 hr
] as const;

// After this many consecutive failures the endpoint auto-disables. The
// operator sees `disabled_at` on the admin page and can investigate +
// re-enable.
const AUTO_DISABLE_THRESHOLD = 10;

const renderGenericBody = (payload: WebhookPayload): string =>
	JSON.stringify(payload);

const renderBody = async (
	db: D1Database,
	adapter: WebhookAdapter,
	payload: WebhookPayload,
	opts: AdapterOpts,
): Promise<string> => {
	if (adapter === "slack") return renderSlackBody(db, payload, opts);
	if (adapter === "discord") return renderDiscordBody(db, payload, opts);
	if (adapter === "telegram") return renderTelegramBody(db, payload, opts);
	return renderGenericBody(payload);
};

const matchesEventFilter = (
	endpoint: WebhookEndpoint,
	event: WebhookEvent,
): boolean => endpoint.events == null || endpoint.events.includes(event);

const buildSyntheticEnvEndpoint = (url: string): WebhookEndpoint => {
	const now = Date.now();
	return {
		id: "_env",
		url,
		secret: null,
		events: null,
		adapter: "generic",
		enabled: true,
		fail_count: 0,
		disabled_at: null,
		created_at: now,
		updated_at: now,
	};
};

const buildHeaders = async (
	endpoint: WebhookEndpoint,
	body: string,
): Promise<HeadersInit> => {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": "Garrul-Webhook/2.0",
	};
	if (endpoint.secret) {
		const sig = await signWebhookBody(endpoint.secret, body);
		headers["x-garrul-signature"] = sig.header;
	}
	return headers;
};

// Resolve the actual POST target for an endpoint. Telegram endpoints store a
// chat id (not a URL) in `endpoint.url`; their real target is the fixed Bot
// API host composed from the env token. Returns null when a telegram endpoint
// can't be dispatched (no token configured) so the caller fails the delivery
// with a clear tag instead of fetching a bogus URL.
const resolveTarget = (
	env: WebhookEnv,
	endpoint: WebhookEndpoint,
): { url: string; checkUrl: boolean } | null => {
	if (endpoint.adapter === "telegram") {
		if (!env.TELEGRAM_BOT_TOKEN) return null;
		return {
			url: `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
			// Fixed, trusted host — checkOutboundUrl is for arbitrary
			// operator-supplied URLs and would also reject the api.telegram.org
			// host on no real grounds. Skip it for telegram.
			checkUrl: false,
		};
	}
	return { url: endpoint.url, checkUrl: true };
};

const postOnce = async (
	env: WebhookEnv,
	endpoint: WebhookEndpoint,
	body: string,
): Promise<{ ok: boolean; status: number; error?: string }> => {
	const target = resolveTarget(env, endpoint);
	if (!target) return { ok: false, status: 0, error: "telegram:no_token" };
	if (target.checkUrl) {
		const safe = checkOutboundUrl(target.url, {
			allowHttp: allowHttpFor(endpoint, env),
		});
		if (!safe.ok) return { ok: false, status: 0, error: `url:${safe.reason}` };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const headers = await buildHeaders(endpoint, body);
		const res = await fetch(target.url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});
		return { ok: res.ok, status: res.status };
	} catch (err) {
		return { ok: false, status: 0, error: String(err) };
	} finally {
		clearTimeout(timer);
	}
};

const isDevEnv = (env: WebhookEnv): boolean => env.ENV === "dev";

// The legacy WEBHOOK_URL env var allowed http:// in any environment.
// Table-configured endpoints go through checkOutboundUrl on save, which
// already rejects http:// outside dev — so the `_env` shim is the only
// path that needs the relaxed scheme check at dispatch time. Without
// this, operators upgrading with a prod `http://` WEBHOOK_URL silently
// stop receiving deliveries.
const allowHttpFor = (endpoint: WebhookEndpoint, env: WebhookEnv): boolean =>
	endpoint.id === "_env" || isDevEnv(env);

const dispatchToEndpoint = async (
	env: WebhookEnv,
	endpoint: WebhookEndpoint,
	payload: WebhookPayload,
): Promise<void> => {
	if (!matchesEventFilter(endpoint, payload.event)) return;
	const body = await renderBody(env.DB, endpoint.adapter, payload, {
		baseUrl: env.PUBLIC_BASE_URL,
		// Telegram stores its destination chat id in the endpoint url column.
		chatId: endpoint.adapter === "telegram" ? endpoint.url : undefined,
	});
	const result = await postOnce(env, endpoint, body);
	if (result.ok) {
		if (endpoint.id !== "_env" && endpoint.fail_count > 0) {
			await resetWebhookFailCount(env.DB, endpoint.id);
		}
		return;
	}
	const errorTag = result.error ?? `http_${result.status}`;
	const bodyBytes = new TextEncoder().encode(body).byteLength;
	log.warn("webhook.failed", {
		endpoint_id: endpoint.id,
		event: payload.event,
		comment_id: payload.comment_id,
		status: result.status,
		error: errorTag,
		body_bytes: bodyBytes,
	});
	// Synthetic env endpoint has no row to queue against — legacy fire-
	// and-forget semantics. Real endpoints get a delivery row for retry.
	if (endpoint.id === "_env") return;
	if (bodyBytes > MAX_DELIVERY_BODY_BYTES) {
		log.warn("webhook.delivery_body_too_large", {
			endpoint_id: endpoint.id,
			event: payload.event,
			comment_id: payload.comment_id,
			body_bytes: bodyBytes,
			max_bytes: MAX_DELIVERY_BODY_BYTES,
		});
		return;
	}
	await enqueueWebhookDelivery(
		env.DB,
		endpoint.id,
		payload.event,
		body,
		Date.now() + (RETRY_SCHEDULE_MS[0] ?? 60_000),
	);
};

const loadEndpoints = async (env: WebhookEnv): Promise<WebhookEndpoint[]> => {
	const rows = await listEnabledWebhookEndpoints(env.DB);
	if (env.WEBHOOK_URL && rows.length === 0) {
		// Legacy single-URL operator. Synthesize so they still get
		// deliveries during the upgrade window; admin UI will flag it.
		return [buildSyntheticEnvEndpoint(env.WEBHOOK_URL)];
	}
	return rows;
};

export const dispatchWebhook = async (
	env: WebhookEnv,
	payload: WebhookPayload,
): Promise<void> => {
	let endpoints: WebhookEndpoint[];
	try {
		endpoints = await loadEndpoints(env);
	} catch (err) {
		log.error("webhook.load_endpoints", { error: String(err) });
		return;
	}
	await Promise.all(
		endpoints.map((e) => dispatchToEndpoint(env, e, payload)),
	);
};

export const fireWebhook = (
	env: WebhookEnv,
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
	executionCtx.waitUntil(dispatchWebhook(env, payload));
};

// -------------------------- retry handler -----------------------------------

const RETRY_BATCH = 25;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000; // 30 days

const nextBackoffMs = (attempts: number): number | null => {
	// `attempts` here is the count BEFORE this run (post-increment is
	// done by markWebhookFailed). After RETRY_SCHEDULE_MS.length total
	// retries we give up.
	if (attempts >= RETRY_SCHEDULE_MS.length) return null;
	return RETRY_SCHEDULE_MS[attempts] ?? null;
};

const retryDelivery = async (
	env: WebhookEnv,
	delivery: WebhookDelivery,
): Promise<void> => {
	const endpoint = await getWebhookEndpoint(env.DB, delivery.endpoint_id);
	if (!endpoint || !endpoint.enabled) {
		// Endpoint was deleted or paused between the enqueue and this run.
		// Mark the delivery as giveup so it stops cycling and doesn't show
		// up in next_attempt_at scans forever.
		await markWebhookFailed(
			env.DB,
			delivery.id,
			null,
			endpoint ? "endpoint_disabled" : "endpoint_deleted",
		);
		return;
	}
	const result = await postOnce(env, endpoint, delivery.payload);
	if (result.ok) {
		await markWebhookDelivered(env.DB, delivery.id);
		if (endpoint.fail_count > 0) {
			await resetWebhookFailCount(env.DB, endpoint.id);
		}
		return;
	}
	const errorTag = result.error ?? `http_${result.status}`;
	const next = nextBackoffMs(delivery.attempts + 1);
	const giveup = next == null;
	await markWebhookFailed(
		env.DB,
		delivery.id,
		giveup ? null : Date.now() + next,
		errorTag,
	);
	if (giveup) {
		const newCount = endpoint.fail_count + 1;
		await incrementWebhookFailCount(
			env.DB,
			endpoint.id,
			newCount >= AUTO_DISABLE_THRESHOLD ? Date.now() : null,
		);
	}
};

export const runWebhookRetries = async (env: WebhookEnv): Promise<void> => {
	const now = Date.now();
	const due = await listPendingWebhookDeliveries(env.DB, now, RETRY_BATCH);
	if (due.length === 0) return;
	// Sequential rather than Promise.all: a single failing receiver can
	// soak up the timeout budget; running serial means one stuck endpoint
	// can't starve the others by exhausting the worker's wallclock cap.
	// 25 deliveries × 5s timeout = 125s max, well under the cron's 30s
	// CPU budget because most calls return in <1s. Adjust if real-world
	// traffic shows a long tail.
	for (const delivery of due) {
		try {
			await retryDelivery(env, delivery);
		} catch (err) {
			log.error("webhook.retry_crash", {
				delivery_id: delivery.id,
				error: String(err),
			});
		}
	}
	await pruneWebhookDeliveries(env.DB, Date.now() - PRUNE_AFTER_MS).catch(
		(err) => log.warn("webhook.prune_failed", { error: String(err) }),
	);
};
