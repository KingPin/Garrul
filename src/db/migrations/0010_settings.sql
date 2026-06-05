-- Runtime-editable operator settings (hybrid config).
--
-- Until now all configuration was env-var-only (per-deploy, requires a
-- redeploy to change). This adds a tiny key/value store so operators can
-- toggle features — comments, reactions, votes, downvotes, and the new
-- page-level engagement — at runtime from the admin UI.
--
-- Precedence (resolved in src/lib/settings.ts): a row here OVERRIDES the
-- matching env var, which in turn falls back to a hardcoded default. A row
-- is only written when an operator explicitly sets a value; absent rows
-- mean "inherit the env/default", so existing installs are unaffected.
--
-- Values are stored as text ("true"/"false" for booleans) and parsed by the
-- resolution layer with the same boolish semantics as VOTING_ENABLED et al.

CREATE TABLE IF NOT EXISTS settings (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
