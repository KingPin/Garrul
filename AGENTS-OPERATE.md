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
   → `{"ok":true,...}`.

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
| `WEBHOOK_URL` | secret | Optional fire-and-forget POST URL on new comment events. | `https://example.com/hook` | `wrangler secret put` / `.dev.vars` |

Bindings (D1, KV, Analytics) live in `wrangler.toml` outside `[vars]`
and are populated by `./scripts/setup.sh`. Don't edit binding IDs by
hand once a deploy has used them.

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
tracked by the `_migrations` table. Current: `0001_init.sql`,
`0002_notifications.sql`. Run with `npm run migrate` (local Miniflare)
or `npm run migrate -- --remote` (production D1). Idempotent. Never
edit a migration after it's applied to prod — add new behavior as a new
numbered file.

**Admin UI.** `/admin` requires an OAuth sign-in whose email is in
`ADMIN_EMAILS`. Shows the moderation queue (flagged + new comments)
and basic user management. Server-rendered HTML + Alpine.js, no SPA.

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
ephemeral; `OAUTH_STATE` has sub-minute TTL; `SESSIONS` loss just
forces re-sign-in; `TREE_CACHE` rebuilds on next read.

## 12. Upgrades

Standard flow:

```bash
git pull
npm install
npm run migrate -- --remote   # only if new migration files landed
npm run deploy
```

Diff `src/db/migrations/` between the old and new commit to know
whether a remote migration is required. Migrations are forward-only —
no `down.sql`. If a deploy fails after migrations land, roll the Worker
back by re-deploying the previous commit; the new schema stays in place
(it's additive).

**Renderer version bumps.** If a release bumps `CURRENT_RENDERER_VERSION`
in `src/lib/markdown.ts`, stored comments are re-rendered lazily on
read. Force eager re-render with `npm run rerender` — walks every
comment, re-runs the current renderer against `body_md`, writes back
`body_html` + `renderer_version`. Idempotent. Run after deploy, not
before.

**Migration ordering.** Always migrate **before** deploying new Worker
code. New code may query new columns; if the deploy lands first,
requests 500 until the migration finishes.

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
