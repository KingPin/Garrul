-- Record WHO removed a deleted comment, so the public placeholder can
-- distinguish a self-delete from a moderator removal.
--
-- Nullable, no default: NULL means "not deleted" (or a pre-existing
-- deletion from before this migration). On transition to status='deleted'
-- the query layer sets 'author' (self/own-thread delete via the public API)
-- or 'moderator' (the moderation queue action). Restoring a comment clears
-- it back to NULL alongside deleted_at. Values are 'author' | 'moderator'.
--
-- This column only supplies the attribution text. Whether a deleted comment
-- appears as a placeholder at all depends on the tree: a deleted comment with
-- live descendants is always kept (for thread continuity), while a deleted
-- leaf is pruned unless the show_deleted_placeholders flag is on
-- (see src/lib/settings.ts and keepableSet in src/lib/tree.ts).

ALTER TABLE comments ADD COLUMN deleted_by TEXT;
