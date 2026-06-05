---
title: Garrul — AI Operations Guide
audience: AI coding assistant
repo: https://github.com/KingPin/Garrul
---

## 1. What Garrul is (for operators)

Garrul is a self-hosted comment system that runs as a single Cloudflare
Worker backed by D1 (SQLite) and KV. There is no container, no VPS, no
database server. Operating it means: managing `wrangler.toml` +
secrets, applying forward-only D1 migrations, configuring
`ALLOWED_ORIGINS`, optionally wiring OAuth and email, and tailing logs
with `wrangler tail`.

The integrator-facing counterpart (for AI assistants helping someone
**embed** Garrul) is `AGENTS.md`, also served live at `/AGENTS.md` from
a deployed instance. This file is the operator side and is **repo-only**.

## 2. Decide: do you want to self-host?

Self-host when the user wants **first-party data ownership** (comments
in their own D1, not a vendor); is fine with **Cloudflare's free tier**
plus an optional Resend account for digests; runs a **static blog /
docs / marketing site** and is comfortable on the command line; and
wants a **tracker-free** embed (no analytics pixels, one HttpOnly
session cookie).

Do not self-host when the user wants **drop-in, hands-off** comments
and won't manage secrets, DNS, or `wrangler` (Garrul does not ship a
multi-tenant SaaS in v1); needs **real-time updates, image uploads,
@mentions, in-comment search, or generic OIDC** (all v2 backlog); or
is already on **Disqus / Giscus / utterances** and that works —
migration rarely wins.

Self-hosters are the primary audience of this codebase. `garrul.com`
is the maintainer's instance — don't assume the user wants to use it.

## 3. Prerequisites

Before running a single command, the user needs:

- A **Cloudflare account** (free plan is sufficient).
- A **domain on Cloudflare DNS**. Required for `custom_domain = true`.
  If DNS is elsewhere, move it first or accept `*.workers.dev` (which
  has third-party-cookie issues in Safari/Brave — not recommended).
- **Node.js >= 22** and `npm`. The repo's `.nvmrc` pins the version.
- A clone of the repo: `git clone https://github.com/KingPin/Garrul.git`.
- `wrangler` (installed via `npm install` as a dev dep; no global needed).
- **Optional credentials**: GitHub OAuth app (GitHub sign-in), Google
  OAuth app (Google sign-in), Cloudflare Turnstile site + secret keys
  (required for anonymous commenting), Resend API key (for digests).

## 4. First-time deploy

The long-form walkthrough is in `INSTALL.md` at the repo root. Read it
end-to-end before improvising. Operator-side shape:

1. `npm install` (installs `wrangler` as a dev dep).
2. `npx wrangler login` — browser OAuth, one-time per machine.
3. Copy templates: `cp wrangler.example.toml wrangler.toml` and
   `cp .dev.vars.example .dev.vars`. Both targets are gitignored.
4. Run `./scripts/setup.sh`. It creates the D1 database (`garrul-db`)
   and the four KV namespaces (`RATE_LIMITS`, `OAUTH_STATE`, `SESSIONS`,
   `TREE_CACHE`), pastes their IDs into `wrangler.toml`, and prompts
   for each `wrangler secret put`. Skip secrets you don't have yet.
5. Fill in `[vars]` in `wrangler.toml` (section 5 has the table).
6. Apply migrations to **remote** D1: `npm run migrate -- --remote`.
   Without `--remote` only the local Miniflare DB is migrated and the
   deployed Worker will 500.
7. `npm run deploy` — uploads the Worker and provisions the custom
   domain.
8. Smoke-test: `curl -fsSL https://comments.yourdomain.com/api/v1/health`
   → `{"status":"ok","service":"garrul","time":"..."}`.

The most common deploy failures are "forgot to set a secret" (step 4)
and "migrated locally but not remotely" (step 6).

## 5. Configuration: vars vs. secrets

Three configuration surfaces:

- **`wrangler.toml` `[vars]`** — non-sensitive, baked into the deployed
  Worker, visible in the Cloudflare dashboard. The real `wrangler.toml`
  is gitignored; only `wrangler.example.toml` is committed.
