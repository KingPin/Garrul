# API keys — v2 design (not implemented)

This is a **forward-looking design** for a server-issued API-key system.
**No code in v1 implements it.** v1's security boundary is the
`ALLOWED_ORIGINS` allowlist enforced on every method under `/api/*` by
`src/lib/cors.ts` — that already handles the "stop random sites from
embedding my widget" threat for browser-loaded clients.

API keys earn their keep only when one of the following is in play:

1. **Programmatic / non-browser clients** that legitimately need
   access (e.g., an SSG that pulls comments at build time, a backup
   script, an importer).
2. **Multi-tenant SaaS.** If Garrul ever runs as a hosted offering,
   per-tenant keys are the natural authorization boundary.
3. **Per-site quotas / accounting.** Rate-limit and bill against a
   key, not a hashed IP.

If none of those motivations apply to your deployment, you do not
need this system. Origin gating is enough.

---

## Non-goals (do NOT design these in)

- **Securing the browser widget.** Any key embedded in `embed.js` is
  publicly readable. Origin enforcement is the actual lever there.
- **End-user authentication.** Sessions cover that
  (`src/lib/session.ts`).
- **Replacing `ALLOWED_ORIGINS`.** Keys are additive — a request can
  satisfy *either* (a) Origin allowlist or (b) a valid key. The key
  path exists for non-browser consumers; the Origin path stays the
  default for the widget.

---

## Wire format

```
Authorization: Bearer grl_<32-hex>
```

- Prefix `grl_` so leaked keys are visually identifiable in logs and
  scrub-able by GitHub secret scanning (apply for a partner token
  prefix registration when this ships).
- 32-hex (16 bytes) random body. Generate with `crypto.getRandomValues`.
- No other auth schemes accepted on `/api/*`. Basic / cookie / etc.
  are not API keys and must not be interpreted as such.

The raw key is shown **once** at issue time and never persisted in
plaintext — we store only `key_hash`.

---

## Schema

New table, separate migration (`src/db/migrations/NNNN_api_keys.sql`):

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,                  -- ULID
  key_hash    TEXT NOT NULL UNIQUE,              -- sha256(raw_key)
  label       TEXT NOT NULL,                     -- human label, e.g. "ssg-builder"
  origin_bound TEXT,                             -- nullable; if set, request Origin must match
  scopes      TEXT NOT NULL,                     -- comma-separated, e.g. "read:comments,read:counts"
  created_at  INTEGER NOT NULL,                  -- unix ms
  last_used_at INTEGER,                          -- unix ms, updated on each successful auth
  revoked_at  INTEGER                            -- nullable; non-null = revoked
);

CREATE INDEX api_keys_revoked_at ON api_keys (revoked_at);
```

**Hashing.** Use SHA-256 of the raw key, no salt. Keys are 128 bits of
random already — salting buys nothing and breaks the lookup index. (We
hash, not store plaintext, so a DB leak doesn't grant access.)

**No `tenant_id` in v1 of keys.** Add it when the multi-tenant
migration lands; design the column nullable for back-compat.

---

## Scopes

Comma-separated string column for simplicity. Initial vocabulary:

| Scope | Grants |
|---|---|
| `read:comments` | GET `/api/v1/comments`, `/counts` |
| `write:comments` | POST/PATCH/DELETE `/api/v1/comments` |
| `read:config` | GET `/api/v1/config` |
| `admin` | All admin routes (rarely issued; prefer session-based admin) |

The middleware checks `scopes.includes(required_scope)` per route.
Per-route required scopes are declared via Hono route metadata when
the keys feature ships.

---

## Middleware ordering

The key check sits **alongside** the Origin check, not in place of it.
Both run in `src/lib/cors.ts` (or a new `apiAuth` middleware in front
of it — TBD during build):

```
1. OPTIONS preflight → handle, return 204.
2. If a carve-out path (health, OAuth) → next().
3. If Authorization: Bearer grl_* is present:
     a. Look up by sha256(key); 401 if missing or revoked.
     b. If origin_bound is set and request Origin differs → 403.
     c. Check required_scope; 403 if missing.
     d. Update last_used_at (best-effort, KV-cached to avoid D1 write per req).
     e. next().  // Origin check skipped; key was the authorization.
