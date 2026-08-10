/**
 * Audit-log retention sweep.
 *
 * `audit_log` is the one table that only ever grew: every route INSERTs, the
 * admin pages SELECT, and nothing deleted. That makes it the longest-lived
 * record of who did what — valuable operationally, and awkward under a data
 * -protection review, because "we keep moderation records forever" is a
 * retention period an operator has to justify rather than a design decision
 * they made. This gives them a dial.
 *
 * Deliberately a hard DELETE, not the null-the-column shape of
 * ip-retention.ts. An audit row is *entirely* a record of an administrative
 * act — there is no non-personal remainder worth keeping once the retention
 * period expires, and a row stripped down to `action` + `created_at` would be
 * an audit trail that no longer identifies the actor, which is worse than no
 * row at all: it reads as evidence while proving nothing.
 *
 * The rows are anchored on `created_at` only. There is no notion of an "open"
 * audit row to exempt — unlike a report, an audit entry is a completed fact the
 * moment it is written.
 *
 * Like the IP sweep, this needs no cursor: a deleted row stops matching its own
 * WHERE clause, so repeated identical batches make progress and eventually
 * return 0.
 *
 * What this does NOT do is make erasure complete. Erasing a user does not
 * reach their audit history, and this sweep only bounds how long that history
 * lives. The reason that is acceptable is the companion change that stopped
 * `audit_log.meta` carrying personal data in the first place (subscriber
 * emails, display names) — see docs/compliance/data-inventory.md. What remains
 * in an audit row about a data subject is their opaque user id in `target_id`
 * plus whatever a moderator typed into `reason`.
 */

import type { Bindings } from "../index";
import { loadNumbers } from "../lib/settings";
import { log } from "../lib/log";

/**
 * Refuse to sweep below this many days.
 *
 * Higher than the IP sweep's 7-day floor, and for a different reason. A hashed
 * IP has a short operational half-life — it answers "is this the same network
 * as that ban evader" for about as long as the evasion is live. A moderation
 * record answers "why is this user banned" and "did we already handle this
 * report", questions that recur across months. 30 days is the smallest window
 * where the audit log still functions as an audit log.
 *
 * Refuses rather than substituting, for the same reason as MIN_RETENTION_DAYS:
 * the setting's clamp cannot express "0, or 30 and up" without rewriting an
 * operator's explicit 0 ("keep forever") into the most destructive value in
 * range.
 */
export const MIN_AUDIT_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/** Rows deleted per batch. Bounds a single cron tick's D1 writes. */
export const AUDIT_RETENTION_BATCH = 200;

export type AuditSweepResult = {
	/** Audit rows deleted. */
	deleted: number;
	/** True while rows past the cutoff may remain. */
	more: boolean;
};

export type AuditRetentionStats = {
	/** Resolved retention window in days; 0 = disabled. */
	retention_days: number;
	/** Whether the resolved value is actually sweepable. */
	enabled: boolean;
	/** Audit rows past the cutoff right now. */
	pending: number;
	/** Audit rows in total, cutoff or not. */
	total: number;
	/** Epoch-ms of the oldest surviving row, or null when the table is empty. */
	oldest: number | null;
};

/** Epoch-ms boundary: rows at or before this are past the retention window. */
export const auditRetentionCutoff = (
	retentionDays: number,
	now: number,
): number => now - retentionDays * DAY_MS;

export const isAuditRetentionEnabled = (retentionDays: number): boolean =>
	retentionDays >= MIN_AUDIT_RETENTION_DAYS;

/**
 * Delete one batch of expired audit rows. Caller supplies `now` so the cron and
 * the admin endpoint can both be tested deterministically.
 *
 * Returns a zeroed result when retention is off or below the floor — callers
 * don't need to pre-check, though the cron does anyway so it can log the
 * misconfiguration.
 */
export const pruneAuditLog = async (
	db: D1Database,
	retentionDays: number,
	now: number,
	batchSize: number = AUDIT_RETENTION_BATCH,
): Promise<AuditSweepResult> => {
	if (!isAuditRetentionEnabled(retentionDays)) return { deleted: 0, more: false };
	const cutoff = auditRetentionCutoff(retentionDays, now);

	// LIMIT inside a subquery rather than on the DELETE itself: SQLite only
	// supports DELETE ... LIMIT when compiled with
	// SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which D1 does not guarantee.
	const res = await db
		.prepare(
			`DELETE FROM audit_log
			  WHERE id IN (
			        SELECT id FROM audit_log
			         WHERE created_at <= ?
			         ORDER BY created_at ASC
			         LIMIT ?
			  )`,
		)
		.bind(cutoff, batchSize)
		.run();

	const deleted = res.meta?.changes ?? 0;
	return { deleted, more: deleted >= batchSize };
};

/**
 * Counts for the operator page. `retentionDays` is passed in already resolved so
 * this stays a pure read against D1.
 */
export const auditRetentionStats = async (
	db: D1Database,
	retentionDays: number,
	now: number,
): Promise<AuditRetentionStats> => {
	const enabled = isAuditRetentionEnabled(retentionDays);
	const cutoff = auditRetentionCutoff(retentionDays, now);

	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM audit_log WHERE created_at <= ?) AS pending,
			   (SELECT COUNT(*) FROM audit_log)                      AS total,
			   (SELECT MIN(created_at) FROM audit_log)               AS oldest`,
		)
		.bind(cutoff)
		.first<{ pending: number; total: number; oldest: number | null }>();

	return {
		retention_days: retentionDays,
		enabled,
		// With retention off the cutoff is `now`, so `pending` would count nearly
		// every row and read as a pending purge that will never run. The total and
		// the oldest timestamp stay live — those are what an operator deciding
		// whether to turn this on actually wants to see.
		pending: enabled ? (row?.pending ?? 0) : 0,
		total: row?.total ?? 0,
		oldest: row?.oldest ?? null,
	};
};

/**
 * Batches a single cron tick will run before leaving the rest to the next tick.
 * Same reasoning as the IP sweep: bound one tick's D1 writes, and accept that a
 * row waiting one more tick has already waited a month.
 */
const MAX_BATCHES_PER_TICK = 5;

/**
 * Cron pass: resolve the window, then prune until drained or until
 * MAX_BATCHES_PER_TICK is spent.
 *
 * Silent when retention is off, which is the default. Loud exactly once per
 * tick when the setting is non-zero but below the floor, because that means the
 * operator asked for a sweep and is not getting one.
 */
export const runAuditRetention = async (env: Bindings): Promise<void> => {
	const { audit_log_retention_days: days } = await loadNumbers(env);
	if (days === 0) return;
	if (!isAuditRetentionEnabled(days)) {
		log.warn("audit_retention.below_floor", {
			retention_days: days,
			min_days: MIN_AUDIT_RETENTION_DAYS,
		});
		return;
	}

	// One `now` for the whole tick so every batch shares a cutoff.
	const now = Date.now();
	let deleted = 0;
	let more = false;
	for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
		const res = await pruneAuditLog(env.DB, days, now);
		deleted += res.deleted;
		more = res.more;
		if (!more) break;
	}

	if (deleted > 0) {
		log.info("audit_retention.swept", { retention_days: days, deleted, more });
	}
};
