-- Authenticated voting on comments.
--
-- Rationale: the existing `reactions` table is multi-emoji per user (PK on
-- (comment_id, user_id, kind)), which means a malicious client could send
-- both `up` and `down` and the row count is what we'd query — they would
-- cancel themselves. Voting needs strict mutual exclusion: at most one
-- (comment_id, user_id) row, value -1 or 1.
--
-- Counters are denormalized onto `comments` so the read path
-- (listCommentsForPost) stays a single SELECT — adding a JOIN for every
-- post fetch would hit free-tier D1 row-reads hard on busy threads. The
-- vote write path updates both rows in a D1 batch.

CREATE TABLE IF NOT EXISTS votes (
	comment_id TEXT NOT NULL REFERENCES comments(id),
	user_id    TEXT NOT NULL REFERENCES users(id),
	value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS votes_user_idx ON votes(user_id);

ALTER TABLE comments ADD COLUMN score_up   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN score_down INTEGER NOT NULL DEFAULT 0;

-- Supports `sort=top` on the list endpoint without a separate aggregation.
CREATE INDEX IF NOT EXISTS comments_score_idx
	ON comments(post_slug, status, (score_up - score_down) DESC, created_at);
