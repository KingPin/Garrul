-- Rename the `like` reaction to `fire`.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0023_*.sql instead.
--
-- 👍 sat directly above the up-vote button and meant the same thing twice, so
-- the kind was re-cut as 🔥 "Brilliant". `kind` is the stored value, so the
-- rename is this file rather than an edit to the widget's list.
--
-- Both tables carry the same vocabulary: `reactions` (per comment, 0001) and
-- `page_reactions` (per article, 0011). Rewriting one and not the other would
-- leave the article bar showing counts the comment rows had lost.
--
-- OR IGNORE, not plain UPDATE. Both primary keys end in `kind`
-- (comment_id/post_slug, user_id, kind), so a reader holding both a `like` and a
-- `fire` row on the same target collides. That cannot happen on a fresh install
-- — `fire` did not exist before this release — but it can on a re-run, and a
-- migration that only works once is a migration that fails a restored backup.
--
-- The DELETE is not tidying-up, it is the other half of the rename. OR IGNORE
-- *skips* a conflicting row rather than removing it, so without this the
-- collision case leaves the row sitting there as `like` — still in the table,
-- never rendered by any build, which is precisely the orphan this migration
-- exists to prevent. Anything still spelled `like` after the UPDATE is by
-- definition a row whose `fire` counterpart already exists, so dropping it
-- costs that reader nothing: their reaction on that target is already recorded.
--
-- Net effect: no count changes and no row is orphaned. `like` and `fire` mean
-- the same thing (generic approval), so every existing reaction keeps its
-- meaning as well as its count. The routes also accept `like` on the wire for
-- one release and store it as `fire` (see normalizeReactionKind), which is what
-- makes the gap between this migration and the code deploy safe in either order.

UPDATE OR IGNORE reactions      SET kind = 'fire' WHERE kind = 'like';
DELETE FROM       reactions                       WHERE kind = 'like';

UPDATE OR IGNORE page_reactions SET kind = 'fire' WHERE kind = 'like';
DELETE FROM       page_reactions                  WHERE kind = 'like';
