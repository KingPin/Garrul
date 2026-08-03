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
   `TREE_CACHE`), pastes their IDs into `wrangler.toml`, generates
   `JWT_SECRET` + `IP_HASH_SECRET` straight into Cloudflare (never
   written to disk), then offers two ways to set the rest: **bulk**
   (fill in a copy of `secrets.example.env`, upload with
   `wrangler secret bulk`) or **one prompt per secret**. Skip anything
   you don't have yet — `wrangler secret put NAME` works later.
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
  anything sensitive. `wrangler secret bulk FILE` sets many at once
  from a dotenv file; `secrets.example.env` is the committed template.
- **`.dev.vars`** — local-only equivalent for `wrangler dev`.
  Gitignored. Template is `.dev.vars.example`.

Two things about `wrangler secret bulk` are worth knowing before you
reach for it. An **empty value uploads an empty secret** rather than
skipping the name, so an uncommented `RESEND_API_KEY=` blanks a live
key — leave unused lines commented. And a file whose lines are *all*
commented parses to `{}` and is rejected outright, which is why the
committed template ships fully commented: an unedited copy fails loudly
instead of wiping four secrets.

`wrangler.example.toml` carries a `[secrets] required` block listing the
four always-needed secrets (`JWT_SECRET`, `IP_HASH_SECRET`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`) — **commented out by default.**
Uncommented, a deploy that would leave one unset fails rather than
shipping a Worker that 500s on first request.

**Two of those four are checked again at runtime.** `JWT_SECRET` and
`IP_HASH_SECRET` are load-bearing for the whole Worker — the first signs the
OAuth state payload, the second is the HMAC key behind every `ip_hash` — and
neither has a "feature is off" mode. If either is unset or empty, the Worker
refuses every request with `500 {"error":"server_misconfigured"}` and writes
one line naming the missing secrets:

```
{"level":"error","msg":"config.missing_required_secrets","missing":["IP_HASH_SECRET"]}
```

The names are in the log, not in the response body — `wrangler tail` to see
them. This replaces what used to happen: an empty HMAC key makes WebCrypto
throw, so the instance served anonymous 500s with stack traces from eight
different endpoints and nothing pointing at the cause.

Turnstile deliberately isn't in that runtime check even though the deploy-time
block lists it. An instance that only accepts OAuth-authenticated comments
works fine without it, and anonymous posts already fail closed — hard-failing
would take such a deployment offline on upgrade over configuration it never
needed. Implementation: `src/lib/require-config.ts`.

Uncomment it only in a config you never run `wrangler dev` against.
Declaring a `[secrets]` table changes how wrangler reads `.dev.vars` for
the whole file: only names in `required` (or already in `[vars]`) are
bound, and every other secret in `.dev.vars` is dropped — silently, with
no warning and no entry in the startup bindings banner. Verified against
wrangler 4.115.0 (`getVarsForDev`): with a two-key `.dev.vars` and
`required = ["REQ_ONE"]`, only `REQ_ONE` binds; remove the table and both
bind. Live, that would cost local dev the other 19 secrets — every OAuth
pair, `RESEND_API_KEY`, `AKISMET_*`, `TELEGRAM_*`, `CF_API_TOKEN`,
`GITHUB_TOKEN` — which is exactly the set `.dev.vars.example` tells you
to fill in.

Listing all 23 names instead is not a way out: wrangler hard-fails the
deploy on any unset name in `required`, so a GitHub-only install could no
longer ship.

**All of these lists are generated.** `scripts/config-registry.ts` is
the single source of truth for every environment name Garrul reads;
`npm run config:build` regenerates `secrets.example.env`,
`.dev.vars.example`, the `setup.sh` prompt lists, the generated regions
of `wrangler.example.toml`, and the table below. `npm run config:check`
fails CI when any of them drifts, and `npm run manifest:build` derives
`release-manifest.json` from the same array. Adding a setting means
editing `Bindings` in `src/index.ts` *and* the registry — a mismatch
between the two is a build error, not a silent misclassification.

<!-- BEGIN:config-table -->
<!-- Generated by `npm run config:build` from scripts/config-registry.ts. Do not edit by hand. -->

| Name | Type | Purpose | Example | Where to set |
|---|---|---|---|---|
| `ENV` | var | Switches dev affordances (CORS open, cookies `SameSite=Lax`). Production must be `production`. | `production` | `wrangler.toml` |
| `ALLOWED_ORIGINS` | var | Comma-separated origins allowed to embed + call `/api/*`. Doubles as the CSRF `Origin` allowlist. See section 6. | `https://yourblog.example.com` | `wrangler.toml` — **replace the shipped placeholder before deploying** |
| `ADMIN_EMAILS` | var | Comma-separated emails. OAuth signups matching get auto-admin. | `you@example.com` | `wrangler.toml` — **replace the shipped placeholder before deploying** |
| `EDIT_WINDOW_MINUTES` | var | Minutes a commenter can edit their own post. Default 15; `0` disables editing. | `15` | `wrangler.toml` default; **Admin → Settings** overrides |
| `PUBLIC_BASE_URL` | var | Public URL of the Worker; used in permalinks + email bodies. | `https://comments.example.com` | `wrangler.toml` — **replace the shipped placeholder before deploying** |
| `CANONICAL_URL` | var | Optional. Override for the public URL used by the `/AGENTS.md` route when the inbound `Host` differs from the canonical address. | `https://comments.example.com` | `wrangler.toml` |
| `OAUTH_CALLBACK_BASE` | var | Base URL for OAuth callbacks; must match the URI registered with each provider. Usually identical to `PUBLIC_BASE_URL`. | `https://comments.example.com` | `wrangler.toml` — **replace the shipped placeholder before deploying** |
| `BRANDING_HIDDEN` | var | Optional. Set to `1`/`true` to suppress the "Powered by Garrul" attribution under the comment list. Unset = attribution shown. | `false` | `wrangler.toml` |
| `JWT_SECRET` | secret | HMAC-SHA-256 key for the signed OAuth state cookie (`src/lib/oauth.ts`). Required for sign-in to work at all. Rotating it invalidates any OAuth flow already in progress — users retry and it works; no other effect, since sessions are KV-backed and not signed with this. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `IP_HASH_SECRET` | secret | HMAC-SHA-256 pepper for IP hashing (see `src/lib/ip-hash.ts`). Never log/store raw IPs. Tier-1 secret: with it, a D1 export discloses every commenter's IPv4 address, so guard it like `JWT_SECRET`. Rotating invalidates existing rate-limit and dedupe buckets, orphans anonymous ghost identities, and does **not** re-key hashes already stored — read `docs/ip-hashing.md` before rotating. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SITE_KEY` | secret | Cloudflare Turnstile site key. Required for anonymous commenting. Note this value is *public* — it ships in the widget HTML. It is stored as a secret for historical reasons and because doing so is harmless. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SECRET` | secret | Turnstile secret. Server-side token verification. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `GH_CLIENT_ID` | secret | GitHub OAuth client ID. Required for GitHub sign-in. | `Iv1.abcdef...` | `wrangler secret put` / `.dev.vars` |
| `GH_CLIENT_SECRET` | secret | GitHub OAuth client secret. | `ghp_...` | `wrangler secret put` / `.dev.vars` |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth client ID. Required for Google sign-in. | `1234.apps.googleusercontent.com` | `wrangler secret put` / `.dev.vars` |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret. | `GOCSPX-...` | `wrangler secret put` / `.dev.vars` |
| `FACEBOOK_CLIENT_ID` | secret | Optional. Facebook OAuth client ID from developers.facebook.com. Required for Facebook sign-in. Added v1.13.0. | `1234567890123456` | `wrangler secret put` / `.dev.vars` |
| `FACEBOOK_CLIENT_SECRET` | secret | Optional. Facebook OAuth client secret. | `...` | `wrangler secret put` / `.dev.vars` |
| `TWITTER_CLIENT_ID` | secret | Optional. X (Twitter) OAuth 2.0 client ID from developer.x.com. Required for X sign-in; the provider slug stays `twitter`. Added v1.13.0. | `...` | `wrangler secret put` / `.dev.vars` |
| `TWITTER_CLIENT_SECRET` | secret | Optional. X (Twitter) OAuth 2.0 client secret. Note X returns no email — those users get a null email and no digest notifications. | `...` | `wrangler secret put` / `.dev.vars` |
| `DISCORD_CLIENT_ID` | secret | Optional. Discord OAuth client ID from discord.com/developers → OAuth2. Required for Discord sign-in. Added v1.13.0. | `...` | `wrangler secret put` / `.dev.vars` |
| `DISCORD_CLIENT_SECRET` | secret | Optional. Discord OAuth client secret. | `...` | `wrangler secret put` / `.dev.vars` |
| `EMAIL_PROVIDER` | var | Adapter selector. `resend` is the only v1 value. Unset disables sends. | `resend` | `wrangler.toml` |
| `EMAIL_FROM` | var | `From:` header for digest emails. Domain must be verified in the provider. | `Garrul <comments@example.com>` | `wrangler.toml` |
| `RESEND_API_KEY` | secret | Resend API key. Required when `EMAIL_PROVIDER=resend`. | `re_...` | `wrangler secret put` / `.dev.vars` |
| `WEBHOOK_URL` | secret | Legacy single-URL webhook (fire-and-forget, no retries). Only honored when no endpoints are configured on `/admin/webhooks` — prefer endpoint rows (signed, retried, per-event filters). | `https://example.com/hook` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_BOT_TOKEN` | secret | Optional. BotFather token enabling the Telegram operator bot. With only this set, outbound notifications work (add a `telegram` webhook endpoint with a chat id). Unset = feature off. See `docs/telegram.md`. | `123456789:AAH...` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Optional. Shared secret echoed in the `X-Telegram-Bot-Api-Secret-Token` header; required for inbound buttons/slash commands. Pass it to Telegram's `setWebhook` as `secret_token`. Unset = inbound rejected (fail closed). | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_BOT_USERNAME` | var | Optional. Bot `@username` (without `@`). When set, `/admin/telegram` renders a one-tap `t.me/<bot>?start=<code>` deep link instead of manual `/start` steps. | `YourGarrulBot` | `wrangler.toml` |
| `SPAM_PROVIDER` | var | Optional. Pluggable content classifier — `akismet` or `workers-ai`. Unset = no classifier. `workers-ai` also needs an `[ai]` binding. See `docs/ANTISPAM.md`. | `akismet` | `wrangler.toml` |
| `AKISMET_API_KEY` | secret | Optional. Akismet API key. Required when `SPAM_PROVIDER=akismet`. | `...` | `wrangler secret put` / `.dev.vars` |
| `AKISMET_SITE_URL` | secret | Optional. Public site URL sent to Akismet alongside each check. Required when `SPAM_PROVIDER=akismet`. | `https://yourblog.example.com` | `wrangler secret put` / `.dev.vars` |
| `SPAM_FORM_TS_SECRET` | secret | Optional. HMAC key for signed form-timestamp tokens. Set when `SPAM_HONEYPOT_MIN_MS` is in use, otherwise the timing check cannot be trusted. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `SPAM_LINK_THRESHOLD` | var | Optional. Flag a comment to `pending` when it contains more than N URLs. Unset (or `-1`) = off; `0` flags any comment containing a link. Tripped signals never silently drop a comment — they route it to the admin queue. | `3` | `wrangler.toml` default; **Admin → Settings** overrides |
| `SPAM_HONEYPOT_MIN_MS` | var | Optional. Flag a comment to `pending` when the form was submitted faster than N milliseconds. Pair with `SPAM_FORM_TS_SECRET` — without it the timestamp is unsigned and the check is skipped. Unset or `0` = off. | `1500` | `wrangler.toml` default; **Admin → Settings** overrides |
| `SPAM_FIRST_COMMENT_MODERATE` | var | Optional. Route the first comment from any new author to `pending`. Unset = off. | `true` | `wrangler.toml` default; **Admin → Settings** overrides |
| `CF_ACCOUNT_ID` | var | Optional. Cloudflare account ID; paired with `CF_API_TOKEN` to enable the `/admin/usage` analytics page. | `0123abcd...` | `wrangler.toml` (or `wrangler secret put` — the in-app setup guide uses the secret form; both work) |
| `CF_API_TOKEN` | secret | Optional. Cloudflare API token for `/admin/usage`. Least-privilege scopes: Account.Analytics:Read, Account.D1:Read, Account.Workers KV Storage:Read. The page renders setup instructions when either value is unset. | `...` | `wrangler secret put` / `.dev.vars` |
| `GITHUB_TOKEN` | secret | Optional. Raises the GitHub API rate limit for the `/admin/*` "update available" check. Unauthenticated calls allow 60 req/hr per IP and Cloudflare egress IPs are shared across colos. Read-only `public_repo` scope is sufficient. | `ghp_...` | `wrangler secret put` / `.dev.vars` |
| `COMMENTS_ENABLED` | var | Master switch for new comment creation. Defaults **on**; set `0`/`false`/`no`/`off` to close commenting instance-wide (existing comments stay visible read-only, the widget shows a "Comments are closed." notice, and `POST /api/v1/comments` returns 403). | `true` | `wrangler.toml` |
| `REACTIONS_ENABLED` | var | Comment emoji reactions. Defaults **on**; same falsy-spelling semantics. Disabling hides the reaction bar and 403s `POST /api/v1/reactions`. | `true` | `wrangler.toml` |
| `VOTING_ENABLED` | var | Comment voting (up/down buttons in the widget). Defaults **on** when unset; set `0`/`false`/`no`/`off` to disable instance-wide. | `true` | `wrangler.toml` |
| `DOWNVOTES_ENABLED` | var | Downvote button. Same defaults-on semantics. Applies to **both** comment votes and page votes (a brigading-mitigation switch); independent of `VOTING_ENABLED`. | `true` | `wrangler.toml` |
| `PAGE_REACTIONS_ENABLED` | var | Article-level emoji reaction bar (react to the page itself, no comment). Defaults **off** so an upgrade never surfaces new UI unasked. Enables `POST /api/v1/page-engagement/reactions` and the widget bar. | `false` | `wrangler.toml` |
| `PAGE_VOTES_ENABLED` | var | Article-level "was this helpful?" up/down vote tally. Defaults **off**. Enables `POST /api/v1/page-engagement/votes`; downvotes here still honor `DOWNVOTES_ENABLED`. | `false` | `wrangler.toml` |
| `SHOW_DELETED_PLACEHOLDERS` | var | Keep deleted comments in the public tree as a placeholder (`[deleted]` / `[removed by a moderator]`) instead of pruning leaf deletions. Defaults **off** (current behavior: a deleted comment with live replies is still kept for thread continuity; a deleted leaf is dropped). Added v1.15.0. | `false` | `wrangler.toml` |
| `COMMENTS_PER_PAGE` | var | Top-level comments shown per initial load and per "Load older comments" click (server-side slice in `api.comments.ts`). Defaults **25**; clamped to `[1, 200]`. **Behavior change in v1.11.0:** older installs rendered up to 100 at once — set this to `100` to restore that. | `25` | `wrangler.toml` |
| `REPLIES_PER_THREAD` | var | Replies shown under each comment before a "Show N more replies" button (widget). `0` = show all. Defaults **3**; clamped to `[0, 100]`. | `3` | `wrangler.toml` |
| `AUTO_COLLAPSE_DEPTH` | var | Replies nested at this depth or deeper start collapsed in the widget. `0` = never auto-collapse. Defaults **3**; clamped to `[0, 4]` (the tree depth cap). | `3` | `wrangler.toml` |
| `AUTO_CLOSE_DAYS` | var | Close a thread this many days after its article was published (`posts.published_at`, else `created_at`). Evaluated lazily at read/write time — no cron. Defaults **0** (disabled). Existing comments, reactions and votes stay live. | `0` | `wrangler.toml` |
| `AUTO_CLOSE_AT` | var | Hard sunset — close **all** threads at/after this epoch-ms timestamp. Defaults **0** (disabled). The admin Settings page writes this via a date picker. | `0` | `wrangler.toml` |
| `COMMUNITY_MIN_VOTES` | var | Minimum total votes before `COMMUNITY_COLLAPSE_RATIO` applies — the brigading floor. Defaults **5**. | `5` | `wrangler.toml` |
| `COMMUNITY_COLLAPSE_RATIO` | var | Percent of downvotes/total that collapses a comment in the widget. Cosmetic and reversible — the reader can expand it. `0` = off, range `[0, 100]`. Requires `DOWNVOTES_ENABLED`. | `0` | `wrangler.toml` |
| `IP_HASH_RETENTION_DAYS` | var | Clear `comments.ip_hash` + `comments.user_agent` and `reports.reporter_ip_hash` once the row is this many days old, swept by the cron. `0` = off (the default — an upgrade never starts deleting data on its own). Range `[0, 3650]`, and the sweep refuses to run below **7** days so a fat-fingered `1` can't purge nearly everything. **Irreversible**: nothing reconstructs a cleared hash. Does *not* touch anonymous ghost `users.provider_id` — that column is the identity itself, so expiring it would delete the account rather than a hash. See `docs/ip-hashing.md`. | `0` | `wrangler.toml` |
<!-- END:config-table -->

Bindings (D1, KV, Analytics) live in `wrangler.toml` outside `[vars]`
and are populated by `./scripts/setup.sh`. Don't edit binding IDs by
hand once a deploy has used them.

### Feature flags: runtime overrides (since v1.10.0)

The eight feature flags — `COMMENTS_ENABLED`, `REACTIONS_ENABLED`,
`VOTING_ENABLED`, `DOWNVOTES_ENABLED`, `PAGE_REACTIONS_ENABLED`,
`PAGE_VOTES_ENABLED`, `SHOW_DELETED_PLACEHOLDERS`,
`SPAM_FIRST_COMMENT_MODERATE` — are **hybrid config**. The env vars above are only
the *defaults*. Each flag is resolved with the precedence:

```
DB settings row  >  env var  >  hardcoded default
```

Operators flip them at runtime from the **admin Settings page** (`/admin`
→ Settings), which writes a row to the `settings` D1 table — no redeploy,
no `wrangler` round-trip. "Reset to defaults" deletes the rows so the env
var / default applies again. The resolved set is KV-cached and busted on save,
so a toggle takes effect within seconds across the widget (`/api/v1/config`)
and the server-side gates. Leaving a flag untouched in the admin UI writes no
row, so existing installs that only set env vars are unaffected.
Implementation: `src/lib/settings.ts`.

**Changing one of these by env var instead takes up to an hour.** The cache TTL
is 1 hour (raised from 5 minutes: it's a fixed pair of KV keys that
re-populate once per TTL window *per edge colo*, against a free-tier cap of 1000
KV writes/day **account-wide** — at 5 minutes a handful of colos was spending
most of that budget re-deriving settings that hadn't changed). Only the admin
save path busts the cache; a `wrangler deploy` does not, so an edited
`wrangler.toml` var can be masked by a warm entry for up to an hour. Use the
Settings page for anything you want to take effect now, or accept the wait.

### Display & pagination: numeric settings (since v1.11.0)

`COMMENTS_PER_PAGE`, `REPLIES_PER_THREAD`, and `AUTO_COLLAPSE_DEPTH` follow the
**same hybrid precedence** as the feature flags (DB settings row > env var >
default) and are edited from the same **Settings → Display & pagination**
section. They're integers, each clamped to a `[min, max]` range server-side, so
a junk or hostile value (negative, or a `COMMENTS_PER_PAGE` large enough to
slice an enormous in-memory page) can never reach the slice/render paths —
out-of-range values clamp, non-numeric values fall back to the default.

- `COMMENTS_PER_PAGE` is consumed **server-side**: it drives the top-level
  slice in `GET /api/v1/comments` and is baked into the first-page edge-cache
  key (keyed by slug, sort, and size), so changing it never serves a
  stale-sized page. Both `sort=new` and `sort=top` paginate, so shrinking the
  page size never hides top-voted threads past the first page.
- `REPLIES_PER_THREAD` and `AUTO_COLLAPSE_DEPTH` are consumed **client-side**:
  the widget reads them from `/api/v1/config` and uses them purely for reply
  folding (no API/payload change — all replies still arrive in one response).

**Upgrade note:** installs upgrading to v1.11.0 that never set `COMMENTS_PER_PAGE`
will see **25** initial comments instead of the previous ~100. Set it to `100`
(env var or Settings page) to restore the old behavior.

### Thread lifecycle & community settings (since v1.17.0)

Four more integers, same hybrid precedence (DB settings row > env var > default)
and the same server-side clamping. All default to **off**, so an install that
ignores them behaves exactly as before.

- **Auto-close** — `AUTO_CLOSE_DAYS` (close a thread this many days after its
  anchor date; `0` = never) and `AUTO_CLOSE_AT` (an epoch-ms sunset that closes
  **every** thread at/after that instant; `0` = never). Closure is evaluated
  **lazily** at read/write time — there is no cron and nothing is persisted, so a
  thread "becomes" closed the moment a request observes the rule. The age anchor
  is the host page's real publish time when the embed supplies `data-published`
  (stored as `posts.published_at`); without it Garrul falls back to first-comment
  time, which is later than real publish, so set `data-published` if you rely on
  `AUTO_CLOSE_DAYS`. A closed thread hides the composer (the widget shows a
  reason-specific notice) and the POST endpoint rejects new comments **and
  replies** with `403 err.thread_closed` — existing comments, reactions, and
  votes stay live. Per-post manual close (below) overrides nothing here; it's a
  separate, higher-precedence input to the same resolver.
- **Community auto-collapse** — `COMMUNITY_COLLAPSE_RATIO` (percent of downvotes,
  `down/(up+down)`, that folds a comment; `0` = off) gated by
  `COMMUNITY_MIN_VOTES` (minimum total votes before the ratio applies; default
  `5`). The floor is the **brigading guard** — without it a single downvote would
  read as 100% and fold every fresh comment. Collapse is **client-side and
  cosmetic**: the widget folds the body behind a "show" toggle, the content stays
  in the payload, and votes stay live so a comment re-expands once its score
  recovers (on the next render). It's derived in the browser because votes
  deliberately don't bust the tree cache, so a server flag would be stale against
  the score the widget already shows. Requires `DOWNVOTES_ENABLED`.

### Edit window & anti-spam dials (since v1.22.0)

The last three integers to join the hybrid chain (DB settings row > env var >
default, server-side clamped), edited from **Settings → Moderation**.

- `EDIT_WINDOW_MINUTES` — minutes an author may revise their own comment.
  Clamped to `0`–`10080` (a week); `0` disables editing entirely (the widget
  hides the Edit affordance and `PATCH`/`GET :id/source` both 403). **Two
  behavior changes in v1.22.0:** the resolved default is now the documented
  **15** rather than the 5 minutes the code actually fell back to when the var
  was unset, and an explicit `0` means "no editing" instead of silently meaning
  5. Installs that set the var explicitly are unaffected — the ceiling is a week
  precisely so a pre-existing longer window isn't silently shortened.
- `SPAM_LINK_THRESHOLD` — clamped to `-1`–`50`. `-1` (the default, and where an
  unset or junk value lands) disables the check; `0` flags any comment carrying
  a link. The sentinel exists because this signal has always had three states —
  collapsing "off" onto `0` would have redefined what `0` does for anyone
  already running it.
- `SPAM_HONEYPOT_MIN_MS` — clamped to `0`–`60000`; `0` (default) = off. Still
  requires `SPAM_FORM_TS_SECRET`, which stays a secret: without it the form
  timestamp is unsigned and forgeable, so `evaluateSpam` skips the check and the
  `/api/v1/comments/form-token` endpoint 404s. The Settings page flags this
  combination inline rather than letting the dial sit there doing nothing.

`SPAM_PROVIDER`, `AKISMET_API_KEY`, `AKISMET_SITE_URL` and `SPAM_FORM_TS_SECRET`
stay **deploy-time**: the provider needs capability detection (`akismet` wants an
API key, `workers-ai` wants the `[ai]` binding) and a dropdown offering a
provider the deploy cannot serve is worse than an env var. Everything that can
lock an operator out — all secrets, `ENV`, `ALLOWED_ORIGINS`, `ADMIN_EMAILS`, and
the OAuth-redirect URLs — is deliberately excluded from runtime editing, because
DB > env means one bad admin save beats the declared config and the surface you'd
use to fix it is the one you just broke.

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

The three heuristics are runtime settings: the env vars below set the
deploy-time default, and **Admin → Settings → Moderation** overrides
them without a redeploy (DB row > env var > built-in default). Retune
them there while watching what the queue catches. `SPAM_PROVIDER` and
its credentials stay deploy-time.

- `SPAM_HONEYPOT_MIN_MS` + `SPAM_FORM_TS_SECRET` — flag submissions
  that arrive faster than wall-clock `N` ms after the form rendered.
  `0`/unset = off. Without the secret the timestamp is unsigned and the
  check is skipped.
- `SPAM_LINK_THRESHOLD` — flag comments containing more than `N`
  http(s)/mailto links. `-1`/unset = off; `0` flags any comment with a
  link.
- `SPAM_FIRST_COMMENT_MODERATE=true` — every commenter's first-ever
  comment goes to pending until you approve once.
- `SPAM_PROVIDER` — set to `akismet` or `workers-ai` to enable a
  content classifier (each has its own required secrets/bindings).

See [`docs/ANTISPAM.md`](./docs/ANTISPAM.md) for the full layer
breakdown, privacy tradeoffs (Akismet sends comment content off
Cloudflare; Workers AI keeps it on-network), and recommended starter
configs.

## 8. OAuth providers

Five providers ship: GitHub, Google, Facebook, X, and Discord (the
last three added in v1.13.0). Generic OIDC is v2 backlog. The operator
picks which to enable by setting the matching client ID + secret — a
provider with no credentials is simply omitted from the sign-in options.
If all are unset, the widget shows only the anonymous form.

Callback URL pattern (driven by `OAUTH_CALLBACK_BASE`):

```
<OAUTH_CALLBACK_BASE>/api/v1/auth/<provider>/callback
```

For `OAUTH_CALLBACK_BASE = https://comments.example.com`:

- GitHub: `https://comments.example.com/api/v1/auth/github/callback`
- Google: `https://comments.example.com/api/v1/auth/google/callback`
- Facebook: `https://comments.example.com/api/v1/auth/facebook/callback`
- X: `https://comments.example.com/api/v1/auth/twitter/callback`
- Discord: `https://comments.example.com/api/v1/auth/discord/callback`

Note the X provider slug is `twitter`, not `x` — it's the value stored
in `users.provider`, so renaming it would orphan existing rows.

**GitHub.** <https://github.com/settings/developers> → New OAuth App.
GitHub allows exactly one callback URL per app — register two apps for
staging + prod. Scopes: `read:user user:email`.

**Google.** <https://console.cloud.google.com/apis/credentials> →
Create Credentials → OAuth client ID → Web application. Multiple
authorized redirect URIs are allowed. Until the app is verified, only
consent-screen test users can sign in; verification takes 7-10 business
days.

**Facebook.** <https://developers.facebook.com/apps> → Create App →
add the Facebook Login product. Register the callback under Facebook
Login → Settings → Valid OAuth Redirect URIs. Scopes: `email
public_profile`. Apps stay in development mode (only app roles can sign
in) until you submit for App Review.

**X (Twitter).** <https://developer.x.com/en/portal/dashboard> → your
project → User authentication settings. Enable **OAuth 2.0**, app type
"Web App", and register the callback. Scopes: `tweet.read users.read`.
X's v2 API exposes no email under those scopes, so X users always get a
null email — which means no digest notifications for them (see the note
at `src/lib/oauth.ts:146`).

**Discord.** <https://discord.com/developers/applications> → New
Application → OAuth2 → add the callback under Redirects. Scopes:
`identify email`.

**Dev vs. prod redirects.** Either register a separate app per
environment, or add `http://localhost:8787/api/v1/auth/<provider>/callback`
as an additional redirect. GitHub and Google both permit HTTP localhost;
the other three vary. Provider policies on plain-HTTP redirects differ
and change over time —
if a provider rejects the localhost URI, register a separate dev app or
front local dev with an HTTPS tunnel.

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
new reply land (digest email); an unsubscribe-link click (opens a
confirmation page, no send). No transactional sends per comment;
everything flows through the debounced cron.

The unsubscribe link is a two-step flow: the `GET` from the email only
renders a "Yes, unsubscribe me" button, and the `POST` behind that
button does the write. Mail clients, link scanners and corporate
security gateways prefetch every URL in a message, so a `GET` that
wrote would silently unsubscribe recipients who never clicked. Expect
support questions from operators who remember one click; the extra
click is deliberate.

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
- `0010_settings.sql` — DB-backed runtime settings overrides
- `0011_page_engagement.sql` — page-level reactions + votes
- `0012_deleted_by.sql` — records who deleted a comment
- `0013_thread_lifecycle_reports.sql` — per-post close/`published_at` + reader `reports` table
- `0014_telegram.sql` — `telegram_links` (operator account ↔ Telegram identity, + digest opt-in)
- `0015_comment_depth.sql` — `comments.depth`, backfilled from `parent_id`; enforces the reply-depth cap at insert
- `0016_user_erasure.sql` — `users.erased_at`, for the admin erase-personal-data path
- `0017_subscriptions_email_index.sql` — `subscriptions(email, confirmed_at)`; the per-email pending cap was a full table scan on every subscribe

Run with `npm run migrate` (local Miniflare) or
`npm run migrate -- --remote` (production D1). Idempotent. Never edit a
migration after it's applied to prod — add new behavior as a new
numbered file. When upgrading an existing install, re-running
`npm run migrate -- --remote` applies whatever the new release added.

**Request size limit.** Every request body is capped at **64 KB** before
anything parses it; over that the response is `413 {"error":"too_large"}`. The
cap exists because all the per-field limits (comment length, name length, bulk
action id count) are applied *after* `c.req.json()` has already deserialized the
whole body, so without it a multi-megabyte payload costs a full parse against the
Worker's 10 ms CPU budget before any of them get a say. 64 KB is far above every
legitimate payload — the largest is a comment at the 10,000-character body limit.
The one exemption is `POST /admin/api/ops/import-disqus`, which takes a raw
Disqus XML export up to 50 MB and enforces its own limit. Implementation:
`src/lib/body-limit.ts`.

**Client IP is required, not guessed.** Every endpoint that meters or dedupes
by IP — comments, votes, reactions, reports, page engagement, subscribe,
preview — reads Cloudflare's `cf-connecting-ip` header. The edge sets it on
every request that reaches a Worker, so its absence means the Worker was
reached some other way; those requests now get `400 {"error":"no_client_ip"}`.
Previously they were all folded into a literal `0.0.0.0`, which is worse than
no answer: a *shared* identity means one rate-limit bucket, one anonymous
ghost user, and one row against the per-comment report and vote uniqueness
constraints for every such caller at once. Under `ENV=dev` the Worker
substitutes `127.0.0.1` so local development still exercises the path.
Implementation: `src/lib/ip-hash.ts`.

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
| `/admin/queue` | Moderation queue. Status tabs (incl. a **Reported** tab — comments with open reader reports, with a count badge) + filter bar (body search, post slug, date range, scoped-by-user). Per-row + bulk actions (Approve/Spam/Delete/Restore). When filtered to a single post slug, a **Close / Open comments for this post** toggle appears. Rows also offer one-click **Ban author**. Each row shows author identity (avatar + provider + admin/banned pills) and the latest audit footer. |
| `/admin/comments/:id` | Single-comment view: parent + replies, raw markdown, spam-verdicts per source, full audit history for that comment, author block with their last 5 comments. |
| `/admin/users` | User search + ban toggle. |
| `/admin/users/:id` | User detail: all their comments paginated, reactions received, audit history affecting them, Ban/Unban, role controls, and a folded-away **Erase personal data** panel (admin-only; see below). |
| `/admin/audit` | Audit log with filter form (admin, action, target kind/id, date range). |
| `/admin/subscriptions` | Email subscription list. Filter by email/post/confirmed/unsubscribed. Actions: manual unsubscribe, resend confirmation. |
| `/admin/operator` | Batch operations: rerender stale comments (POSTs `/admin/api/ops/rerender` in 50-row chunks until done), seed-demo (idempotent; gated to `ENV != "production"`), and the Disqus import upload (see below). |
| `/admin/settings` | Editable form for feature flags, display/pagination numbers, and the moderation dials (edit window, thread auto-close, community auto-collapse, the three anti-spam heuristics), saved to the `settings` D1 table (no redeploy — see section 5). Also renders a read-only `(set)`/`(unset)` summary of deploy-time config (Turnstile, email, OAuth, spam provider), which still changes via `wrangler secret put` / `wrangler.toml`. |
| `/admin/webhooks` | Outbound webhook endpoints: add/pause/delete, per-endpoint secret + event filter, adapter (`generic` / `slack` / `discord` / `telegram`), failure counts and retry status. |
| `/admin/telegram` | **Admin-only.** Telegram operator bot: shows whether the bot token/webhook secret are set, links your personal Telegram account (one-time code or deep link), toggles the daily digest, and unlinks. See `docs/telegram.md`. |
| `/admin/saved-replies` | Moderator saved replies: create/edit canned responses, private or shared scope, postable onto a comment from the queue. |
| `/admin/usage` | Cloudflare analytics (requests, comments by domain). Requires `CF_API_TOKEN` + `CF_ACCOUNT_ID`; renders setup instructions when unset. |

State-changing endpoints (all under `/admin/api/...`, all require admin
session + Origin allowlist, all write an `audit_log` row before
responding):

- `POST /admin/api/comments/:id` — `{action: approve|spam|delete|restore, reason?}`
- `POST /admin/api/comments/bulk` — `{ids: string[], action}` (cap 100)
- `POST /admin/api/comments/:id/reports/resolve` — clears open reader reports on a comment (audited `report.resolve`)
- `POST /admin/api/posts/close` — `{slug, closed: boolean}` (per-post close/open; audited `post.close` / `post.open`; busts the cached first page)
- `POST /admin/api/users/:id` — `{banned: boolean, reason?, from_comment?}` (one-click ban-author records the originating comment in audit meta; admin-only)
- `POST /admin/api/users/:id/role` — `{role: user|mod|admin, reason?}` (admin-only; refuses self-change and the last-admin demotion)
- `POST /admin/api/users/:id/erase` — `{confirm: "ERASE", redact_bodies: boolean, reason?}` (admin-only, irreversible; see below)
- `POST /admin/api/subscriptions/:id` — `{action: unsubscribe|resend, reason?}`
- `POST /admin/api/ops/rerender` — `{batch?: number, cursor?}` → `{processed, next_cursor}`
- `POST /admin/api/ops/seed-demo` — disabled when `ENV=production`

**Erasing a user's personal data.** `/admin/users/<id>` → **Erase
personal data**. Admin-only, audit-logged, and irreversible — the button
stays disabled until you type `ERASE`, and the API requires the same
string in the body so a stray request can't trigger it.

It anonymizes in place rather than deleting. `comments.user_id` is a
`NOT NULL` foreign key and threads are `parent_id` chains, so dropping
the row would orphan every reply written under it. What it clears:

- The account's `name` (→ `[deleted]`), `email`, `avatar_url` and
  `provider_id`. That last one is the handle their next login is matched
  on — so a later sign-in creates a **fresh** account instead of
  resurrecting this one. For an anonymous ghost author, `provider_id`
  *is* the `ip_hash`.
- `ip_hash` and `user_agent` on every comment they wrote, and
  `reporter_ip_hash` on every report they filed.
- Their email subscriptions (plus any queued digest rows) and their
  linked Telegram account.
- Their live sessions, revoked.

Comment **bodies are kept by default**: the author becomes anonymous and
the thread others replied to stays readable. Tick *"also blank their
comment bodies"* when the comment text itself holds the personal data —
that blanks `body_md`/`body_html` and marks the comments deleted. Votes,
reactions and page-engagement rows are left alone; removing them would
silently restate scores the thread has been showing.

Two guards: you cannot erase **yourself**, and you cannot erase another
**admin** (demote them first — otherwise clearing `provider_id` locks
that person out of the instance for good). The `user.erase` audit row
records **counts only**, never the removed values: writing the name or
address into `audit_log.meta` would relocate the data rather than erase
it. Everything else you might want here — a retention window, key
epoching, a bulk purge — is still missing; see
[`../docs/ip-hashing.md`](../docs/ip-hashing.md).

**Reader reporting & thread moderation.** Readers can flag a comment
from the widget (anonymous allowed, no Turnstile — rate-limited by
network and deduped one-per-network-per-comment, storing only an
`ip_hash`, never a raw IP). Each new report fires a `comment.reported`
webhook so operators get a Slack/Discord ping, and the comment surfaces
in the queue's **Reported** tab with a count badge; the comment detail
page lists the reasons. Dismiss the flags with **resolve** (the comment
itself is still actioned with the normal approve/spam/delete buttons).
Report counts are operator-only — they're never in the public payload,
so they can't be used as a brigading signal.

Per-post **close** freezes one thread: existing comments, reactions and
votes stay live, but new comments and replies are rejected server-side
(`403 err.thread_closed`) regardless of what the widget shows. Closure
is also driven globally without touching individual posts via
`AUTO_CLOSE_DAYS` / `AUTO_CLOSE_AT` (see §5) — all evaluated lazily at
read/write time, no cron, no row migration.

One-click **Ban author** reuses the user-ban mechanism. For an
anonymous (ghost) author this is a *network-egress* ban keyed on the
author's `ip_hash`, so behind CGNAT or a shared IP it can catch
bystanders — the action confirms before banning. The originating
comment id is recorded in the audit row's `meta.from_comment`.

**Outbound webhooks.** Configured on `/admin/webhooks` (table-backed;
the legacy `WEBHOOK_URL` env var still works only while no endpoint
rows exist). Per endpoint: target URL (validated against an SSRF
blocklist — private IPs, localhost, internal TLDs are rejected),
optional HMAC secret, event filter (`comment.posted` / `edited` /
`deleted` / `approved` / `spam` / `reported`; empty = all), and an adapter that
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
  `IP_HASH_SECRET=... npm run import-disqus -- ./export.xml --dry-run`,
  then without `--dry-run` to commit.
- Admin upload on `/admin/operator` — capped at 50 MB, with dry-run /
  include-deleted / include-spam toggles.

Imported HTML is stripped and re-rendered through the standard
markdown allowlist. Thread titles and links go through the same
guards the comment write path applies — control characters stripped
and the title capped (it reaches mail subject lines), and a link that
isn't `http(s):` is stored as no URL rather than becoming a permalink
redirect target. Imported authors become `provider='anon'` ghost
users whose `provider_id` is an HMAC (keyed by `IP_HASH_SECRET`) of
the Disqus author identity, keeping their display names without
storing emails.

**`IP_HASH_SECRET` is required for the CLI, and must be the same
secret the Worker uses.** It keys the ghost-identity HMAC above, so a
different value imports the same person as a different user — and the
same person commenting live afterwards becomes a third. The script
used to fall back to a hard-coded literal when the variable was
unset; it now refuses to run. Read the value from `.dev.vars` for a
local import, or from wherever you stored it for `--remote`. The
admin upload path takes it from the Worker's own binding, so it is
unaffected.

The CLI drives D1 through `wrangler d1 execute`, which accepts only
`--command` — there is no parameter-binding flag, so that shim
assembles SQL by substitution (the Worker path binds normally). It
refuses any value it can't inline exactly rather than emitting
approximately-right SQL, and aborts the import if wrangler's output
can't be read — previously an unreadable envelope was treated as "row
already exists", which made the whole CLI import a silent no-op that
still printed `DONE`.

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

D1 is the only durable store. KV holds sessions (30-day TTL), widget
OAuth handoff tokens (60-second TTL), and rebuildable caches (resolved
settings, version check, optional Workers-AI spam verdicts). Rate-limit
counters and the comment first-page and counts caches live in the edge
Cache API (`caches.default`), not KV — so they never count against the
KV write budget.

**D1 export.** `npm run db:export` wraps `bash scripts/db-export.sh`,
writing a `.sql` dump locally. Cloudflare also keeps point-in-time
backups of D1 in the dashboard — the local export is for the operator's
own archive (e.g. nightly cron on their workstation). For programmatic
exports beyond `.sql`, use `wrangler d1 export <db>`.

The output filename must match `garrul-backup-*.sql`; the script
exits 2 on anything else. That is the pattern `.gitignore` covers, and
the dump holds every comment body, every subscriber email address and
every `ip_hash` in the database — so a name like `backup.sql` in a
clone of this repo is one `git add -A` away from committing all of it.
A directory prefix is fine (`../backups/garrul-backup-nightly.sql`);
only the basename is checked. `npm run db:export` with no argument
picks a conforming name for you.

**KV considerations.** Don't bother backing up KV: `RATE_LIMITS` only
holds the optional Workers-AI spam verdict cache (rate limiting itself
runs on the Cache API); `OAUTH_STATE` holds 60-second widget handoff
tokens (OAuth state is a signed cookie, not a KV row); `SESSIONS` loss
just forces re-sign-in; `TREE_CACHE` rebuilds on next read.

### Hashed IPs in an export

A `.sql` dump carries every `ip_hash` the instance still holds. They land
in three places: `comments.ip_hash` (kept even after a soft delete),
`reports.reporter_ip_hash` (kept after the flags are resolved), and
`users.provider_id` for `provider='anon'` ghost rows, which is the
anonymous identity itself.

**How much history that is depends on `IP_HASH_RETENTION_DAYS`** (§5, or
Settings → Moderation). Off by default, in which case a dump carries every
hash the instance has ever written. Set to N days, a cron pass clears the
first two columns past that age, so a dump carries a bounded slice
instead. The third column is never swept on a timer — the ghost hash *is*
the account, so expiring it would delete anonymous identities rather than
hashes. Plan for an export to always contain the full ghost set.

Watch it work, and drain a backlog on demand, from `/admin/operator`.
Clearing a hash is irreversible, and it costs you the ability to spot a
ban evader on that network past the window.

The hash is a pseudonym only against someone who *doesn't* have
`IP_HASH_SECRET`. The construction is unsalted and IPv4 is a 2^32 input
space, so anyone holding both an export and the secret can rebuild every
address in it — treat the pair as an IP disclosure and store exports
accordingly. Rotating the secret re-keys future writes only; it does not
touch rows already written, and there is no key-version column to tell
the two apart afterwards. Key epoching is tracked as an enhancement, not
shipped.

Full posture, including what rotation breaks and what a deletion request
costs today: [`docs/ip-hashing.md`](docs/ip-hashing.md).

### Emergency purge: `IP_HASH_SECRET` leaked

If the secret is exposed — committed, pasted into a chat, or leaked
alongside a dump — rotating it does **nothing** for rows already written.
Those stay crackable with the leaked key forever. The only real fix is to
clear the stored values. Run this first, then rotate.

Order matters: purge before rotating. Rotation doesn't break the purge,
but it does mint new-key hashes for anyone who comments in between, and
you want the blast radius frozen while you work.

```bash
# 1. Snapshot first — this is irreversible and takes moderation history
#    with it. Keep the backup encrypted and off shared storage.
npm run db:export -- garrul-backup-pre-purge.sql

# 2. Purge. --remote hits production; drop it to rehearse against local.
npx wrangler d1 execute garrul-db --remote --command \
  "UPDATE comments SET ip_hash = NULL, user_agent = NULL WHERE ip_hash IS NOT NULL;"

npx wrangler d1 execute garrul-db --remote --command \
  "UPDATE reports SET reporter_ip_hash = NULL WHERE reporter_ip_hash IS NOT NULL;"

# 3. Anonymous ghost identities. See the warning below BEFORE running this.
npx wrangler d1 execute garrul-db --remote --command \
  "UPDATE users SET provider_id = NULL WHERE provider = 'anon' AND provider_id IS NOT NULL;"

# 4. Rotate the secret.
npx wrangler secret put IP_HASH_SECRET

# 5. Confirm nothing survived.
npx wrangler d1 execute garrul-db --remote --command \
  "SELECT (SELECT COUNT(*) FROM comments WHERE ip_hash IS NOT NULL) AS comments,
          (SELECT COUNT(*) FROM reports WHERE reporter_ip_hash IS NOT NULL) AS reports,
          (SELECT COUNT(*) FROM users WHERE provider = 'anon' AND provider_id IS NOT NULL) AS ghosts;"
```

Substitute your own `database_name` from `wrangler.toml` for `garrul-db`.

**Step 3 is the destructive one.** Clearing a ghost's `provider_id`
deletes the anonymous identity, not just a hash. Consequences, all
permanent:

- Every ghost-author **ban stops applying** to that network. Re-ban from
  a fresh comment if you need it to hold.
- **Vote, reaction and page-engagement dedup resets** for anonymous
  visitors — one identity per network becomes one identity per network
  *per future visit*.
- Returning anonymous commenters get **new ghost rows**; their old
  comments still render and still belong to the old rows.

Steps 1–2 are the ones that matter for the leak: they cover the bulk of
the exposure and cost you only the admin "other comments from this
network" panel on old comments. Step 3 closes the remaining gap and is
the right call if the export is genuinely in someone else's hands.
Skipping it is defensible if it isn't.

SQLite counts NULLs as distinct in a UNIQUE index, so
`UNIQUE (comment_id, reporter_ip_hash)` on `reports` and
`UNIQUE (provider, provider_id)` on `users` both survive the purge no
matter how many rows collapse to NULL. Nothing else in the schema keys on
these columns, so there are no orphans to clean up afterwards.

For a single person's data rather than the whole table, use **Erase
personal data** on `/admin/users/<id>` instead — admin-only,
audit-logged, and scoped to that user's rows.

`IP_HASH_RETENTION_DAYS` is not a substitute for any of this. It bounds
how much history a future leak exposes; it does nothing about hashes a
leaked key can already crack today. Setting it now is worth doing anyway —
it shrinks the next incident.

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
4. **Drift detection** (read-only): secrets via `wrangler secret list`; `[vars]`, KV and D1 by parsing `wrangler.toml`; migrations via `SELECT name FROM _migrations`; renderer via `CURRENT_RENDERER_VERSION` vs `target.renderer.version`
5. **Print plan** grouped as config drift / migrations / breaking changes
6. **Confirm** (`Proceed? [y/N]`) unless `--yes`
7. **Checkout** the target tag, then verify the `release-manifest.json` in
   the checked-out tree is byte-for-byte the one step 3 fetched — see
   *What the upgrade trusts* below
8. **`npm ci`**
9. **Apply infra drift** — create missing KV/D1 and append blocks to `wrangler.toml`; prompt for missing secrets via `wrangler secret put NAME`. Missing required `[vars]` block auto-apply: they must be added to `wrangler.toml` by hand
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
| `vars[]`             | Each `wrangler.toml` `[vars]` name + `required` flag        |
| `kvNamespaces[]`     | Each KV binding name                                        |
| `d1Databases[]`      | Each D1 binding + database name                             |
| `analyticsDatasets[]` | Workers Analytics Engine datasets                          |
| `migrations[]`       | List of `NNNN_*.sql` files in `src/db/migrations/`          |
| `breakingChanges[]`  | Free-text entries with `summary` + `manualSteps`            |

The committed manifest is generated by
`npm run manifest:build` and validated in CI by `npm run manifest:check`,
which fails if the source tree drifts from the declared contract. Both
`secrets[]` and `vars[]` come from `scripts/config-registry.ts` (§5).

`vars[]` arrived in v1.21.0. Before it, the generator classified any
`string` field in the `Bindings` type as a secret unless it appeared in
a hand-maintained allowlist, so 20 plain feature flags were recorded as
secrets. Manifests from tags at or below v1.20.0 have no `vars` key;
`upgrade` treats it as empty so those older manifests still parse.

The upgrade plan reports missing required `[vars]` separately from
secrets and never auto-applies them: secrets can be set
non-interactively, but `[vars]` live in `wrangler.toml`, which is the
operator's file and is never rewritten in place. It also lists
`[vars]` a new release introduced that you haven't set — all optional,
all defaulted, shown so a new flag isn't invisible.

### What the upgrade trusts

An upgrade ends in migrations against your production D1 and a
`wrangler deploy` with your Cloudflare credentials loaded. Worth knowing
exactly what has to be honest for that to be safe.

Three fetches, three different trust anchors:

| Fetch | Source | What it decides |
| --- | --- | --- |
| Target tag + release notes | `api.github.com` (HTTPS) | Which version you're going to |
| `release-manifest.json` | `raw.githubusercontent.com` at that tag (HTTPS) | The plan: which secrets are prompted for, which KV/D1 get created, which migrations are expected, whether a rerender runs |
| The code itself | the git transport (`git fetch` + `git checkout <tag>`) | Everything that actually gets deployed |

**Git is the anchor for what runs.** `npm run upgrade` never downloads a
release asset. It checks out the tag and builds from source, so the
Worker you deploy is whatever the git tag contains — the release page's
`embed.js` is not in that path at all.

**The plan and the code arrive over different transports**, which is the
gap the post-checkout check closes. Step 7 re-reads
`release-manifest.json` from the checked-out tree and compares it to the
one fetched in step 3. A mismatch aborts *before* the first migration —
the last cheap point to stop, since migrations are forward-only. The
error names the differing fields.

What that catches: a tag moved between the fetch and the checkout; a
stale or poisoned CDN response for the raw manifest; a fork whose tag
doesn't carry the upstream tree; a manifest that was simply never
regenerated for the release.

What it does **not** catch, and don't read it as more than it is: it is
**not a signature**. Whoever can rewrite the tag rewrites both copies and
they agree. Garrul does not ship signed tags today. Your real defenses
against a rewritten tag are the SHA-pinned actions in the release
workflow and reading the diff between your current tag and the target
before you say yes.

**Verifying a release asset by hand.** If you take `embed.js` from the
release page rather than building it, each release attaches `SHA256SUMS`
covering `embed.js`, `embed.js.map` and `release-manifest.json`:

```bash
# in a directory holding the downloaded assets and SHA256SUMS
sha256sum -c SHA256SUMS
```

That file is uploaded by the same publishing step that uploads the
artifacts, so on its own it proves only internal consistency. The
digests are *also* printed into the release workflow's job log (the
`SHA256SUMS` group), which is public, immutable, and written **before**
the publishing step runs. Compare against the job log, not just the
attached file, if you care about the difference.

### Failure modes

- **Steps 1–9 fail** → nothing committed, exit 1.
- **Manifest mismatch at step 7** → exit 1, before any migration or
  deploy. Re-run `npm run upgrade`; if it repeats, compare the tag
  against the repository before continuing.
- **Migrate succeeds, deploy fails** → exit code **2**. Migrations are
  forward-only and already applied; the previous Worker is still
  serving traffic. Fix the deploy and re-run `npm run deploy`, or
  `wrangler rollback` to the prior deployment. Do **not** hand-revert
  the schema — Garrul migrations are additive.
- **Deploy succeeds, rerender fails** → warn only; the instance keeps
  serving and new comments render with the new sanitizer. But it is **not**
  self-healing: `body_html` is rendered once at write time and served
  verbatim, with no re-render on read, so every pre-existing comment keeps
  its old markup until the rerender actually completes. Re-run
  `npm run rerender -- --remote`, or use `/admin/operator` → Rerender.
  Treat it as required, not cosmetic, when the bump was made for a
  sanitizer change — see the renderer-version note below.

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

### Renderer version

`release-manifest.json` carries `renderer.version` (mirroring
`CURRENT_RENDERER_VERSION` in `src/lib/markdown.ts`) and
`renderer.eagerRerender`. A bump means the markdown sanitizer's output
changed. Because `body_html` is written once and served verbatim, the change
reaches **new** comments immediately and **existing** ones only when you
re-render; `eagerRerender: true` tells the upgrade orchestrator to run it
without asking. It is safe to re-run and resumable — it pages through
comments whose `renderer_version` is below the target.

Bumps so far:

- **1 → 2** — GFM task-list checkboxes stopped emitting
  `<input type="checkbox">` (a disabled form control in user-generated
  content, outside the tag allowlist) and now render as literal `[ ]` / `[x]`
  text; the `class="language-…"` on fenced code is dropped unless the info
  string looks like a language label. Nothing else in the output changed, and
  no comment text is altered — `body_md` is the source of truth and is
  re-rendered from, not edited.

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
shows `email.send_failed` with the HTTP status and Resend's error *code*
(`validation_error`, `rate_limit_exceeded`, …).

That line carries the code and nothing else on purpose. Resend's error
bodies interpolate the offending field into a free-text `message`, so a
422 for a bad address quotes the address — and the digest path's
recipients are your subscribers. Log lines are not a safe place for
that. If the code alone isn't enough to diagnose a delivery problem, the
Resend dashboard has the full message against the specific send.

**`*.workers.dev` in production.** Works just enough to be tempting,
then breaks sign-in for Safari/Brave users. Map a custom subdomain
(section 10).

For deeper failure modes see `docs/troubleshooting.md`. For embed-side
issues (widget mount, CSP, slug derivation) the user should consult
`AGENTS.md` instead — those concerns belong on the integrator side.
