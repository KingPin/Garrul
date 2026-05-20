-- Subscription double-opt-in.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0004_*.sql instead.
--
-- Before this change, POST /api/v1/subscribe activated a row immediately,
-- so an attacker could subscribe a victim's email to busy threads and
-- weaponize the operator's legitimately DKIM-signed channel as a mailbomb.
-- After this change, the row carries a one-shot confirm_token and is only
-- treated as active once confirmed_at is set (either by clicking the
-- confirmation email or via the same-session provider-verified fast path
-- in api.subscriptions.ts).
--
-- TODO(garbage-collection): rely on the per-email pending-cap to bound
-- DB growth from never-confirmed rows. A scheduled sweep can be added
-- later if needed.

ALTER TABLE subscriptions ADD COLUMN confirm_token TEXT;
ALTER TABLE subscriptions ADD COLUMN confirmed_at INTEGER;

-- Grandfather every pre-existing row: treat it as already confirmed.
-- The live instance is small (maintainer + sumguy.com dogfood) with no
-- observed abuse, and forcing re-confirmation would interrupt legitimate
-- subscribers who never asked for the change.
UPDATE subscriptions SET confirmed_at = created_at WHERE confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subs_confirm_token ON subscriptions(confirm_token);
