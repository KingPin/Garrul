-- 0008_saved_replies.sql
--
-- Saved replies: canned moderator responses. A mod (or admin) authors a
-- title + a markdown body, optionally shares it with the team, and can
-- post it as a top-level reply on any comment from the queue.
--
-- Why the `scope` split:
--   - 'private': only the owner sees / uses it. Mods can have personal
--     drafts (welcomes, signature blocks) without polluting the team's
--     shared list.
--   - 'shared':  visible + usable by every mod + admin on the instance.
--
-- The body is stored as markdown only; we re-render via the standard
-- `renderMarkdown` allowlist pipeline at *post time*, so we don't risk
-- the saved row carrying stale or insufficiently-sanitized HTML across
-- renderer-version bumps.

CREATE TABLE IF NOT EXISTS saved_replies (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'private'
                 CHECK (scope IN ('private', 'shared')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Fast lookup for the picker: every mod loads
--   (their private replies) UNION (shared replies)
-- on the queue page. Two narrow indexes cover both arms cheaply.
CREATE INDEX IF NOT EXISTS saved_replies_owner_idx
  ON saved_replies(owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS saved_replies_scope_idx
  ON saved_replies(scope, created_at DESC) WHERE scope = 'shared';
