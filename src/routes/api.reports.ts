/**
 * /api/v1/comments/:id/report — reader-facing comment reporting.
 *
 *   POST /api/v1/comments/:id/report   { reason? }
 *
 * Low-friction by design: anonymous reports are allowed and there is NO
 * Turnstile challenge (a challenge on a one-tap "report" is overkill and
 * hurts adoption). Abuse is bounded four ways instead:
 *   - a banned identity — session user *or* ip_hash ghost — is refused 403;
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
import {
	enqueueModeratorNotification,
	getComment,
	insertReport,
} from "../db/queries";
import { loadFlags } from "../lib/settings";
import { requireIpHash } from "../lib/ip-hash";
import { checkRateLimit } from "../lib/ratelimit";
import { isInactiveGhost, requireActiveUser } from "../lib/active-user";
import { readSession } from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { fireWebhook } from "../lib/webhook";
import { FALLBACK_LOCALE, tFor } from "../i18n";
import type { LocaleVars } from "../lib/locale";

const reports = new Hono<{ Bindings: Bindings; Variables: LocaleVars }>();

// Reason is a free-text hint from the reporter. Stored as plain text and
// escaped on admin render; capped so a report can't be used as a storage
// amplification vector.
const REASON_MAX = 300;

reports.post("/:id/report", async (c) => {
	// Shadows the module-level English `t` for the whole handler; the widget
	// renders `json.error` verbatim, so this is what makes the error match the
	// language the rest of the widget is in.
	const t = c.get("t") ?? tFor(FALLBACK_LOCALE);
	const id = c.req.param("id");

	// Optional reason. A malformed/absent body is fine — reason just stays null.
	const body = await c.req.json<{ reason?: unknown }>().catch(() => null);
	let reason: string | null = null;
	if (body && typeof body.reason === "string") {
		const trimmed = body.reason.trim().slice(0, REASON_MAX);
		reason = trimmed.length > 0 ? trimmed : null;
	}

	const ipHash = await requireIpHash(c);
	if (ipHash instanceof Response) return ipHash;
	const rl = await checkRateLimit(c.req.url, ipHash, {
		scope: "report",
		env: c.env,
	});
	if (!rl.ok) {
		writeEvent(c.env.ANALYTICS, "ratelimit.hit", {
			outcome: rl.reason ?? null,
			post_slug: null,
		});
		return c.json({ error: t("err.ratelimit") }, 429);
	}

	// A banned user doesn't get to file reports: the queue is a moderator's
	// inbox, and an unchecked ban leaves it usable for harassment.
	//
	// Both identities, because reporting takes either. Gating only the session
	// left the anonymous half open — an operator bans an abusive anonymous
	// author by banning their ghost row (provider='anon', provider_id=ip_hash),
	// and that ip_hash could still file a report from the same browser by
	// signing out or never signing in. `isInactiveGhost` is the read-only lookup:
	// this route deliberately never creates a ghost (reporter_user_id stays NULL
	// and the dedup keys on the ip_hash), and a check has no business minting a
	// user row on an unauthenticated path.
	//
	// Ahead of the target lookup, not after it. The other order gave a banned
	// caller the enumeration oracle the {ok:true} below exists to deny: 403 for a
	// comment that exists, {ok:true} for one that doesn't. Refusing before
	// anything is resolved makes the response identical either way.
	const session = await readSession(c);
	if (session) {
		if (!(await requireActiveUser(c.env.DB, session.user_id))) {
			return c.json({ error: t("err.banned") }, 403);
		}
	} else if (await isInactiveGhost(c.env.DB, ipHash)) {
		return c.json({ error: t("err.banned") }, 403);
	}

	// Resolve the target. A missing comment returns the same {ok:true} as a
	// success so the endpoint can't be used to enumerate comment ids. An
	// already-deleted comment is treated the same way: nothing to moderate, so
	// don't let a crafted POST open a report on a dead comment (the widget
	// already hides the button for deleted ones — this is the server guard).
	const target = await getComment(c.env.DB, id);
	if (!target || target.status === "deleted") return c.json({ ok: true });

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
		// Inside the isNew branch on purpose: a duplicate report is a no-op
		// everywhere else here, and a second email about a comment the moderator
		// has already been told about is exactly the noise that gets moderator
		// mail filtered away. The queue row is deduped a second time in the
		// database (partial UNIQUE on comment_id + reason, migration 0021), which
		// is what actually bounds a brigade — `isNew` is per reporting network.
		if ((await loadFlags(c.env)).moderator_email_enabled) {
			const notify = enqueueModeratorNotification(c.env.DB, id, "reported");
			if (c.executionCtx) c.executionCtx.waitUntil(notify);
			else await notify;
		}
	}

	return c.json({ ok: true });
});

export { reports };