- **`wrangler secret put NAME`** — encrypted, never echoed back. For
  anything sensitive.
- **`.dev.vars`** — local-only equivalent for `wrangler dev`.
  Gitignored. Template is `.dev.vars.example`.

| Name | Type | Purpose | Example | Where to set |
|---|---|---|---|---|
| `ENV` | var | Switches dev affordances (CORS open, cookies `SameSite=Lax`). Production must be `production`. | `production` | `wrangler.toml` |
| `EDIT_WINDOW_MINUTES` | var | Minutes a commenter can edit their own post. | `15` | `wrangler.toml` |
| `ALLOWED_ORIGINS` | var | Comma-separated origins allowed to embed + call `/api/*`. See section 6. | `https://yourblog.example.com` | `wrangler.toml` |
| `ADMIN_EMAILS` | var | Comma-separated emails. OAuth signups matching get auto-admin. | `you@example.com` | `wrangler.toml` |
| `EMAIL_PROVIDER` | var | Adapter selector. `resend` is the only v1 value. Unset disables sends. | `resend` | `wrangler.toml` |
| `EMAIL_FROM` | var | `From:` header for digest emails. Domain must be verified in the provider. | `Garrul <comments@example.com>` | `wrangler.toml` |
| `PUBLIC_BASE_URL` | var | Public URL of the Worker; used in permalinks + email bodies. | `https://comments.example.com` | `wrangler.toml` |
| `CANONICAL_URL` | var | Optional. Override for the public URL used by the `/AGENTS.md` route when the inbound `Host` differs from the canonical address. | `https://comments.example.com` | `wrangler.toml` |
| `OAUTH_CALLBACK_BASE` | var | Base URL for OAuth callbacks; must match the URI registered with each provider. Usually identical to `PUBLIC_BASE_URL`. | `https://comments.example.com` | `wrangler.toml` |
| `JWT_SECRET` | secret | Cookie signing for anon-edit tokens. Reserved; current sessions are KV-backed. Set a random value or skip. | `openssl rand -hex 32` output | `wrangler secret put` / `.dev.vars` |
| `IP_HASH_SECRET` | secret | HMAC-SHA-256 pepper for IP hashing (see `src/lib/ip-hash.ts`). Never log/store raw IPs. | `openssl rand -hex 32` output | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SITE_KEY` | secret | Cloudflare Turnstile site key. Required for anonymous commenting. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SECRET` | secret | Turnstile secret. Server-side token verification. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `GH_CLIENT_ID` | secret | GitHub OAuth client ID. Required for GitHub sign-in. | `Iv1.abcdef...` | `wrangler secret put` / `.dev.vars` |
| `GH_CLIENT_SECRET` | secret | GitHub OAuth client secret. | `ghp_...` | `wrangler secret put` / `.dev.vars` |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth client ID. Required for Google sign-in. | `1234.apps.googleusercontent.com` | `wrangler secret put` / `.dev.vars` |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret. | `GOCSPX-...` | `wrangler secret put` / `.dev.vars` |
| `RESEND_API_KEY` | secret | Resend API key. Required when `EMAIL_PROVIDER=resend`. | `re_...` | `wrangler secret put` / `.dev.vars` |
| `WEBHOOK_URL` | secret | Legacy single-URL webhook (fire-and-forget, no retries). Only honored when no endpoints are configured on `/admin/webhooks` — prefer endpoint rows (signed, retried, per-event filters). | `https://example.com/hook` | `wrangler secret put` / `.dev.vars` |
| `COMMENTS_ENABLED` | var | Master switch for new comment creation. Defaults **on**; set `0`/`false`/`no`/`off` to close commenting instance-wide (existing comments stay visible read-only, the widget shows a "Comments are closed." notice, and `POST /api/v1/comments` returns 403). | `true` | `wrangler.toml` |
| `REACTIONS_ENABLED` | var | Comment emoji reactions. Defaults **on**; same falsy-spelling semantics. Disabling hides the reaction bar and 403s `POST /api/v1/reactions`. | `true` | `wrangler.toml` |
| `VOTING_ENABLED` | var | Comment voting (up/down buttons in the widget). Defaults **on** when unset; set `0`/`false`/`no`/`off` to disable instance-wide. | `true` | `wrangler.toml` |
| `DOWNVOTES_ENABLED` | var | Downvote button. Same defaults-on semantics. Applies to **both** comment votes and page votes (a brigading-mitigation switch); independent of `VOTING_ENABLED`. | `true` | `wrangler.toml` |
| `PAGE_REACTIONS_ENABLED` | var | Article-level emoji reaction bar (react to the page itself, no comment). Defaults **off** so an upgrade never surfaces new UI unasked. Enables `POST /api/v1/page-engagement/reactions` and the widget bar. | `false` | `wrangler.toml` |
| `PAGE_VOTES_ENABLED` | var | Article-level "was this helpful?" up/down vote tally. Defaults **off**. Enables `POST /api/v1/page-engagement/votes`; downvotes here still honor `DOWNVOTES_ENABLED`. | `false` | `wrangler.toml` |
| `CF_ACCOUNT_ID` | var | Optional. Cloudflare account ID; paired with `CF_API_TOKEN` to enable the `/admin/usage` analytics page. | `0123abcd...` | `wrangler.toml` (or `wrangler secret put` — the in-app setup guide uses the secret form; both work) |
| `CF_API_TOKEN` | secret | Optional. Cloudflare API token (Analytics read scope) for `/admin/usage`. The page renders setup instructions when either value is unset. | `...` | `wrangler secret put` / `.dev.vars` |

