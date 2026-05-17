-- Garrul initial schema.
-- Forward-only. Once applied to a production D1 instance, never edit this file —
-- write a new 000N_*.sql migration instead.

CREATE TABLE IF NOT EXISTS _migrations (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
	slug         TEXT PRIMARY KEY,
	title        TEXT,
	url          TEXT,
	created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
	id           TEXT PRIMARY KEY,
	provider     TEXT NOT NULL,
	provider_id  TEXT,
	name         TEXT NOT NULL,
	email        TEXT,
	avatar_url   TEXT,
	is_admin     INTEGER NOT NULL DEFAULT 0,
	is_banned    INTEGER NOT NULL DEFAULT 0,
	created_at   INTEGER NOT NULL,
	UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS comments (
	id                TEXT PRIMARY KEY,
	post_slug         TEXT NOT NULL REFERENCES posts(slug),
	parent_id         TEXT REFERENCES comments(id),
	user_id           TEXT NOT NULL REFERENCES users(id),
	body_md           TEXT NOT NULL,
	body_html         TEXT NOT NULL,
	renderer_version  INTEGER NOT NULL DEFAULT 1,
	status            TEXT NOT NULL DEFAULT 'approved',
	edited_at         INTEGER,
	deleted_at        INTEGER,
	ip_hash           TEXT,
	user_agent        TEXT,
	created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post_idx     ON comments(post_slug, status, created_at);
CREATE INDEX IF NOT EXISTS comments_parent_idx   ON comments(parent_id);
CREATE INDEX IF NOT EXISTS comments_user_idx     ON comments(user_id);
CREATE INDEX IF NOT EXISTS comments_renderer_idx ON comments(renderer_version);

CREATE TABLE IF NOT EXISTS reactions (
	comment_id TEXT NOT NULL REFERENCES comments(id),
	user_id    TEXT NOT NULL REFERENCES users(id),
	kind       TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (comment_id, user_id, kind)
);

CREATE TABLE IF NOT EXISTS subscriptions (
	id         TEXT PRIMARY KEY,
	post_slug  TEXT NOT NULL,
	email      TEXT NOT NULL,
	token      TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (post_slug, email)
);
