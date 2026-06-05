-- Page-level engagement: react / vote on the article itself, without
-- leaving a comment.
--
-- These mirror the comment-level `reactions` (0001) and `votes` (0007)
-- tables, but key on posts(slug) instead of comments(id). Separate tables
-- (rather than ALTERing the existing ones to allow a null comment_id) keep
-- the comment-level PKs and queries untouched — SQLite can't add/relax a
-- composite PK without a full table rebuild.
--
-- Both are gated behind the page_reactions_enabled / page_votes_enabled
-- flags (default OFF — see src/lib/settings.ts), so this migration is inert
-- until an operator opts in.
--
-- Identity is the same ghost-user-by-ip_hash model as comments: one row per
-- (post_slug, user_id[, kind]), so a repeat click from the same browser
-- toggles rather than stacks.

CREATE TABLE IF NOT EXISTS page_reactions (
	post_slug  TEXT NOT NULL REFERENCES posts(slug),
	user_id    TEXT NOT NULL REFERENCES users(id),
	kind       TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (post_slug, user_id, kind)
);
CREATE INDEX IF NOT EXISTS page_reactions_slug_idx ON page_reactions(post_slug);

CREATE TABLE IF NOT EXISTS page_votes (
	post_slug  TEXT NOT NULL REFERENCES posts(slug),
	user_id    TEXT NOT NULL REFERENCES users(id),
	value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
	created_at INTEGER NOT NULL,
	PRIMARY KEY (post_slug, user_id)
);
CREATE INDEX IF NOT EXISTS page_votes_slug_idx ON page_votes(post_slug);
