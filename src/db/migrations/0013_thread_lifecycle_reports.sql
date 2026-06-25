-- Thread lifecycle + reader reporting.
--
-- 1) Per-post comment closing. `closed` is an operator-set freeze for a single
--    thread; `published_at` is the host page's real publish time (epoch ms),
--    supplied via the widget's data-published attribute. The auto-close rule
--    (see src/lib/settings.ts / src/lib/thread.ts) anchors relative age on
--    published_at, falling back to posts.created_at — note that created_at is
--    "when the first comment arrived" (posts are created lazily on first
--    comment in upsertPost), NOT when the article was published, so the
--    published_at anchor is what makes age-based closing accurate.
--
--    Both are evaluated LAZILY at read/write time (no cron, no status flips,
--    no KV writes). Closing blocks new comments/replies only; existing
--    comments stay visible and reactions/votes stay live.
--
-- 2) Reader reporting. A `reports` row is one reader flagging one comment.
--    reporter_ip_hash is the HMAC hash (never a raw IP, per the IP-handling
--    convention) used for both rate-limit dedup and the UNIQUE guard so a
--    single network can't report-bomb the same comment. status is
--    'open' | 'resolved'; a moderator dismissing the reports flips them to
--    'resolved' without necessarily acting on the comment itself.

ALTER TABLE posts ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN published_at INTEGER;

CREATE TABLE IF NOT EXISTS reports (
	id               TEXT PRIMARY KEY,
	comment_id       TEXT NOT NULL REFERENCES comments(id),
	reporter_user_id TEXT REFERENCES users(id),
	reporter_ip_hash TEXT,
	reason           TEXT,
	status           TEXT NOT NULL DEFAULT 'open',
	created_at       INTEGER NOT NULL,
	UNIQUE (comment_id, reporter_ip_hash)
);
CREATE INDEX IF NOT EXISTS reports_comment_idx ON reports(comment_id, status);
CREATE INDEX IF NOT EXISTS reports_status_idx  ON reports(status, created_at);