Bindings (D1, KV, Analytics) live in `wrangler.toml` outside `[vars]`
and are populated by `./scripts/setup.sh`. Don't edit binding IDs by
hand once a deploy has used them.

### Feature flags: runtime overrides (since v1.10.0)

The six feature flags — `COMMENTS_ENABLED`, `REACTIONS_ENABLED`,
`VOTING_ENABLED`, `DOWNVOTES_ENABLED`, `PAGE_REACTIONS_ENABLED`,
`PAGE_VOTES_ENABLED` — are **hybrid config**. The env vars above are only
the *defaults*. Each flag is resolved with the precedence:

```
DB settings row  >  env var  >  hardcoded default
```

Operators flip them at runtime from the **admin Settings page** (`/admin`
→ Settings), which writes a row to the `settings` D1 table — no redeploy,
no `wrangler` round-trip. "Reset to defaults" deletes the rows so the env
var / default applies again. The resolved set is KV-cached briefly and
busted on save, so a toggle takes effect within seconds across the widget
(`/api/v1/config`) and the server-side gates. Leaving a flag untouched in
the admin UI writes no row, so existing installs that only set env vars are
unaffected. Implementation: `src/lib/settings.ts`.

## 6. `ALLOWED_ORIGINS` deep-dive

The single most common foot-gun. Symptom: the widget mounts but every
API request returns 403 with body:

```json
{"error": "err.origin.forbidden"}
```

`ALLOWED_ORIGINS` is the operator's allowlist of origins permitted to
embed the widget and call `/api/*`. It doubles as the CSRF gate
(`SameSite=None` cookies opt out of the browser's default protection,
so the Origin allowlist is the lever). Implementation: `src/lib/cors.ts`.

Rules:

- **Comma-separated**: `https://a.example, https://b.example`.
  Whitespace around commas is trimmed.
- **Exact match**: scheme + host + port. No suffix or path matching.
  `https://blog.example.com` does NOT match `https://www.blog.example.com`.
- **Scheme required**: `blog.example.com` alone never matches; always
  include `https://`.
- **No paths**: origin = scheme + host + optional port. No path.
- **No wildcards**: `*` is rejected by the CORS spec with
  `credentials: include`, and Garrul always sends credentials.
- **No trailing slash**: `https://blog.example.com/` won't match the
  browser's `Origin` header.
- **`ENV=dev` bypass**: when `ENV=dev`, the Origin gate is skipped
  entirely. Local-only — never set `ENV=dev` in production.
- **Carve-outs**: `GET /api/v1/health` and
  `GET /api/v1/auth/*/{start,callback}` bypass the gate because they're
  invoked without an `Origin` header (uptime probes + top-level OAuth).

