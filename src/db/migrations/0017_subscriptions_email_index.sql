-- Index subscriptions by email.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0018_*.sql instead.
--
-- The only index on this table that mentions email is `UNIQUE (post_slug,
-- email)` from 0001_init.sql. SQLite can use a composite index for a prefix
-- of its columns, and email is *not* the prefix — so every email-keyed lookup
-- was a full table scan:
--
--   * countPendingSubscriptionsForEmail (`email = ? AND confirmed_at IS NULL`)
--     runs on the unauthenticated POST /api/v1/subscribe path, once per
--     request, to enforce the per-email pending cap. That's the scan an
--     attacker gets to trigger for free, and D1 bills rows *read*.
--   * eraseUserData deletes an erased account's subscriptions and their queued
--     notifications by email.
--
-- Column order is (email, confirmed_at) so the index serves both the email-only
-- lookups and the pending-cap query's second predicate. `confirmed_at IS NULL`
-- is index-usable in SQLite; NULLs are stored and ordered in the index.
--
-- Not UNIQUE: one address legitimately subscribes to many posts.

CREATE INDEX IF NOT EXISTS idx_subs_email_confirmed
	ON subscriptions(email, confirmed_at);
