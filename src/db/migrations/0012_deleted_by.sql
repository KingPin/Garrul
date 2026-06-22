-- Record WHO removed a deleted comment, so the public placeholder can
-- distinguish a self-delete from a moderator removal.
--
-- Nullable, no default: NULL means "not deleted" (or a pre-existing
-- deletion from before this migration). On transition to status='deleted'
-- the query layer sets 'author' (self/own-thread delete via the public API)
-- or 'moderator' (the moderation queue action). Restoring a comment clears
-- it back to NULL alongside deleted_at. Values are 'author' | 'moderator'.
--
-- Rendering of the placeholder is gated by the show_deleted_placeholders
-- flag (see src/lib/settings.ts); this column only supplies the attribution.

ALTER TABLE comments ADD COLUMN deleted_by TEXT;
