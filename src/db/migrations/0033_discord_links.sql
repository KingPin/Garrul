-- Discord moderation bot identity.
--
-- discord_links maps a Discord account to a Garrul user, mirroring
-- telegram_links (0014). One row per Discord user (discord_user_id PK); a
-- Garrul user links at most one Discord account (UNIQUE on user_id). The link
-- is identity, not standing permission: every action re-reads users.role.
-- There is no digest or chat id column; the Discord digest goes to a channel.
CREATE TABLE IF NOT EXISTS discord_links (
	discord_user_id TEXT PRIMARY KEY,
	user_id         TEXT NOT NULL UNIQUE REFERENCES users(id),
	linked_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discord_links_user ON discord_links(user_id);
