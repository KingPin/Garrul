-- Telegram operator integration.
--
-- telegram_links maps a Telegram account to a Garrul user so the bot can
-- authorize moderation actions and address notifications/digests to the right
-- operator. One row per Telegram user (tg_user_id PK); a Garrul user may link
-- at most one Telegram account (UNIQUE on user_id). The link is *identity*,
-- not standing permission — every action re-checks users.role at the time it
-- runs, so revoking a user's mod/admin role disables their bot actions even
-- while the link persists.
--
-- tg_chat_id is the private chat the bot DMs (the chat id from the linking
-- /start message). It is distinct from the per-channel chat id stored on a
-- telegram webhook endpoint: links are for interactive control + the digest,
-- webhook endpoints are for broadcast notifications.
--
-- digest is an opt-in flag for the daily operator summary (Phase 4).
CREATE TABLE IF NOT EXISTS telegram_links (
	tg_user_id TEXT PRIMARY KEY,
	tg_chat_id TEXT NOT NULL,
	user_id    TEXT NOT NULL REFERENCES users(id),
	digest     INTEGER NOT NULL DEFAULT 0,
	linked_at  INTEGER NOT NULL,
	UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS telegram_links_user_idx ON telegram_links(user_id);
