-- Multi-endpoint webhook dispatch with HMAC signing + retry log.
-- Forward-only. Once applied, never edit — add a 0007_*.sql migration instead.
--
-- webhook_endpoints replaces the single-URL WEBHOOK_URL env var with a
-- table-driven list. Each endpoint can be signed (secret != NULL produces
-- an `X-Garrul-Signature` header on every delivery) or unsigned. `events`
-- is a comma-separated list of WebhookEvent values; an empty string means
-- "all events". `adapter` controls payload formatting:
--   'generic' — the stable v1 contract documented in src/lib/webhook.ts
--   'slack'   — Slack incoming-webhook shape (added in Feature #3)
--   'discord' — Discord embed shape (added in Feature #3)
-- `fail_count` is a running tally of consecutive failures; reset to 0 on
-- the first success after a failure. `disabled_at` is set by the retry
-- handler when fail_count exceeds the giveup threshold so the operator
-- can see why deliveries stopped without a flood of cron log lines.
--
-- WEBHOOK_URL is preserved as a backward-compat shim. If the env var is
-- set and no endpoint with id='_env' exists, the dispatcher synthesizes
-- one in-memory (adapter='generic', secret=NULL, events=NULL → all). No
-- consumer breakage on upgrade; admin UI flags the unsigned env-shim and
-- nudges the operator to migrate to a table row.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id           TEXT PRIMARY KEY,           -- ULID
	url          TEXT NOT NULL,
	secret       TEXT,                       -- HMAC key; NULL = unsigned (legacy)
	events       TEXT,                       -- comma-separated WebhookEvent list, NULL/'' = all
	adapter      TEXT NOT NULL DEFAULT 'generic',
	enabled      INTEGER NOT NULL DEFAULT 1, -- 0 = paused by admin
	fail_count   INTEGER NOT NULL DEFAULT 0,
	disabled_at  INTEGER,                    -- auto-disabled by retry handler when fail_count exceeds threshold
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_enabled ON webhook_endpoints(enabled, id);

-- webhook_deliveries is the retry log. A row is inserted on a failed POST
-- (network error, non-2xx) with next_attempt_at set per exponential
-- backoff (60s, 5m, 30m, 2h, 6h — see RETRY_SCHEDULE in src/lib/webhook.ts).
-- A successful initial POST writes no row (the no-op write is the common
-- case and we want to keep this table small on the free-tier 5GB cap).
-- The cron handler picks up rows where next_attempt_at <= now and retries.
-- After MAX_ATTEMPTS the row is marked status='giveup' and the endpoint's
-- fail_count is incremented; the endpoint auto-disables once it crosses
-- the threshold.
--
-- `payload` stores the rendered body bytes (adapter-formatted, ready to
-- POST again) so a retry produces the exact same signature timestamp/body
-- pair — replays would be valid for the configured window but we mint a
-- fresh timestamp+signature on each retry so the receiver's replay-window
-- check still passes hours later.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id              TEXT PRIMARY KEY,           -- ULID
	endpoint_id     TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
	event           TEXT NOT NULL,              -- WebhookEvent
	payload         TEXT NOT NULL,              -- raw body to POST
	status          TEXT NOT NULL,              -- pending|delivered|giveup
	attempts        INTEGER NOT NULL DEFAULT 0,
	last_error      TEXT,                       -- HTTP status or fetch error string
	next_attempt_at INTEGER NOT NULL,           -- ms epoch
	created_at      INTEGER NOT NULL,
	delivered_at    INTEGER                     -- ms epoch on first success
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
	ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
	ON webhook_deliveries(endpoint_id, created_at DESC);
