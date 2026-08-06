-- An atomic, non-racy ceiling on outbound confirmation email.
--
-- Why this exists (issue #64). POST /api/v1/subscriptions sends a confirmation
-- email per accepted request, and until now the only thing bounding that was
-- the IP-keyed rate limiter. On the default Cache API backend that limiter's
-- read-modify-write is non-atomic *and* its write is a full overwrite, so N
-- concurrent requests from one identity sustain roughly N x the configured cap
-- indefinitely (pinned by tests/ratelimit.test.ts). The secondary control,
-- PENDING_PER_EMAIL_CAP, binds per address, so an attacker cycling addresses
-- never touches it. Net effect: unbounded billable mail plus a sending domain
-- accumulating bounce/complaint reputation from mail nobody asked for.
--
-- The fix has to hold on a DEFAULT install, i.e. without the opt-in
-- RATE_LIMIT_DO Durable Object binding. D1 gives us the one thing the Cache API
-- cannot: statement-level atomicity. A single UPDATE that carries the cap in
-- its own WHERE clause is an indivisible check-and-increment, so concurrency
-- cannot multiply it.
--
-- Why a counter row rather than a windowed COUNT(*) over `subscriptions`:
-- 0017_subscriptions_email_index.sql already flags that D1 bills rows *read*
-- and that this unauthenticated path is "the scan an attacker gets to trigger
-- for free". A COUNT(*) over a growing table gets more expensive exactly under
-- attack; a single-row counter is O(1) whatever the volume.
--
-- `scope` is a free-form string rather than an enum so other outbound mail
-- (digests, for instance) can adopt the same ceiling later without a schema
-- change. Only the confirmation-email scopes are wired up today — see
-- CONFIRM_SEND_BUDGETS in src/lib/email-budget.ts for the live caps.
--
-- Not a general-purpose rate limiter: this is deliberately GLOBAL, not keyed on
-- IP or address, because every per-identity key the endpoint has is either racy
-- (the limiter) or attacker-controlled (email, post_slug — note post_slug is
-- never validated against `posts`). A global ceiling is the one thing none of
-- those bypasses reach. The cost is documented in docs/ANTISPAM.md: an attacker
-- can spend the window and deny *new* subscriptions until it rolls. Existing
-- confirmed subscribers are unaffected — this gates confirmation mail only.

CREATE TABLE IF NOT EXISTS email_send_budget (
	-- Which budget this row counts. Matches SendBudget.scope in
	-- src/lib/email-budget.ts.
	scope        TEXT PRIMARY KEY,
	-- Epoch ms the current fixed window opened. Rolled forward by the reserve
	-- statement itself once it falls outside the window.
	window_start INTEGER NOT NULL,
	-- Sends reserved in the current window.
	sent         INTEGER NOT NULL
);

-- Seed the rows the reserve path expects.
--
-- This matters for correctness, not just convenience: with the rows present the
-- reserve path is a pure UPDATE, so there is no INSERT-vs-UPDATE race to lose
-- and no ON CONFLICT branch to reason about. A missing row is instead treated
-- as an infrastructure fault and fails OPEN (see reserveSend), so an install
-- that somehow skipped this seed degrades to the old behaviour rather than
-- refusing every subscription.
--
-- window_start = 0 is always outside any window, so the first request through
-- each scope rolls the window forward and starts counting at 1.
INSERT OR IGNORE INTO email_send_budget (scope, window_start, sent) VALUES
	('confirm:burst', 0, 0),
	('confirm:daily', 0, 0);
