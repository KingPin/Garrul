-- Thread paging and retention-sweep indexes. Forward-only; never edit once
-- shipped — make a 0031_*.sql instead.
--
-- Chronological thread paging: seek on (post_slug, created_at, id) over
-- top-level comments only. The cursor predicate in listThreadRefsForPost is
-- a row-value comparison so SQLite can use the (created_at, id) pair.
CREATE INDEX IF NOT EXISTS comments_root_chrono_idx
	ON comments(post_slug, created_at, id) WHERE parent_id IS NULL;

-- `top` paging. The expression MUST stay byte-identical to THREAD_SCORE in
-- src/db/queries.ts or SQLite will not match it to the query.
CREATE INDEX IF NOT EXISTS comments_root_score_idx
	ON comments(post_slug, (CASE WHEN status = 'approved' THEN score_up - score_down ELSE 0 END), id)
	WHERE parent_id IS NULL;

-- IP-retention sweep (src/db/ip-retention.ts): the sweep's WHERE and ORDER BY
-- match these exactly, and rows leave the partial index as they are scrubbed,
-- so a tick with nothing to do reads ~0 rows instead of scanning the table.
CREATE INDEX IF NOT EXISTS comments_ip_retention_idx
	ON comments(COALESCE(edited_at, created_at))
	WHERE ip_hash IS NOT NULL OR user_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_ip_retention_idx
	ON reports(created_at) WHERE reporter_ip_hash IS NOT NULL;

-- From 0007. Ordered on (score_up - score_down), which the `top` sort never
-- used (it orders on THREAD_SCORE), so it was rewritten on every vote for no
-- read benefit. Superseded by comments_root_score_idx.
DROP INDEX IF EXISTS comments_score_idx;