Test the allowlist with curl. Replace `comments.example.com` with the
Worker host and `blog.example.com` with the embedding site:

```bash
# Allowed origin — expect 200 (or whatever the route returns) with the
# Access-Control-Allow-Origin header echoing your Origin.
curl -i -H "Origin: https://blog.example.com" \
  https://comments.example.com/api/v1/comments?slug=hello

# Disallowed origin — expect 403 with body {"error": "err.origin.forbidden"}.
curl -i -H "Origin: https://evil.example.com" \
  https://comments.example.com/api/v1/comments?slug=hello

# No Origin header on a gated path — expect 403 too (curl strips Origin
# by default; this is what scrapers and SSR build steps look like to
# the Worker).
curl -i https://comments.example.com/api/v1/comments?slug=hello
```

Build-time fetchers (SSGs reading comments at deploy time) will get 403s
here — workaround is the ungated `GET /feed/:slug` Atom feed until the
API-keys system ships (`docs/api-keys-design.md`).

## 7. Turnstile

Cloudflare Turnstile is the anti-spam challenge served to **anonymous**
commenters. Signed-in users skip it. Two values are required:
`TURNSTILE_SITE_KEY` (public, embedded in widget HTML) and
`TURNSTILE_SECRET` (private, verifies the token server-side).

Provisioning:

1. Open <https://dash.cloudflare.com/?to=/:account/turnstile>.
2. "Add a site." **Hostname is the blog's domain** (the page embedding
   the widget), not the Worker's hostname.
3. Copy site key + secret key.
4. `wrangler secret put TURNSTILE_SITE_KEY` and
   `wrangler secret put TURNSTILE_SECRET`.

For local dev, `.dev.vars.example` ships Cloudflare's "always passes"
testing keys (`1x00000000...AA` for both). Without both values set the
anonymous form blocks on posting. There is no "anonymous off" toggle
in v1.

### Optional extra anti-spam layers

Three lightweight heuristics and a pluggable content classifier are
available on top of Turnstile. **All off by default.** Flagged comments
flip to `status='pending'` and land in the admin queue rather than
being silently dropped.

- `SPAM_HONEYPOT_MIN_MS` + `SPAM_FORM_TS_SECRET` — flag submissions
  that arrive faster than wall-clock `N` ms after the form rendered.
- `SPAM_LINK_THRESHOLD` — flag comments containing more than `N`
  http(s)/mailto links.
- `SPAM_FIRST_COMMENT_MODERATE=true` — every commenter's first-ever
  comment goes to pending until you approve once.
- `SPAM_PROVIDER` — set to `akismet` or `workers-ai` to enable a
  content classifier (each has its own required secrets/bindings).

See [`docs/ANTISPAM.md`](./docs/ANTISPAM.md) for the full layer
breakdown, privacy tradeoffs (Akismet sends comment content off
Cloudflare; Workers AI keeps it on-network), and recommended starter
configs.

## 8. OAuth providers

Two providers in v1: GitHub and Google. Generic OIDC is v2 backlog. The
operator picks which to enable by setting the matching client ID +
secret. If both are unset, the widget shows only the anonymous form.

Callback URL pattern (driven by `OAUTH_CALLBACK_BASE`):

```
<OAUTH_CALLBACK_BASE>/api/v1/auth/<provider>/callback
```

For `OAUTH_CALLBACK_BASE = https://comments.example.com`:

- GitHub: `https://comments.example.com/api/v1/auth/github/callback`
- Google: `https://comments.example.com/api/v1/auth/google/callback`

**GitHub.** <https://github.com/settings/developers> → New OAuth App.
GitHub allows exactly one callback URL per app — register two apps for
staging + prod. Scopes: `read:user user:email`.

**Google.** <https://console.cloud.google.com/apis/credentials> →
Create Credentials → OAuth client ID → Web application. Multiple
authorized redirect URIs are allowed. Until the app is verified, only
consent-screen test users can sign in; verification takes 7-10 business
days.

**Dev vs. prod redirects.** Either register a separate app per
environment, or add `http://localhost:8787/api/v1/auth/<provider>/callback`
as an additional redirect. Both GitHub and Google permit HTTP localhost.

