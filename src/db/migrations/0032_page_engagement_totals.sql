-- Page-engagement totals, kept on write. Forward-only; never edit once
-- shipped — make a 0033_*.sql instead.
--
-- Bootstrap used to count page_reactions and page_votes on every pageview,
-- uncached: R + 2V rows per view. The totals now live beside the post and
-- each write recounts its own slice in the same batch (the castVote model),
-- so the counters are recomputed from the source rows and cannot drift.

ALTER TABLE posts ADD COLUMN page_votes_up   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN page_votes_down INTEGER NOT NULL DEFAULT 0;

-- One row per (post, kind). A kind that drops to zero keeps its row at 0;
-- readers filter on count > 0.
CREATE TABLE IF NOT EXISTS page_reaction_totals (
	post_slug TEXT NOT NULL REFERENCES posts(slug),
	kind      TEXT NOT NULL,
	count     INTEGER NOT NULL,
	PRIMARY KEY (post_slug, kind)
);

UPDATE posts SET
	page_votes_up   = (SELECT COUNT(*) FROM page_votes v WHERE v.post_slug = posts.slug AND v.value =  1),
	page_votes_down = (SELECT COUNT(*) FROM page_votes v WHERE v.post_slug = posts.slug AND v.value = -1)
 WHERE slug IN (SELECT post_slug FROM page_votes);

INSERT OR REPLACE INTO page_reaction_totals (post_slug, kind, count)
	SELECT post_slug, kind, COUNT(*) FROM page_reactions GROUP BY post_slug, kind;

-- The write-time recounts read (post_slug, value) and (post_slug, kind).
-- The old single-column indexes duplicated each table's primary-key prefix.
DROP INDEX IF EXISTS page_votes_slug_idx;
CREATE INDEX IF NOT EXISTS page_votes_value_idx ON page_votes(post_slug, value);
DROP INDEX IF EXISTS page_reactions_slug_idx;
CREATE INDEX IF NOT EXISTS page_reactions_kind_idx ON page_reactions(post_slug, kind);
