-- User roles: introduce a tri-valued `role` column so moderation can be
-- delegated to users who are not full admins.
--
-- Forward-only. Once applied, never edit — add a 0006_*.sql migration instead.
--
-- Roles:
--   'user'  — default; can comment, react, vote
--   'mod'   — can use the moderation queue (approve/spam/delete/bulk +
--             reply); cannot ban users, edit settings, run operator scripts,
--             or grant/revoke roles
--   'admin' — full access; can grant/revoke 'mod' and 'admin' on others
--
-- `is_admin` is kept alive for one release cycle as a derived column so the
-- existing /api/v1/auth/me response shape and any consumer reading users.is_admin
-- directly do not break. Invariant: is_admin = 1 ⇔ role = 'admin'. The query
-- layer writes both together; a later migration will drop `is_admin`.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- Backfill existing admins so the invariant holds on first deploy.
UPDATE users SET role = 'admin' WHERE is_admin = 1;

CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);