## 9. Email

Garrul ships a Resend adapter as the default (`src/lib/email.ts`). The
adapter interface is a single `sendEmail(env, input)` call; alternative
providers (MailChannels, Postmark) can be wired by swapping the
implementation. `EMAIL_PROVIDER` selects; only `resend` is implemented
in v1.

To enable digests:

1. Set `EMAIL_PROVIDER = "resend"` in `wrangler.toml`.
2. Set `EMAIL_FROM` to a sender on a Resend-verified domain.
3. `wrangler secret put RESEND_API_KEY`.
4. The cron in `wrangler.example.toml` (`*/15 * * * *`) auto-registers
   on deploy. Comments newer than ~5 minutes are debounced so reply
   bursts coalesce into a single email per subscriber.

If `EMAIL_PROVIDER` or `RESEND_API_KEY` is unset, `sendEmail` returns
`false`, the caller logs a warning, and the request continues.
Operators who don't want digests can leave both unset and remove the
`[triggers]` block to avoid registering the cron at all.

Triggers (events that produce a send): a subscriber to a thread sees a
new reply land (digest email); an unsubscribe-link click (clears the
subscription, no send). No transactional sends per comment; everything
flows through the debounced cron.

## 10. Operating the instance

**Logs.** `npm run tail` (alias for `wrangler tail`). Every request
emits one JSON line with a request ID via `src/lib/log.ts`. No PII
(names, emails, comment bodies) is logged. Filter by request ID when
debugging a specific user-reported issue.

**Migrations.** Forward-only SQL in `src/db/migrations/NNNN_name.sql`,
tracked by the `_migrations` table. Current set:

- `0001_init.sql` — core schema
- `0002_notifications.sql` — email subscriptions + digests
- `0003_subscription_confirm.sql` — double-opt-in confirmation
- `0004_admin_observability.sql` — audit log + spam verdicts
- `0005_user_roles.sql` — `users.role` (`user` / `mod` / `admin`)
- `0006_webhook_endpoints.sql` — outbound signed webhooks + retry queue
- `0007_votes.sql` — vote storage + denormalized score counters
- `0008_saved_replies.sql` — moderator saved replies
- `0009_import_tracking.sql` — Disqus import idempotency

Run with `npm run migrate` (local Miniflare) or
`npm run migrate -- --remote` (production D1). Idempotent. Never edit a
migration after it's applied to prod — add new behavior as a new
numbered file. When upgrading an existing install, re-running
`npm run migrate -- --remote` applies whatever the new release added.

**Roles.** Since v1.8.0 there are three permission tiers
(`0005_user_roles.sql`):

- `user` — default; can comment, react, vote.
- `mod` — can use the moderation queue (approve / spam / delete /
  restore, bulk actions, replies, saved replies). Cannot ban users,
  edit settings, run operator scripts, or grant/revoke roles.
- `admin` — full access; grants/revokes `mod` and `admin` from the
  user detail page. OAuth signups matching `ADMIN_EMAILS` are
  auto-admin.

**Admin UI.** `/admin` requires an OAuth sign-in with the `mod` or
`admin` role. Mods see the moderation surfaces — dashboard, queue,
single-comment view, saved replies, about; everything else (users,
audit, subscriptions, operator, settings, webhooks, usage) is
admin-only. Server-rendered HTML + Alpine.js, no SPA.

Pages (top nav):

