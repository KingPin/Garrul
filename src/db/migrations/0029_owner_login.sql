-- Single-use owner login tokens, for installs with no OAuth provider and no
-- ADMIN_EMAILS. `npm run owner-link` inserts a row; /admin/owner consumes it.
--
-- Forward-only. Never edit once shipped — add a 0030_*.sql instead.
--
-- Only the SHA-256 of the token is stored, so a D1 read (export, backup,
-- support dump) cannot be replayed as a login. `used_at` is NULL until the
-- redeeming UPDATE flips it; that UPDATE is the single-use guarantee.
CREATE TABLE IF NOT EXISTS owner_login_tokens (
	token_hash  TEXT PRIMARY KEY,
	user_id     TEXT NOT NULL REFERENCES users(id),
	expires_at  INTEGER NOT NULL,
	used_at     INTEGER
);

CREATE INDEX IF NOT EXISTS owner_login_tokens_user_idx
	ON owner_login_tokens(user_id);
