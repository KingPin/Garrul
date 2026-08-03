/**
 * IP-hash retention sweep.
 *
 * Clears stored `ip_hash` values once their moderation value has passed, so a
 * D1 export carries a bounded window of history rather than everything the
 * instance has ever seen. Driven by `IP_HASH_RETENTION_DAYS` (0 = off) from the
 * settings chain; runs as a cron pass and on demand from `/admin/operator`.
 *
 * Two of the three places an `ip_hash` lands are swept:
 *
 *   - `comments.ip_hash` + `comments.user_agent`, anchored on the comment's
 *     last edit (`COALESCE(edited_at, created_at)`) — an edited comment is
 *     live moderation surface, so the clock restarts when it changes. Both
 *     columns go together because they're written together and cleared
 *     together everywhere else (see eraseUser in src/lib/moderation.ts).
 *
 *   - `reports.reporter_ip_hash`, anchored on `created_at`. Age-only, NOT
 *     gated on `status = 'resolved'`: an open-and-forgotten report would
 *     otherwise keep its hash forever, which is the exact "permanent" problem
 *     this exists to fix. A report older than the retention window has no live
 *     dedup value either way.
 *
 * The third — `users.provider_id` for `provider='anon'` ghosts — is
 * deliberately NOT swept, and this is the load-bearing decision in the file.
 * That column *is* the anonymous identity: the `(provider, provider_id)` UNIQUE
 * is how a returning visitor resolves to their existing ghost. Expiring it on a
 * timer would silently delete accounts rather than hashes — ghost-author bans
 * would stop applying, and vote / reaction / page-engagement dedup would reset
 * for every anonymous visitor. So an export always carries the full set of
 * ghost identities regardless of this setting, which docs/ip-hashing.md states
 * plainly. Clearing them is an operator decision (the §11 purge runbook) or a
 * per-person one (admin "Erase personal data"), never a scheduled job.
 *
 * Both UNIQUE constraints survive the sweep: SQLite counts NULLs as distinct,
 * so any number of `reports` rows for one comment can collapse to NULL without
 * tripping `UNIQUE (comment_id, reporter_ip_hash)`. The erase path already
 * relies on this (see src/db/queries.ts).
 *
 * No cursor, unlike src/db/rerender.ts. The predicate is self-draining — a
 * swept row has `ip_hash IS NULL` and stops matching its own WHERE clause — so
 * repeated identical batches make progress and eventually return 0. A cursor
 * would be dead weight and one more thing to get wrong.
 */

import type { Bindings } from "../index";
import { loadNumbers } from "../lib/settings";
import { log } from "../lib/log";

/**
 * Refuse to sweep below this many days.
 *
 * The setting's clamp can't express "0, or 7 and up" — parseIntSetting clamps
 * into [min, max], so a `min: 7` would rewrite an operator's explicit 0 ("off")
 * into the most destructive value in range. The floor lives here instead, and
 * it *refuses* rather than substituting: a fat-fingered `1` no-ops loudly
 * instead of quietly purging everything older than a day. There is no
 * legitimate reason to want a sub-week IP retention window — rate-limit buckets
 * are minutes and live in the Cache API, and the report-dedup and same-network
 * moderation signals are the only things reading these columns.
 */
export const MIN_RETENTION_DAYS = 7;

const DAY_MS = 86_400_000;

/** Rows touched per table per batch. Bounds a single cron tick's D1 writes. */
export const RETENTION_BATCH = 200;

export type RetentionSweepResult = {
	/** Comment rows whose ip_hash + user_agent were cleared. */
	comments: number;
	/** Report rows whose reporter_ip_hash was cleared. */
	reports: number;
	/** True while either table still has rows past the cutoff. */
	more: boolean;
};

export type RetentionStats = {
	/** Resolved retention window in days; 0 = disabled. */
	retention_days: number;
	/** Whether the resolved value is actually sweepable (>= MIN_RETENTION_DAYS). */
	enabled: boolean;
	/** Comment rows still holding an ip_hash or user_agent past the cutoff. */
	comments_pending: number;
	/** Report rows still holding a reporter_ip_hash past the cutoff. */
	reports_pending: number;
	/** Comment rows still holding an ip_hash at all, cutoff or not. */
	comments_total: number;
	/**
	 * Anonymous ghost rows whose provider_id is still an ip_hash. Never swept —
	 * surfaced so the operator page can be honest about what retention does not
	 * cover rather than implying the window clears everything.
	 */
	ghosts_total: number;
};

/** Epoch-ms boundary: rows at or before this are past the retention window. */
export const retentionCutoff = (retentionDays: number, now: number): number =>
	now - retentionDays * DAY_MS;

/**
 * Whether a resolved setting value should drive a sweep at all.
 *
 * Separate from the sweep so the operator page and the cron agree on what
 * "enabled" means without duplicating the comparison.
 */
export const isRetentionEnabled = (retentionDays: number): boolean =>
	retentionDays >= MIN_RETENTION_DAYS;

/**
 * Clear one batch of expired hashes. Caller supplies `now` so the cron and the
 * admin endpoint can both be tested deterministically.
 *
 * Returns zeroed counts with `more: false` when retention is off or below the
 * floor — callers don't need to pre-check, though the cron does anyway so it
 * can log the misconfiguration.
 */
