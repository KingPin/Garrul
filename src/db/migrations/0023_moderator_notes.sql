-- 0023_moderator_notes.sql
--
-- Moderator notes: internal, mod-visible annotations on a comment or a user.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0024_*.sql instead.
--
-- What this is *not*: the `reason` column on audit_log. That records why a
-- particular action was taken and is written by the action that took it.
-- A note is the thing you want to write when there is no action yet — "third
-- borderline comment this week", "emailed them, waiting" — so it has to
-- outlive any single moderation event and be readable by whoever picks the
-- queue up next. Every note still writes an audit row (`note.create` /
-- `note.delete`), so the *fact* of a note is in the log even though its text
-- deliberately is not.
--
-- Polymorphic target, so no foreign key on target_id. The two kinds have
-- different lifetimes and neither is hard-deleted in practice: comments are
-- soft-deleted (status='deleted') and erasure blanks a user row rather than
-- removing it. `eraseUserData` deletes notes *about* the erased user — free
-- text a mod wrote about a person is exactly the personal data erasure is
-- meant to clear. Notes that person *authored* survive, for the same reason
-- their audit rows do: those record moderator work, not their identity.
--
-- author_id mirrors audit_log.admin_id — a plain REFERENCES with no
-- ON DELETE. Cascading would let one departing mod's account take the team's
-- accumulated context with it.
--
-- Bodies are plain text, not markdown: nothing here is published, and
-- storing markdown would mean either rendering it (a second sanitizer
-- surface for zero reader benefit) or showing raw syntax to the reader.

CREATE TABLE IF NOT EXISTS moderator_notes (
  id           TEXT PRIMARY KEY,           -- ULID
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('comment', 'user')),
  target_id    TEXT NOT NULL,
  author_id    TEXT NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- The only read pattern: every note on one target, newest first. Also serves
-- the queue's per-page badge count, which asks for a set of target_ids of one
-- kind at a time.
CREATE INDEX IF NOT EXISTS moderator_notes_target_idx
  ON moderator_notes(target_kind, target_id, created_at DESC);
