-- Admin list and dashboard indexes. Forward-only; never edit once shipped —
-- make a 0032_*.sql instead.
--
-- Moderation queue by status tab (`status = ? ORDER BY created_at DESC, id
-- DESC`), the dashboard's pending/spam counts, and the oldest-pending probe.
-- Without it every queue load scanned comments_post_idx and sorted.
CREATE INDEX IF NOT EXISTS comments_status_created_idx
	ON comments(status, created_at, id);

-- The queue's "all" tab and the dashboard's 30-day windows (timeline, top
-- posts, top commenters, spam rate): a range on created_at instead of a scan.
CREATE INDEX IF NOT EXISTS comments_created_idx
	ON comments(created_at, id);

-- Admin users and subscriptions lists page newest-first on (created_at, id).
CREATE INDEX IF NOT EXISTS users_created_idx
	ON users(created_at, id);
CREATE INDEX IF NOT EXISTS subscriptions_created_idx
	ON subscriptions(created_at, id);
