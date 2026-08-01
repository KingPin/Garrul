-- Materialize each comment's nesting depth so the insert path can cap it
-- without walking the parent chain on every write.
--
-- Depth is 1-based: a top-level comment is depth 1, a direct reply is 2.
-- The write path sets depth = parent.depth + 1 in insertComment and rejects
-- anything past MAX_REPLY_DEPTH (see src/routes/api.comments.ts). Without a
-- stored depth there was no server-side limit at all: the API validated only
-- that the parent existed and shared the post, so an unbounded reply chain
-- was insertable, and the tree builder's per-node ancestor walk is O(N^2) in
-- chain length — enough to blow the 10ms free-tier CPU budget on the read
-- side and take the whole slug's comment list offline permanently.
--
-- Note this is a *reply* cap, not the rendering flatten threshold. MAX_DEPTH
-- in src/lib/tree.ts still controls where the tree flattens for display.
--
-- Existing rows deeper than the cap keep rendering; they just can't be
-- replied to. Imported threads (Disqus) are clamped on their own path.

ALTER TABLE comments ADD COLUMN depth INTEGER NOT NULL DEFAULT 1;

-- Backfill from parent_id. The `depth < MAX_BACKFILL_DEPTH` guard bounds the
-- recursion: parent_id is a DAG by construction (a comment can only reference
-- one that already existed), but a cycle would otherwise loop the CTE forever,
-- and a migration that hangs against production D1 is worse than one that
-- leaves a pathological row at a conservative value.
--
-- A row the recursion never reaches has a non-NULL parent_id that isn't in the
-- chain — either an orphan (parent row gone) or a link past the guard, which is
-- exactly the abusive deep chain this cap exists to stop. Both fail *closed* at
-- 1000: the row still renders, it just can't be replied to. Roots always match
-- the base case, so they never hit the fallback.
WITH RECURSIVE chain(id, depth) AS (
	SELECT id, 1 FROM comments WHERE parent_id IS NULL
	UNION ALL
	SELECT c.id, chain.depth + 1
	FROM comments c
	JOIN chain ON c.parent_id = chain.id
	WHERE chain.depth < 1000
)
UPDATE comments
SET depth = COALESCE((SELECT depth FROM chain WHERE chain.id = comments.id), 1000);