| Path | Purpose |
| --- | --- |
| `/admin` | Dashboard: counts, 30-day comments-per-day sparkline, oldest pending, spam-rate, top posts/commenters. |
| `/admin/queue` | Moderation queue. Status tabs + filter bar (body search, post slug, date range, scoped-by-user). Per-row + bulk actions (Approve/Spam/Delete/Restore). Each row shows author identity (avatar + provider + admin/banned pills) and the latest audit footer. |
| `/admin/comments/:id` | Single-comment view: parent + replies, raw markdown, spam-verdicts per source, full audit history for that comment, author block with their last 5 comments. |
| `/admin/users` | User search + ban toggle. |
| `/admin/users/:id` | User detail: all their comments paginated, reactions received, audit history affecting them, Ban/Unban. |
| `/admin/audit` | Audit log with filter form (admin, action, target kind/id, date range). |
| `/admin/subscriptions` | Email subscription list. Filter by email/post/confirmed/unsubscribed. Actions: manual unsubscribe, resend confirmation. |
| `/admin/operator` | Batch operations: rerender stale comments (POSTs `/admin/api/ops/rerender` in 50-row chunks until done), seed-demo (idempotent; gated to `ENV != "production"`), and the Disqus import upload (see below). |
| `/admin/settings` | Read-only view of anti-spam + email config; edits still go through `wrangler secret put`. |
| `/admin/webhooks` | Outbound webhook endpoints: add/pause/delete, per-endpoint secret + event filter, adapter (`generic` / `slack` / `discord`), failure counts and retry status. |
| `/admin/saved-replies` | Moderator saved replies: create/edit canned responses, private or shared scope, postable onto a comment from the queue. |
| `/admin/usage` | Cloudflare analytics (requests, comments by domain). Requires `CF_API_TOKEN` + `CF_ACCOUNT_ID`; renders setup instructions when unset. |

State-changing endpoints (all under `/admin/api/...`, all require admin
session + Origin allowlist, all write an `audit_log` row before
responding):

- `POST /admin/api/comments/:id` — `{action: approve|spam|delete|restore, reason?}`
- `POST /admin/api/comments/bulk` — `{ids: string[], action}` (cap 100)
- `POST /admin/api/users/:id` — `{banned: boolean, reason?}`
- `POST /admin/api/subscriptions/:id` — `{action: unsubscribe|resend, reason?}`
- `POST /admin/api/ops/rerender` — `{batch?: number, cursor?}` → `{processed, next_cursor}`
- `POST /admin/api/ops/seed-demo` — disabled when `ENV=production`

**Outbound webhooks.** Configured on `/admin/webhooks` (table-backed;
the legacy `WEBHOOK_URL` env var still works only while no endpoint
rows exist). Per endpoint: target URL (validated against an SSRF
blocklist — private IPs, localhost, internal TLDs are rejected),
optional HMAC secret, event filter (`comment.posted` / `edited` /
`deleted` / `approved` / `spam`; empty = all), and an adapter that
shapes the body (`generic` JSON, `slack`, or `discord` — the chat
adapters neutralize `@everyone`-style mentions and truncate long
bodies). Secured endpoints sign every request Stripe-style:

```
X-Garrul-Signature: t=<ms-epoch>,v1=<hex(hmac_sha256(secret, ts + "." + body))>
```

Receivers should reject signatures whose `t` is outside roughly ±5
minutes of their own clock — verification recipe in `docs/webhooks.md`.
Failed deliveries retry on a backoff schedule (1 min, 5 min, 30 min,
2 h, 6 h, then give up), re-signed with a fresh timestamp each attempt;
bodies over 64 KB skip the retry queue (logged, inline attempt still
made). An endpoint that fails 10 consecutive times auto-disables —
re-enable it from the admin page after fixing the receiver.

**Saved replies.** Canned moderator responses, managed on
`/admin/saved-replies`. Each reply is owned by its author and scoped
`private` (only the owner sees it) or `shared` (every mod/admin sees
it). The queue's reply box offers a picker; posting one inserts it as a
regular comment from the moderator's identity.

**Disqus import.** Two entry points, both idempotent (deduplicated by
Disqus comment ID, tracked in `0009_import_tracking.sql`; re-running
the same export inserts zero rows):

- CLI (preferred for big exports):
  `npm run import-disqus -- ./export.xml --dry-run`, then without
  `--dry-run` to commit.
- Admin upload on `/admin/operator` — capped at 50 MB, with dry-run /
  include-deleted / include-spam toggles.

Imported HTML is stripped and re-rendered through the standard
markdown allowlist. Imported authors become `provider='anon'` ghost
users whose `provider_id` is an HMAC (keyed by `IP_HASH_SECRET`) of
the Disqus author identity, keeping their display names without
storing emails.

**Custom domains.** Strongly recommended. Set in `wrangler.toml`:

