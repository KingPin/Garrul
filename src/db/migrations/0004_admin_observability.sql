-- Admin observability: audit log + spam verdict storage.
-- Forward-only. Once applied, never edit — add a 0005_*.sql migration instead.
--
-- audit_log records every admin action (approve/spam/delete/restore/ban/edit/
-- rerender/seed-demo/sub.* etc.) so the moderation history is durable and
-- attributable. Surfaced on the queue (last action strip), the comment/user
-- detail pages (full history), and a standalone /admin/audit page.
--
-- spam_verdicts persists results from src/lib/spam/* checkers (akismet,
-- workers-ai, heuristics). The verdict was previously transient — admins
-- could see a comment was flagged but not by whom or how confidently.

CREATE TABLE IF NOT EXISTS audit_log (
	id           TEXT PRIMARY KEY,           -- ULID
	admin_id     TEXT NOT NULL REFERENCES users(id),
	action       TEXT NOT NULL,              -- approve|spam|delete|restore|edit|ban|unban|rerender|seed-demo|sub.unsubscribe|sub.resend
	target_kind  TEXT NOT NULL,              -- comment|user|subscription|system
	target_id    TEXT,                       -- nullable for system actions
	reason       TEXT,                       -- optional moderator note
	meta         TEXT,                       -- JSON blob (before/after, batch_size, etc.)
	created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_admin   ON audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON audit_log(target_kind, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_log(action, created_at DESC);

CREATE TABLE IF NOT EXISTS spam_verdicts (
	id           TEXT PRIMARY KEY,           -- ULID
	comment_id   TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
	source       TEXT NOT NULL,              -- akismet|workers-ai|heuristics
	verdict      TEXT NOT NULL,              -- spam|ham|uncertain
	score        REAL,                       -- nullable (heuristics may not produce one)
	raw          TEXT,                       -- JSON blob from the provider
	created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdict_comment ON spam_verdicts(comment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verdict_source  ON spam_verdicts(source, created_at DESC);
