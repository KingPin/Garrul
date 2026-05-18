-- Notification queue + soft-delete on subscriptions.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0003_*.sql instead.

ALTER TABLE subscriptions ADD COLUMN unsubscribed_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN last_notified_at INTEGER;

-- Each row is one queued notification for one (subscriber, comment) pair.
-- The scheduled job batches all sent_at IS NULL rows per subscription
-- into a single digest email, then sets sent_at on the batch.
CREATE TABLE IF NOT EXISTS notifications (
	id              TEXT PRIMARY KEY,
	subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
	comment_id      TEXT NOT NULL REFERENCES comments(id),
	created_at      INTEGER NOT NULL,
	sent_at         INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_sub_pending_idx
	ON notifications(subscription_id, sent_at);
CREATE INDEX IF NOT EXISTS notifications_pending_idx
	ON notifications(sent_at) WHERE sent_at IS NULL;
