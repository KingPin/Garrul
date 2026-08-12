-- Queue for moderator email notifications.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0022_*.sql instead.
--
-- Why a second table rather than reusing `notifications` (0002): that table's
-- subscription_id is NOT NULL REFERENCES subscriptions(id), and a moderator has
-- no subscription row — they are whoever ADMIN_EMAILS (or MODERATOR_NOTIFY_EMAILS)
-- names. Widening that column to nullable would also make every reader-digest
-- query carry a "and this one isn't a moderator row" clause forever.
--
-- The two queues are also read on different schedules by different senders
-- (src/lib/digest.ts vs src/lib/moderator-digest.ts) and answer different
-- questions, so keeping them apart costs one table and buys two simple ones.

CREATE TABLE IF NOT EXISTS moderator_notifications (
	id         TEXT PRIMARY KEY,
	comment_id TEXT NOT NULL REFERENCES comments(id),
	-- Why this comment wants a moderator's attention:
	--   'pending'  — the anti-spam verdict routed it to the queue instead of
	--                publishing it.
	--   'reported' — a reader filed the first report on it.
	-- Carried through to the email so one digest can say which is which, and
	-- part of the dedup key below so the same comment can raise both.
	reason     TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	sent_at    INTEGER
);

-- The cron scan is "everything still unsent", so index exactly that. Partial,
-- like notifications_pending_idx: sent rows are the overwhelming majority over
-- an instance's life and none of them are ever scanned again.
CREATE INDEX IF NOT EXISTS moderator_notifications_pending_idx
	ON moderator_notifications(sent_at) WHERE sent_at IS NULL;

-- One pending row per (comment, reason), enforced rather than checked.
--
-- The report path is reader-triggered and only bounded by a UNIQUE on
-- (comment_id, reporter_ip_hash) — so N networks reporting one comment is N
-- inserts here without this. Paired with INSERT OR IGNORE (see
-- enqueueModeratorNotification), a brigade collapses to a single queue row and
-- a single line in the digest.
--
-- Partial on sent_at IS NULL so it bounds the *queue*, not the history: once a
-- digest has gone out, a later report on the same comment enqueues again and
-- the moderator hears about it a second time. That is the right behaviour — the
-- first email may well have been about a comment they left up.
CREATE UNIQUE INDEX IF NOT EXISTS moderator_notifications_dedup_idx
	ON moderator_notifications(comment_id, reason) WHERE sent_at IS NULL;

-- Moderator mail gets its OWN ceiling rows, not the confirmation ones.
--
-- 0018 left `scope` free-form precisely so other outbound mail could adopt this
-- table without a schema change. Sharing the *counters* would be the bug: a spam
-- flood filling the moderation queue would spend the confirmation budget and
-- silently stop new subscribers from ever confirming, and a subscribe-endpoint
-- attack would blind the operator to the flood. Separate scopes mean neither
-- failure can reach the other.
--
-- window_start = 0 is outside any window, so the first send through each scope
-- rolls it forward and starts counting at 1. Caps live in
-- MODERATOR_SEND_BUDGETS (src/lib/moderator-digest.ts).
INSERT OR IGNORE INTO email_send_budget (scope, window_start, sent) VALUES
	('moderator:burst', 0, 0),
	('moderator:daily', 0, 0);