```toml
routes = [
  { pattern = "comments.yourdomain.com", custom_domain = true }
]
```

`custom_domain = true` requires the apex zone on Cloudflare DNS.
Wrangler provisions the proxied subdomain on first deploy (first cert
issuance ~30 seconds). Don't use `*.workers.dev` in production —
third-party-cookie blocking in Safari/Brave breaks sign-in.

## 11. Backups and data export

D1 is the only durable store. KV holds rate-limit counters, OAuth state
(short TTL), sessions (30-day TTL), and the tree cache (rebuildable).

**D1 export.** `npm run db:export` wraps `bash scripts/db-export.sh`,
writing a `.sql` dump locally. Cloudflare also keeps point-in-time
backups of D1 in the dashboard — the local export is for the operator's
own archive (e.g. nightly cron on their workstation). For programmatic
exports beyond `.sql`, use `wrangler d1 export <db>`.

**KV considerations.** Don't bother backing up KV: `RATE_LIMITS` is
ephemeral; `OAUTH_STATE` has a 10-minute TTL; `SESSIONS` loss just
forces re-sign-in; `TREE_CACHE` rebuilds on next read.

## 12. Upgrades

`npm run upgrade` is the one entry point. It pulls the latest tag,
compares your live deployment against the target version's
`release-manifest.json`, and applies the difference.

```bash
npm run upgrade               # interactive: print plan, ask, apply
npm run upgrade -- --dry-run  # print plan, change nothing
npm run upgrade -- --yes      # non-interactive (CI)
npm run upgrade -- --version v0.2.0   # target a specific tag
```

The 12 steps (each prints `→ name… OK`):

1. **Preflight** — `wrangler --version` ≥ 4, clean working tree (unless `--allow-dirty`)
2. **Resolve target** — `--version vX.Y.Z` or GitHub latest release; exit 0 if already there
3. **Fetch manifests** — local from disk, remote from `raw.githubusercontent.com`; refuses if `target.minPreviousVersion > current`
4. **Drift detection** (read-only): secrets via `wrangler secret list`; KV/D1 by parsing `wrangler.toml`; migrations via `SELECT name FROM _migrations`; renderer via `CURRENT_RENDERER_VERSION` vs `target.renderer.version`
5. **Print plan** grouped as config drift / migrations / breaking changes
6. **Confirm** (`Proceed? [y/N]`) unless `--yes`
7. **Checkout** the target tag
8. **`npm ci`**
9. **Apply infra drift** — create missing KV/D1 and append blocks to `wrangler.toml`; prompt for missing secrets via `wrangler secret put NAME`
10. **Migrate** (`npm run migrate -- --remote`) — idempotent, forward-only
11. **Deploy** (`npm run deploy`)
12. **Post-deploy** — optional rerender; append a line to `.garrul-upgrade-log.json` (gitignored, operator-local)

### Release manifest

Each tagged release ships `release-manifest.json` declaring what the
version requires:

| Field                | What it pins                                                |
| -------------------- | ----------------------------------------------------------- |
| `version`            | The release version (matches `package.json`)                |
| `minPreviousVersion` | Refuse upgrades from an instance older than this            |
| `renderer.version`   | Current `CURRENT_RENDERER_VERSION`                          |
| `renderer.eagerRerender` | If `true`, the orchestrator runs the rerender by default |
| `secrets[]`          | Each `wrangler secret` name + `required` flag               |
| `kvNamespaces[]`     | Each KV binding name                                        |
| `d1Databases[]`      | Each D1 binding + database name                             |
| `analyticsDatasets[]` | Workers Analytics Engine datasets                          |
| `migrations[]`       | List of `NNNN_*.sql` files in `src/db/migrations/`          |
| `breakingChanges[]`  | Free-text entries with `summary` + `manualSteps`            |

The committed manifest is generated by
`npm run manifest:build` and validated in CI by `npm run manifest:check`,
which fails if the source tree drifts from the declared contract.

### Failure modes