4. Else fall back to current Origin-allowlist behavior.
```

**Key takes precedence over Origin.** A valid key authorizes the
request regardless of Origin. If a holder wants Origin-binding for
defense-in-depth (e.g., they only ever use the key from one server),
they set `origin_bound` at issue time and the middleware enforces it.

---

## Admin UI

New route group `/admin/api-keys` (reuses the admin session gate from
`src/routes/admin.ts`):

- `GET /admin/api-keys` — list (label, scopes, origin_bound, last_used_at, revoked_at).
- `POST /admin/api-keys` — create. Returns raw key in the response **once**, with a banner: "Copy this now; it will not be shown again."
- `POST /admin/api-keys/:id/revoke` — soft-delete (`revoked_at = now`).
- No rotation primitive in v1 of keys — revoke + reissue is the workflow.

---

## Rate-limit integration

`src/lib/ratelimit.ts` currently keys buckets on hashed IP. With
keys present, key on `api_key_id` instead — this lets you cut off
a single misbehaving consumer without throttling everyone behind
their NAT.

```
const bucketKey = apiKeyId ?? ipHash;
```

Make the per-bucket limit configurable per key in v2 of keys (a
`rate_limit_rpm` column or similar) — out of scope for the first
build.

---

## Logging & telemetry

- Log the key `id` (never the raw key, never the hash) on each request
  that authenticates via key.
- Emit an Analytics Engine event `apikey.used` with `{id, scope, path,
  status}` — the same channel already used for `comment.posted`,
  `ratelimit.hit`, etc.
- Revocations log a single `apikey.revoked` line.

---

## Migration path from v1 → v2 of keys

Designed-in extension points for SaaS:

1. **`tenant_id` column.** Add to `api_keys`, `posts`, `comments`,
   `subscriptions`. Existing single-tenant rows get a default tenant.
2. **Tenant-scoped origin allowlists.** Move `ALLOWED_ORIGINS` from
   env var to a per-tenant config row, keyed by `tenant_id`. The
   middleware now resolves tenant from the key (or, for browser
   requests, from the Origin → tenant map).
3. **Per-tenant rate limits.** Already enabled by the `apiKeyId`
   bucket key above.

None of this is in v1 of keys — but the column shapes above don't
preclude it.

---

## Open questions to resolve before building

- **One key per consumer, or many?** Likely many (e.g., dev vs prod
  keys for the same SSG). The label field is enough; no per-consumer
  uniqueness constraint.
- **Should self-hosters be able to opt out of keys entirely?** Yes —
  keys are additive. If you never issue one, the middleware never
  exercises the key path. No config flag needed.
- **RSS feeds (`/feed/:slug`) — gate behind keys?** Probably not.
  RSS is universally consumed by non-browser readers that don't
  send any auth. Keep RSS ungated; if you want to lock the feed,
  use Cloudflare WAF.
- **Key in query string for downloads?** Some clients can't set
  Authorization headers (e.g., browser-initiated downloads). Punt
  to v3 of keys; for now, `Authorization` header only.
- **Audit log for admin key actions?** Probably yes — small append-only
  table or just Analytics Engine. Decide when building.

---

## What this design explicitly does NOT include

- Key rotation primitives (revoke + reissue is the workflow).
- OAuth2 client-credentials flow (overkill; we want a static bearer).
- Per-key IP allowlists (origin_bound is the equivalent; IP allowlists
  are operationally painful with Workers' edge network anyway).
- A separate "service account" concept on top of keys (the key *is*
  the service identity).

---

**Status:** design only. When building, start by spiking the migration
and middleware on a branch; the admin UI can lag the protocol.
