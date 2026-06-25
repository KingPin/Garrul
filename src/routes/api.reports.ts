/**
 * /api/v1/comments/:id/report — reader-facing comment reporting.
 *
 *   POST /api/v1/comments/:id/report   { reason? }
 *
 * Low-friction by design: anonymous reports are allowed and there is NO
 * Turnstile challenge (a challenge on a one-tap "report" is overkill and
 * hurts adoption). Abuse is bounded three ways instead:
 *   - the shared per-IP-hash rate-limit bucket (same as commenting);
 *   - a UNIQUE(comment_id, reporter_ip_hash) dedup — a second report from the
 *     same network is a silent no-op (INSERT OR IGNORE in insertReport);
 *   - report counts are operator-only (never in the public payload) so there
 *     is no brigading signal to chase.
 *
 * The response is always { ok: true } whether the report is new or a
 * duplicate, so a caller can't probe whether they (or anyone) already
 * reported a given comment.
 *
 * State change ⇒ this goes through the global Origin/CSRF middleware mounted
 * on /api/* (see src/index.ts). IP is only ever stored hashed (ip-hash.ts).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getComment, insertReport } from "../db/queries";
import { clientIp, hashIp } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { fireWebhook } from "../lib/webhook";
import { t } from "../i18n";

const reports = new Hono<{ Bindings: Bindings }>();

// Reason is a free-text hint from the reporter. Stored as plain text and
// escaped on admin render; capped so a report can't be used as a storage
// amplification vector.
const REASON_MAX = 300;

reports.post("/:id/report", async (c) => {
	const id = c.req.param("id");

	// Optional reason. A malformed/absent body is fine — reason just stays null.
	const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
	let reason: string | null = null;
	if (body && typeof body.reason === "string") {
		const trimmed = body.reason.trim().slice(0, REASON_MAX);
		reason = trimmed.length > 0 ? trimmed : null;
	}

	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);
	const rl = await checkRateLimit(c.env, ipHash);
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: null,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	// Resolve the target. A missing comment returns the same {ok:true} as a
	// success so the endpoint can't be used to enumerate comment ids. An
	// already-deleted comment is treated the same way: nothing to moderate, so
	// don't let a crafted POST open a report on a dead comment (the widget
	// already hides the button for deleted ones — this is the server guard).
	const target = await getComment(c.env.DB, id);
	if (!target || target.status === "deleted") return c.json({ ok: true });

	const session = await readSession(c);
	const isNew = await insertReport(c.env.DB, {
		comment_id: id,
		reporter_user_id: session?.user_id ?? null,
		reporter_ip_hash: ipHash,
		reason,
	});

	// Only ping operators / count analytics on a genuinely new report — a
	// duplicate is a no-op and shouldn't re-fire the webhook.
	if (isNew) {
		writeEvent(c.env.ANALYTICS, "comment.reported", {
			post_slug: target.post_slug,
			outcome: null,
		});
		fireWebhook(c.env, c.executionCtx, {
			event: "comment.reported",
			comment_id: id,
			post_slug: target.post_slug,
			user_id: target.user_id,
			ts: Date.now(),
		});
	}

	return c.json({ ok: true });
});

export { reports };