- **Steps 1–9 fail** → nothing committed, exit 1.
- **Migrate succeeds, deploy fails** → exit code **2**. Migrations are
  forward-only and already applied; the previous Worker is still
  serving traffic. Fix the deploy and re-run `npm run deploy`, or
  `wrangler rollback` to the prior deployment. Do **not** hand-revert
  the schema — Garrul migrations are additive.
- **Deploy succeeds, rerender fails** → warn only; the renderer is
  lazy-on-read, so stored comments still resolve correctly.

**Migration ordering.** Always migrate **before** deploying new Worker
code. The orchestrator enforces this. If you step through manually:
new code may query new columns, so a deploy ahead of a migration will
500 until the migration runs.

### Manual fallback

If you'd rather not use the orchestrator (or you're working around a
specific issue):

```bash
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run migrate -- --remote
npm run deploy
npm run rerender -- --remote   # only if the renderer version bumped
```

Back up first — see §11.

### Update notifications

The admin UI shows a dismissible banner when GitHub reports a newer
release. Dismissal is per-version (localStorage), so the banner
reappears for each new tag. The check is cached in KV for 24h
(`meta:latest-release` in `TREE_CACHE`); a transient GitHub failure
caches a null marker for 1h to avoid hammering the API. Set the
optional `GITHUB_TOKEN` secret if you hit GitHub's 60/hr unauth rate
limit on shared Cloudflare egress IPs.

## 13. Troubleshooting

The top operator-side failures, in rough order of frequency:

**403 `err.origin.forbidden` on every embed request.** The embedder's
origin is missing from `ALLOWED_ORIGINS`. Add it (exact scheme + host,
no path, no trailing slash) and re-deploy. See section 6 for the curl
recipe. Usually a typo (`http://` vs `https://`, `www.` vs no-www) or
a forgotten staging origin.

**Turnstile challenge always fails.** Either the site key is wired to
the wrong hostname (Turnstile binds site key → hostname; the hostname
is the **blog**, not the Worker), or `TURNSTILE_SECRET` is unset on
the Worker. Verify with `wrangler secret list`. In local dev, use the
"always passes" test keys from `.dev.vars.example`.

**OAuth redirect mismatch.** Provider redirects back with
`redirect_uri_mismatch`. The URI registered with the provider must
match `OAUTH_CALLBACK_BASE/api/v1/auth/<provider>/callback` byte for
byte: same scheme, same host, no extra path, no trailing slash. GitHub
allows one callback per app — register two for staging + prod. Google
allows multiple authorized redirect URIs.

**Cookies not setting in third-party context.** User signs in but the
widget still shows "Sign in." The session cookie is `SameSite=None;
Secure; HttpOnly; Partitioned`. Required: both embedding site and
Worker served over HTTPS (`http://` anywhere kills the `Secure`
cookie); Worker on a real subdomain, not `*.workers.dev` (partitioning
behaves differently on the shared eTLD); the browser hasn't hard-blocked
third-party cookies (Brave Strict, hardened Firefox ETP). The
popup → top-level redirect fallback handles the common Safari ITP
case, but a hard-block user may simply not be able to sign in.

**Migrations applied locally but not remotely.** First deploy 500s on
every request; logs show `no such table: comments`. Run
`npm run migrate -- --remote`. `--remote` is mandatory for production;
`setup.sh` only touches the Miniflare local DB.

**`Host` header mismatch behind a proxy.** If the Worker sits behind a
non-Cloudflare proxy that rewrites `Host`, the `/AGENTS.md` route
substitutes the wrong host into embed snippets. Set `CANONICAL_URL`
in `wrangler.toml` (section 5).

**Email digests never arrive.** Check, in order: `EMAIL_PROVIDER` is
`resend`; `RESEND_API_KEY` is set; `EMAIL_FROM` uses a Resend-verified
domain; `wrangler.toml` has the `[triggers]` block; `wrangler tail`
shows `email.send_failed` with the underlying Resend error.

**`*.workers.dev` in production.** Works just enough to be tempting,
then breaks sign-in for Safari/Brave users. Map a custom subdomain
(section 10).

For deeper failure modes see `docs/troubleshooting.md`. For embed-side
issues (widget mount, CSP, slug derivation) the user should consult
`AGENTS.md` instead — those concerns belong on the integrator side.