export const sweepExpiredIpHashes = async (
	db: D1Database,
	retentionDays: number,
	now: number,
	batchSize: number = RETENTION_BATCH,
): Promise<RetentionSweepResult> => {
	if (!isRetentionEnabled(retentionDays)) {
		return { comments: 0, reports: 0, more: false };
	}
	const cutoff = retentionCutoff(retentionDays, now);

	// LIMIT inside a subquery rather than on the UPDATE itself: SQLite only
	// supports UPDATE ... LIMIT when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
	// which D1 does not guarantee. The subquery form is portable and behaves
	// identically here.
	const commentsRes = await db
		.prepare(
			`UPDATE comments
			    SET ip_hash = NULL, user_agent = NULL
			  WHERE id IN (
			        SELECT id FROM comments
			         WHERE (ip_hash IS NOT NULL OR user_agent IS NOT NULL)
			           AND COALESCE(edited_at, created_at) <= ?
			         ORDER BY COALESCE(edited_at, created_at) ASC
			         LIMIT ?
			  )`,
		)
		.bind(cutoff, batchSize)
		.run();

	const reportsRes = await db
		.prepare(
			`UPDATE reports
			    SET reporter_ip_hash = NULL
			  WHERE id IN (
			        SELECT id FROM reports
			         WHERE reporter_ip_hash IS NOT NULL
			           AND created_at <= ?
			         ORDER BY created_at ASC
			         LIMIT ?
			  )`,
		)
		.bind(cutoff, batchSize)
		.run();

	const comments = commentsRes.meta?.changes ?? 0;
	const reports = reportsRes.meta?.changes ?? 0;
	// A full batch on either table means there may be more behind it. Both
	// short means this pass drained everything past the cutoff.
	return {
		comments,
		reports,
		more: comments >= batchSize || reports >= batchSize,
	};
};

/**
 * Counts for the operator page. `retentionDays` is passed in already resolved
 * so this stays a pure read against D1.
 */
export const retentionStats = async (
	db: D1Database,
	retentionDays: number,
	now: number,
): Promise<RetentionStats> => {
	const cutoff = retentionCutoff(retentionDays, now);
	const enabled = isRetentionEnabled(retentionDays);

	// One round trip. The pending counts are meaningless when retention is off
	// (cutoff would be `now`, matching essentially every row and reading as a
	// pending purge that will never run), so they're forced to 0 in that case
	// while the totals stay live — the totals are what an operator deciding
	// whether to turn this on actually wants to see.
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM comments
			     WHERE (ip_hash IS NOT NULL OR user_agent IS NOT NULL)
			       AND COALESCE(edited_at, created_at) <= ?)      AS comments_pending,
			   (SELECT COUNT(*) FROM reports
			     WHERE reporter_ip_hash IS NOT NULL
			       AND created_at <= ?)                           AS reports_pending,
			   (SELECT COUNT(*) FROM comments
			     WHERE ip_hash IS NOT NULL)                      AS comments_total,
			   (SELECT COUNT(*) FROM users
			     WHERE provider = 'anon'
			       AND provider_id IS NOT NULL)                   AS ghosts_total`,
		)
		.bind(cutoff, cutoff)
		.first<{
			comments_pending: number;
			reports_pending: number;
			comments_total: number;
			ghosts_total: number;
		}>();

	return {
		retention_days: retentionDays,
		enabled,
		comments_pending: enabled ? (row?.comments_pending ?? 0) : 0,
		reports_pending: enabled ? (row?.reports_pending ?? 0) : 0,
		comments_total: row?.comments_total ?? 0,
		ghosts_total: row?.ghosts_total ?? 0,
	};
};

/**
 * Batches a single cron tick will run before giving up the rest to the next
 * tick. At RETENTION_BATCH=200 that's up to 1000 rows per table per tick and
 * ~96k/day at the default 15-minute schedule — enough to drain any backlog a
 * self-hosted instance is likely to have accumulated, while keeping one tick's
 * D1 writes and CPU time bounded. The sweep is not urgent: a row that waits one
 * more tick has already waited a week.
 */
const MAX_BATCHES_PER_TICK = 5;

/**
 * Cron pass: resolve the retention window, then sweep until drained or until
 * MAX_BATCHES_PER_TICK is spent.
 *
 * Silent when retention is off, which is the default — an instance that never
 * opted in gets no log noise every 15 minutes. Loud exactly once per tick when
 * the setting is a non-zero value below the floor, because that combination
 * means the operator asked for a sweep and is not getting one.
 */
export const runIpRetention = async (env: Bindings): Promise<void> => {
	const { ip_hash_retention_days: days } = await loadNumbers(env);
	if (days === 0) return;
	if (!isRetentionEnabled(days)) {
		log.warn("ip_retention.below_floor", {
			retention_days: days,
			min_days: MIN_RETENTION_DAYS,
		});
		return;
	}

	// One `now` for the whole tick so every batch shares a cutoff.
	const now = Date.now();
	let comments = 0;
	let reports = 0;
	let more = false;
	for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
		const res = await sweepExpiredIpHashes(env.DB, days, now);
		comments += res.comments;
		reports += res.reports;
		more = res.more;
		if (!more) break;
	}

	// Only log a tick that did something. A drained instance ticks silently.
	if (comments > 0 || reports > 0) {
		log.info("ip_retention.swept", {
			retention_days: days,
			comments,
			reports,
			more,
		});
	}
};
