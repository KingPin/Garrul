-- Index subscriptions by unsubscribe token.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0025_*.sql instead.
--
-- `token` has had no index since 0001_init.sql, so every lookup in
-- getSubscriptionByToken was a full table scan — including a lookup for a
-- token that does not exist. That is reachable by anyone:
--
--   * GET /api/v1/subscribe/unsubscribe/:token is in CARVE_OUT_PATHS
--     (lib/cors.ts), so it takes no session, no Origin and no rate limit.
--   * POST .../one-click is in NO_ORIGIN_POST_PATHS for RFC 8058 and is
--     deliberately not IP-limited, because a mail provider's shared egress
--     would throttle legitimate unsubscribes.
--
-- The token's unguessability bounds what an attacker can *change*; it never
-- bounded what a lookup *costs*. D1 bills rows read, so on a populated table
-- a loop of random 64-hex tokens reads the whole table per request and burns
-- the read budget for every other feature. Same reasoning as 0017's
-- email index, which called out exactly this shape for the pending-cap count.
--
-- Not UNIQUE, deliberately. Collisions are cryptographically implausible
-- (32 random bytes from crypto.getRandomValues, one writer), but a UNIQUE
-- index would turn any duplicate that somehow exists on a live install into
-- a migration that cannot apply — and this index does nothing to earn that
-- risk. Uniqueness is not a property anything reads.

CREATE INDEX IF NOT EXISTS idx_subs_token
	ON subscriptions(token);
