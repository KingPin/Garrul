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
- **Optional: a domain on Cloudflare DNS.** Required for
  `custom_domain = true`, and for nothing else. Without it the Worker
  deploys to `*.workers.dev`, which is a real deployment on the same
  free tier — fine for evaluating Garrul, not for production, because
  the session cookie is third-party there and Safari/Brave block it
  (sign-in fails; anonymous commenting and the admin UI still work).
  Moving to a custom domain later is a `wrangler.toml` edit plus a
  redeploy, with no data migration — so don't gate the install on it.
- **Node.js >= 24** and `npm`. The repo's `.nvmrc` pins the version.
  Node 22 fails at `npm ci` — see the `node-24-minimum` entry in
  `release-manifest.json`.
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
4. Run `npm run setup`. It creates the D1 database (`garrul-db`)
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
| `SECURITY_CONTACT` | var | Optional. Vulnerability-disclosure contact published at `/.well-known/security.txt` (RFC 9116). An email address (served as `mailto:`) or an `https://` / `mailto:` URI, served verbatim. Unset (the default) the route answers 404 — the file is only served once there is a real contact behind it. Usually maintained on the Settings page rather than here — this is the default a fresh deploy starts with. | `security@example.com` | `wrangler.toml` default; **Admin → Settings** overrides |
| `OAUTH_CALLBACK_BASE` | var | Base URL for OAuth callbacks; must match the URI registered with each provider. Usually identical to `PUBLIC_BASE_URL`. | `https://comments.example.com` | `wrangler.toml` — **replace the shipped placeholder before deploying** |
| `BRANDING_HIDDEN` | var | Optional. Set to `1`/`true` to suppress the "Powered by Garrul" attribution under the comment list. Unset = attribution shown. | `false` | `wrangler.toml` |
| `JWT_SECRET` | secret | HMAC-SHA-256 key for the signed OAuth state cookie (`src/lib/oauth.ts`). Required for sign-in to work at all. Rotating it invalidates any OAuth flow already in progress — users retry and it works; no other effect, since sessions are KV-backed and not signed with this. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `IP_HASH_SECRET` | secret | HMAC-SHA-256 pepper for IP hashing (see `src/lib/ip-hash.ts`). Never log/store raw IPs. Tier-1 secret: with it, a D1 export discloses every commenter's IPv4 address, so guard it like `JWT_SECRET`. Rotating invalidates existing rate-limit and dedupe buckets, orphans anonymous ghost identities, and does **not** re-key hashes already stored — read `docs/ip-hashing.md` before rotating. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SITE_KEY` | secret | Cloudflare Turnstile site key. Required for anonymous commenting. Note this value is *public* — it ships in the widget HTML. It is stored as a secret for historical reasons and because doing so is harmless. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_SECRET` | secret | Turnstile secret. Server-side token verification. | `0x4AAAAAAA...` | `wrangler secret put` / `.dev.vars` |
| `TURNSTILE_ALWAYS` | var | Require a Turnstile challenge on **every** comment, not just anonymous ones. Defaults **off**: a signed-in author already paid for an OAuth account, and challenging them is friction for the commenters an operator least wants to annoy. Turn it on when throwaway accounts are being scripted. Inert unless both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are set — the widget can only render a challenge with the key and the server can only verify one with the secret, so it does not demand a token it could never receive or never accept. Also settable from `/admin/settings`. | `false` | `wrangler.toml` |
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
| `CONFIRM_SEND_BURST_MAX` | var | Ceiling on outbound subscription-confirmation email per 60-second window, counted atomically in D1 and applied **globally** rather than per identity — every per-identity key on that endpoint is either racy or attacker-supplied. Default `20`, range `[1, 10000]`. Raise it if `wrangler tail` shows `confirmation email budget exhausted` while a busy post is being subscribed to legitimately; the exhausted window 429s new subscriptions but never touches already-confirmed subscribers. See `docs/ANTISPAM.md`. | `20` | `wrangler.toml` default; **Admin → Settings** overrides |
| `CONFIRM_SEND_DAILY_MAX` | var | Ceiling on outbound subscription-confirmation email per 24-hour window, same global D1 counter as `CONFIRM_SEND_BURST_MAX`. Default `200`, range `[1, 100000]`. The default sits deliberately *above* Resend's free-tier 100/day so the provider's limit is what a normal instance meets first; lower it to `100` (or below) if you would rather Garrul stop sending before your mail plan does. See `docs/ANTISPAM.md`. | `200` | `wrangler.toml` default; **Admin → Settings** overrides |
| `WEBHOOK_URL` | secret | Legacy single-URL webhook (fire-and-forget, no retries). Only honored when no endpoints are configured on `/admin/webhooks` — prefer endpoint rows (signed, retried, per-event filters). | `https://example.com/hook` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_BOT_TOKEN` | secret | Optional. BotFather token enabling the Telegram operator bot. With only this set, outbound notifications work (add a `telegram` webhook endpoint with a chat id). Unset = feature off. See `docs/telegram.md`. | `123456789:AAH...` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_WEBHOOK_SECRET` | secret | Optional. Shared secret echoed in the `X-Telegram-Bot-Api-Secret-Token` header; required for inbound buttons/slash commands. Pass it to Telegram's `setWebhook` as `secret_token`. Unset = inbound rejected (fail closed). | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `TELEGRAM_BOT_USERNAME` | var | Optional. Bot `@username` (without `@`). When set, `/admin/telegram` renders a one-tap `t.me/<bot>?start=<code>` deep link instead of manual `/start` steps. | `YourGarrulBot` | `wrangler.toml` |
| `SPAM_PROVIDER` | var | Optional. Pluggable content classifier — `akismet` or `workers-ai`. Unset = no classifier. `workers-ai` also needs an `[ai]` binding. See `docs/ANTISPAM.md`. | `akismet` | `wrangler.toml` |
| `AKISMET_API_KEY` | secret | Optional. Akismet API key. Required when `SPAM_PROVIDER=akismet`. | `...` | `wrangler secret put` / `.dev.vars` |
| `AKISMET_SITE_URL` | secret | Optional. Public site URL sent to Akismet alongside each check. Required when `SPAM_PROVIDER=akismet`. | `https://yourblog.example.com` | `wrangler secret put` / `.dev.vars` |
| `SPAM_FORM_TS_SECRET` | secret | Optional. HMAC key for signed form-timestamp tokens. Set when `SPAM_HONEYPOT_MIN_MS` is in use, otherwise the timing check cannot be trusted. | ``openssl rand -base64 32` output` | `wrangler secret put` / `.dev.vars` |
| `SPAM_BLOCKLIST` | var | Optional. Muted-words list, one term per line. A term matches whole words only (`ass` does not flag "class"); wrap it in `*` to match anywhere (`*casino*`), or trail one for a prefix (`t.me/*`). Matching is case-insensitive, folds Unicode lookalike forms (fullwidth `ｖｉａｇｒａ` matches `viagra`) and ignores zero-width characters. Accents are *not* stripped and leetspeak is *not* decoded. Lines starting with `#` are comments. Not a regex — `.` and `(` are literal text. Checked against the comment body, author name and page URL; a hit routes the comment to the admin queue, never a silent drop. Usually maintained on the Settings page rather than here — this is the default a fresh deploy starts with. | `casino\n*viagra*\nt.me/*` | `wrangler.toml` default; **Admin → Settings** overrides |
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
| `MODERATOR_EMAIL_ENABLED` | var | Email `ADMIN_EMAILS` (or `MODERATOR_NOTIFY_EMAILS`) a digest when comments land in the moderation queue or get reported. Defaults **off** — outbound mail is not something an upgrade should start doing unasked. Needs `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM` and `PUBLIC_BASE_URL`; without them the pass is a silent no-op. Also settable from `/admin/settings`. | `false` | `wrangler.toml` |
| `MODERATOR_NOTIFY_EMAILS` | var | Comma-separated recipients for moderation-queue email. Unset falls back to `ADMIN_EMAILS`, which is already the set of people who can act on the queue — set this only when the alerts belong somewhere else, such as a shared `moderation@` alias. | `moderation@example.com` | `wrangler.toml` |
| `PAGE_REACTIONS_ENABLED` | var | Article-level emoji reaction bar (react to the page itself, no comment). Defaults **off** so an upgrade never surfaces new UI unasked. Enables `POST /api/v1/page-engagement/reactions` and the widget bar. | `false` | `wrangler.toml` |
| `PAGE_VOTES_ENABLED` | var | Article-level "was this helpful?" up/down vote tally. Defaults **off**. Enables `POST /api/v1/page-engagement/votes`; downvotes here still honor `DOWNVOTES_ENABLED`. | `false` | `wrangler.toml` |
| `SHOW_DELETED_PLACEHOLDERS` | var | Keep deleted comments in the public tree as a placeholder (`[deleted]` / `[removed by a moderator]`) instead of pruning leaf deletions. Defaults **off** (current behavior: a deleted comment with live replies is still kept for thread continuity; a deleted leaf is dropped). Added v1.15.0. | `false` | `wrangler.toml` |
| `COMMENTS_PER_PAGE` | var | Top-level comments shown per initial load and per "Load older comments" click (server-side slice in `api.comments.ts`). Defaults **25**; clamped to `[1, 200]`. **Behavior change in v1.11.0:** older installs rendered up to 100 at once — set this to `100` to restore that. | `25` | `wrangler.toml` |
| `REPLIES_PER_THREAD` | var | Replies shown under each comment before a "Show N more replies" button (widget). `0` = show all. Defaults **3**; clamped to `[0, 100]`. | `3` | `wrangler.toml` |
| `DEFAULT_LOCALE` | var | Language the widget, the Atom feed and notification emails render in. `auto` (the default) means *not configured*, which lets the host page's `<html lang>` pick one; set an explicit tag to override the page. Accepts `auto` plus any locale Garrul ships — see the locale table in the README. An unknown tag falls back to `auto`. Machine-seeded translations are never selected from `<html lang>`; reaching one requires either this setting or `data-lang` on the embed. Comment text itself is never translated. | `auto` | `wrangler.toml` default; **Admin → Settings** overrides |
| `DEFAULT_SORT` | var | Order top-level threads are served in when the embed doesn't request one. `new` (the default) is newest-first, `old` is oldest-first — chronological, the way a blog comment thread usually reads — and `top` ranks by net score. Readers can still switch order in the widget; this only sets where they start. `top` requires voting to be enabled and falls back to `new` without it, so the preference is kept rather than rewritten if voting is turned off and on again. An unknown value falls back to `new`. | `new` | `wrangler.toml` default; **Admin → Settings** overrides |
| `AUTO_COLLAPSE_DEPTH` | var | Replies nested at this depth or deeper start collapsed in the widget. `0` = never auto-collapse. Defaults **3**; clamped to `[0, 4]` (the display flatten threshold — *not* the 8-level reply cap). | `3` | `wrangler.toml` |
| `AUTO_CLOSE_DAYS` | var | Close a thread this many days after its article was published (`posts.published_at`, else `created_at`). Evaluated lazily at read/write time — no cron. Defaults **0** (disabled). Existing comments, reactions and votes stay live. | `0` | `wrangler.toml` |
| `AUTO_CLOSE_AT` | var | Hard sunset — close **all** threads at/after this epoch-ms timestamp. Defaults **0** (disabled). The admin Settings page writes this via a date picker. | `0` | `wrangler.toml` |
| `COMMUNITY_MIN_VOTES` | var | Minimum total votes before `COMMUNITY_COLLAPSE_RATIO` applies — the brigading floor. Defaults **5**. | `5` | `wrangler.toml` |
| `COMMUNITY_COLLAPSE_RATIO` | var | Percent of downvotes/total that collapses a comment in the widget. Cosmetic and reversible — the reader can expand it. `0` = off, range `[0, 100]`. Requires `DOWNVOTES_ENABLED`. | `0` | `wrangler.toml` |
| `IP_HASH_RETENTION_DAYS` | var | Clear `comments.ip_hash` + `comments.user_agent` and `reports.reporter_ip_hash` once the row is this many days old, swept by the cron. `0` = off (the default — an upgrade never starts deleting data on its own). Range `[0, 3650]`, and the sweep refuses to run below **7** days so a fat-fingered `1` can't purge nearly everything. **Irreversible**: nothing reconstructs a cleared hash. Does *not* touch anonymous ghost `users.provider_id` — that column is the identity itself, so expiring it would delete the account rather than a hash. See `docs/ip-hashing.md`. | `0` | `wrangler.toml` |
| `AUDIT_LOG_RETENTION_DAYS` | var | Delete `audit_log` rows once they are this many days old, swept by the cron. `0` = off (the default — an upgrade never starts deleting an operator's moderation history on its own). Range `[0, 3650]`, and the sweep refuses to run below **30** days, a higher floor than the IP sweep's because a moderation record stays operationally useful far longer than a hashed IP. **Irreversible** — a pruned audit row is gone, and with it the answer to "why is this user banned". Whole rows are deleted rather than redacted: an audit entry with the actor removed reads as evidence while proving nothing. See `docs/compliance/data-inventory.md`. | `0` | `wrangler.toml` |
<!-- END:config-table -->

Bindings (D1, KV, Analytics) live in `wrangler.toml` outside `[vars]`
and are populated by `npm run setup`. Don't edit binding IDs by
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
  slice in `GET /api/v1/comments` (and the `comments` section of
  `GET /api/v1/bootstrap`, which shares that code path and that cache entry)
  and is baked into the first-page edge-cache key (keyed by slug, sort, and
  size), so changing it never serves a stale-sized page. Both `sort=new` and
  `sort=top` paginate, so shrinking the page size never hides top-voted
  threads past the first page.
- `REPLIES_PER_THREAD` and `AUTO_COLLAPSE_DEPTH` are consumed **client-side**:
  the widget reads them from the config payload (the `config` section of
  `/api/v1/bootstrap` on mount, or `/api/v1/config` on the fallback path) and
  uses them purely for reply folding (no API/payload change — all replies
  still arrive in one response).

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
  **Since v2.21.0 the reader can see it**: inside the last hour the Edit button
  carries a countdown ("12m left"), the affordance disappears at expiry without
  a reload, and an editor left open disables itself and says so. Only the last
  hour is shown, so raising this to days doesn't put a chip on every comment —
  nor a background timer on the reader's device until that hour arrives.
  Nothing about the server-side gate changed — this is display only.
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

Four more surfaces are reachable without an `Origin` because they sit
outside the `/api/*` gate entirely, not because of a carve-out:
`GET /feed/:slug` (Atom), `GET /c/:id` (comment permalinks),
`GET /embed/:slug` (the iframe variant) and `GET /embed.js` (the widget
bundle). Each is meant to be fetched by readers, feed readers and
crawlers, so none of them can require one.

**Build-time fetchers get 403s.** A static-site generator that reads
comments at deploy time looks exactly like a scraper to the Worker: no
`Origin`, gated path. Consume `GET /feed/:slug` instead until the planned
API-keys system ships; the design is in
[`docs/api-keys-design.md`](docs/api-keys-design.md) and is **not**
implemented.

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

**The challenge loads on first composer focus, not on page load.** The
widget mounts its `/embed/turnstile-frame` iframe (which in turn fetches
Cloudflare's `api.js`) only once the visitor focuses the comment box, so
readers who never comment never download it. Expect no `turnstile`
requests in a DevTools trace of a page load. A submit that arrives before
a token exists waits up to 9 seconds and then reports one of four
distinct messages — see `docs/ANTISPAM.md` § "Turnstile mount timing" for
the table mapping each to the operator action, and note that only one of
the four leaves the composer disabled.

**A transient Turnstile error retries once rather than latching.** The
frame forwards Turnstile's error code, and the widget resets the challenge
for every code Cloudflare marks `Retry: Yes` — `300***`/`600***` generic
challenge failure, `110600` challenge timed out, `110620` interaction
timed out, `200500` iframe load error. Everything else latches: any other
code, a second error, and a code-less error — which is what the three
frame-never-came-up paths report, and what an older cached copy of the
frame document reports for everything. That last point means the first
five minutes after an upgrade behave exactly like the old build, since the
frame is cached with `max-age=300`. The frame also renders with
`retry: "never"` so Turnstile's own 8-second auto-retry can't spend that
budget behind the widget's back. The retry is UX only;
`POST /api/v1/comments` still rejects a missing or invalid token
server-side regardless.

### Optional extra anti-spam layers

Four lightweight heuristics and a pluggable content classifier are
available on top of Turnstile. **All off by default.** Flagged comments
flip to `status='pending'` and land in the admin queue rather than
being silently dropped.

The four heuristics are runtime settings: the env vars below set the
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
- `SPAM_BLOCKLIST` — muted words, one term per line, checked against the
  body, author name and page URL. Empty/unset = off. A bare term matches
  whole words only; `*` is the sole wildcard (`*casino*`, `t.me/*`) and
  everything else is literal. Case-insensitive, folds Unicode lookalikes
  and zero-width characters; does not strip accents or decode leetspeak.
  `#` starts a comment. Normally maintained on the Settings page — the
  env var is just the default a fresh deploy starts with.
- `SPAM_PROVIDER` — set to `akismet` or `workers-ai` to enable a
  content classifier (each has its own required secrets/bindings).

See [`docs/ANTISPAM.md`](./docs/ANTISPAM.md) for the full layer
breakdown, privacy tradeoffs (Akismet sends comment content off
Cloudflare; Workers AI keeps it on-network), and recommended starter
configs.

### Accurate rate limiting: the Durable Object backend (opt-in)

By default the rate limiter runs its counters on the edge Cache API.
That backend has no compare-and-swap and keeps counters **per
datacenter**, so the configured caps are a cost-raiser rather than a
hard ceiling: concurrent requests from one identity are undercounted,
and a distributed burst is counted once per colo it reaches.

Binding a Durable Object moves the counters onto a single authority per
identity, which closes both. `setup.sh` does not create it and nothing
prompts for it — this is deliberate: existing instances keep working
untouched, and enabling it is a `wrangler.toml` edit plus a redeploy.

Uncomment the `RATE_LIMIT_DO` block in `wrangler.example.toml`, copy it
into your `wrangler.toml`, and deploy. No new secrets, no D1 migration.
Two things to get right:

- The migration must use `new_sqlite_classes`, not `new_classes`. The
  Workers free plan only offers SQLite-backed Durable Object classes.
- `[[migrations]]` is an **ordered sequence for the whole Worker**, not
  per-class. `tag = "v1"` is correct only if this is your first Durable
  Object; otherwise use the next unused tag and leave existing blocks
  in place.

Rolling back is removing the binding block and redeploying — the shard
holds no persistent state, so the limiter simply returns to the Cache
API with nothing to clean up. Leave the class and the migration alone.

It is not free at runtime. A shard lives in one datacenter, so every
metered write endpoint call trades a colo-local cache read for a round
trip to that one location — single-digit milliseconds for a nearby
reader, up to a couple of hundred for a distant one, on every comment
post, vote and reaction. Reads are unaffected; the comment tree still
comes from the edge cache. A hung shard is capped at 2 seconds and then
fails open.

Two caveats worth knowing before you rely on it. Counters are held in
memory (persisting them would spend a storage write on every allowed
request), so a shard that goes idle and hibernates resets its buckets —
a caller pacing itself slower than the hibernation interval can exceed
the *long* window. And if a shard is unreachable the limiter fails
**open**, logging `ratelimit.degraded` with `backend: "do"`; watch for
that with `wrangler tail`. Neither is a reason to skip it, but neither
makes it a hard ceiling either — for that, put Cloudflare WAF
rate-limiting rules in front of the Worker.

Free-plan budget: 100,000 Durable Object requests/day account-wide, one
per metered write-endpoint call — **including calls the limiter blocks**.
Storage and duration quotas are untouched. Exceeding the request budget
makes further Durable Object calls fail, which the limiter treats as any
other unreachable shard: it fails open until the quota resets at 00:00
UTC. So a flood large enough to exhaust the budget also turns this
backend off for the rest of the day, which the Cache API backend cannot
do. Put a WAF rate-limiting rule in front if you expect one.
[`docs/ANTISPAM.md`](./docs/ANTISPAM.md) § "The Durable Object backend"
has the full detail.

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

For the operator-facing overview — which channel notifies whom, and what
a reader actually experiences — see `docs/notifications.md`. This section
is the mechanism and the limits.

To enable outbound email:

1. Set `EMAIL_PROVIDER = "resend"` in `wrangler.toml`.
2. Set `EMAIL_FROM` to a sender on a Resend-verified domain.
3. `wrangler secret put RESEND_API_KEY`.
4. The cron in `wrangler.example.toml` (`*/15 * * * *`) auto-registers
   on deploy. Comments newer than ~5 minutes are debounced so reply
   bursts coalesce into a single email per subscriber.

If `EMAIL_PROVIDER` or `RESEND_API_KEY` is unset, `sendEmail` returns
`false`, the caller logs a warning, and the request continues.
Operators who don't want Garrul sending mail at all can leave both unset
and remove the `[triggers]` block to avoid registering the cron.

Triggers (events that produce a send):

- **Reply notification** — a new comment lands on a thread someone has
  subscribed to. This is a first-class, built-in email notification. It
  does *not* require a webhook, and it is not merely a periodic
  roundup: the send is caused by the comment. What the cron buys is
  debouncing — a burst of replies coalesces into one email instead of N
  (see `src/lib/digest.ts`). Subscriptions are thread-scoped, so a
  subscriber hears about every new comment on the post, not only
  direct replies to their own.
- **Moderator digest** — a comment lands in the moderation queue, or a
  reader files the first report on one. Also first-class built-in email,
  also no webhook required, and the exact inverse of the reply
  notification: readers hear when a comment is approved, you hear when
  it isn't, so no comment ever notifies both. Off by default; turn it on
  with `MODERATOR_EMAIL_ENABLED` or *Settings → Moderation → Email me
  about the queue*. Recipients default to `ADMIN_EMAILS`;
  `MODERATOR_NOTIFY_EMAILS` overrides for a shared alias. Same
  5-minute debounce (`src/lib/moderator-digest.ts`), capped at 25
  comments per tick, English-only like the admin UI and the bot.
  Anything you handled inside the debounce window is dropped rather than
  mailed. Silent no-op if email isn't configured.
- **Subscription confirmation** — a reader subscribes to a thread
  (double-opt-in). This is the only send an unauthenticated caller can
  trigger, so it has its own ceiling — see below. A signed-in reader
  whose provider verified their address (GitHub, Google) is confirmed
  on the spot instead, so this send never happens for them.

  Since v2.10.0 there are **two** ways a reader reaches this: the
  composer's "Email me about new comments" checkbox, and a 🔔 in the
  thread toolbar for someone who wants replies but has nothing to say.
  Same endpoint and same limits — expect roughly the same confirmation
  volume from a somewhat larger share of your readers. Both affordances
  are hidden unless `EMAIL_FROM` **and** `PUBLIC_BASE_URL` are set
  (`subscriptions_enabled` in `/api/v1/config`), since `POST
  /api/v1/subscribe` fails closed with 503 without them — previously the
  checkbox was offered on installs that could never deliver. Note this is
  deliberately *not* gated on `RESEND_API_KEY`: a widget that went dark
  when only the secret was missing would hide that misconfiguration
  instead of surfacing it in the logs.
- An unsubscribe-link click opens a confirmation page and sends nothing.

Nothing sends *inline* on the request path: every notification is
queued to D1 and flushed by the cron, so a slow or failing Resend never
delays or fails a reader's comment.

### The confirmation-email ceiling

`POST /api/v1/subscribe` sends one confirmation email per accepted
request, which makes it the only endpoint where an unauthenticated
caller spends your Resend quota and your domain's sending reputation.
The rate limiter is not a hard ceiling there — on the default Cache API
backend concurrent requests from one identity sustain a multiple of the
configured rate — and the per-address pending cap is bypassed by
cycling addresses. So sends are counted directly, in D1:

| Budget | Default cap | Window | Setting |
| --- | --- | --- | --- |
| `confirm:burst` | 20 sends | 60 s | `CONFIRM_SEND_BURST_MAX` |
| `confirm:daily` | 200 sends | 24 h | `CONFIRM_SEND_DAILY_MAX` |

Both must grant. The counters are single rows in `email_send_budget`
(migration `0018`) and the whole decision is one `UPDATE` carrying the
cap in its own `WHERE` clause, so it is atomic — concurrency cannot
multiply it, and this needs no Durable Object.

What you'll see when it trips: `429` with `"reason":
"send_budget_exhausted"`, no row written to `subscriptions`, and a
`warn` log line naming the scope and cap. Grep `wrangler tail` for
`confirmation email budget exhausted`.

Operator notes:

- The ceiling is **global**, not per-IP or per-address — deliberately,
  because every per-identity key on that endpoint is either racy or
  attacker-supplied. The cost: an attacker who spends a window denies
  **new** subscriptions until it rolls. Confirmed subscribers keep
  getting digests; comments are unaffected.
- The window is fixed, not sliding, so a burst across a boundary can
  land up to ~2× the cap in quick succession.
- It **fails open** — a missing table or a D1 error counts nothing
  rather than refusing every subscription. Run `npm run migrate` after
  upgrading, or you lose the ceiling silently (the `warn` line
  `email budget scope missing` is your signal).
- It counts *sends*, not attempts. If Resend rejects the call or
  `RESEND_API_KEY` is missing, the slot is refunded — so an install with
  `EMAIL_FROM` set but the secret unset keeps accepting subscribers
  instead of spending the ceiling on mail that never left.
- **Digests are not counted here** — they go to already-confirmed
  addresses and no unauthenticated caller can trigger them. This bounds
  the attacker-reachable share of your Resend spend, not the total.
- Both caps are **runtime-settable** (since 2.8.0): *Settings →
  Moderation → Confirmation-email ceiling*, or the
  `CONFIRM_SEND_BURST_MAX` / `CONFIRM_SEND_DAILY_MAX` vars. Standard
  precedence — a `settings` row overrides the env var overrides the
  default. Raise the burst cap when `wrangler tail` shows
  `confirmation email budget exhausted` while a post is legitimately
  busy; that log line is the only signal a real subscriber was turned
  away. Resend's free tier is 100 emails/day, so the 200 daily default
  deliberately sits above it — your provider's limit, not this one, is
  what a normal instance hits first. On the free tier, set it below 100
  minus your expected digest volume if you want Garrul to stop before
  Resend does.
- Neither cap accepts `0`. Both clamp to a floor of **1**, unlike the
  other numeric dials where `0` means "check off" — a ceiling of 0 would
  refuse every new subscription while reading as disabled. Set the cap
  high to get the ceiling out of the way.
- The two **windows** stay code constants. The `scope` strings are the
  primary key seeded by migration `0018`, so renaming or splitting a
  window is a migration, not a setting; and in practice what needs
  retuning is how many sends you get, not the period.
- Full threat-model write-up: `docs/ANTISPAM.md` §"The
  confirmation-email ceiling".

### The moderator-email ceiling

Moderator mail runs through the same D1 machinery with its **own**
counter rows, seeded by migration `0021`:

| Budget | Cap | Window |
| --- | --- | --- |
| `moderator:burst` | 10 sends | 60 s |
| `moderator:daily` | 500 sends | 24 h |

Counted **per digest, not per recipient**: one tick spends one slot
whether it mails one moderator or six, so growing the list never brings
the cap closer. A tick that cannot reserve mails nobody and leaves its
rows queued for the next one — the fan-out is all-or-nothing, so an
exhausted cap can never mail half the team and mark the batch handled.

Fixed, not settable, unlike the confirmation caps. Those are tunable
because a busy post can legitimately 429 a real subscriber; there is no
equivalent here — volume is bounded by the cron cadence (one digest per
tick whatever the queue depth) and the recipient list is yours, so the
only thing left for a cap to catch is a runaway.

Separate scopes are the load-bearing part, not a tidiness choice: a spam
flood filling your moderation queue cannot spend the budget that lets
new subscribers confirm, and an attack on `/api/v1/subscribe` cannot
silence the flood alert. Grep `wrangler tail` for `moderator email
budget exhausted`; the queue rows stay pending and the next tick
retries, so a tripped cap delays the mail rather than losing it.

The unsubscribe link is a two-step flow: the `GET` from the email only
renders a "Yes, unsubscribe me" button, and the `POST` behind that
button does the write. Mail clients, link scanners and corporate
security gateways prefetch every URL in a message, so a `GET` that
wrote would silently unsubscribe recipients who never clicked. Expect
support questions from operators who remember one click; the extra
click is deliberate.

That page also lists every *other* thread the same address follows, with
a per-row unsubscribe and an unsubscribe-from-all — a reader following
twenty threads no longer has to find twenty emails. Rows are actioned by
subscription id, never by another row's token. Note the trade-off this
accepts: a leaked unsubscribe token now discloses which posts that
address follows, not just the one thread the mail was about. A token
only reaches someone who can read the mailbox, which is a party that
could read the same list off the messages themselves.

**RFC 8058 one-click.** Digests carry `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so Gmail and Apple
Mail render their own native Unsubscribe button next to the sender. It
posts to `/api/v1/subscribe/unsubscribe/:token/one-click` **from the mail
provider's servers**, which means no `Origin` header and no browser
involved — hence the third relaxation class in `src/lib/cors.ts`, and
hence no IP rate limit on that one route (providers post from shared
egress; a 429 there is a failed unsubscribe, which counts against sender
reputation). Bulk senders that omit these headers get filtered harder,
so this is a deliverability feature as much as a courtesy one.

To verify it yourself after deploying: send a digest to a Gmail address,
open the message, and check for an "Unsubscribe" link beside the sender
name. If it is missing, look at the raw message
(⋮ → Show original) for both headers; Gmail requires the pair, and
requires the message to pass DKIM/SPF alignment for the sender domain.

**Signed-in readers manage their own.** A reader whose session carries a
provider-verified address gets a stateful bell and a Manage panel in the
widget (`GET /api/v1/subscribe/mine`, `DELETE /api/v1/subscribe/mine/:id`)
and does not need to touch email at all. Those routes are session-scoped
to the session's own address and answer 404 — never 403 — for a row it
does not own. `/admin/subscriptions` remains the operator's view and is
unaffected.

Their rate limiter keys on the **account**, not the client IP, and that
is load-bearing rather than incidental. `GET /mine` is the only limited
*read* on a per-page-view path — everything else the limiter guards is a
write — so an IP-keyed bucket would spend one token of the shared per-IP
global envelope (20/10s, 200/10min) every time a signed-in reader loaded
a page. Behind one office NAT or a carrier CGNAT, readers merely *reading*
the site would drain that envelope and the resulting `429` would surface
on a different person trying to post a comment: a symptom nowhere near
its cause. Keyed on the account, page views cannot starve the writes.

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
- `0009_import_tracking.sql` — import idempotency, `(import_source, import_id)`
- `0010_settings.sql` — DB-backed runtime settings overrides
- `0011_page_engagement.sql` — page-level reactions + votes
- `0012_deleted_by.sql` — records who deleted a comment
- `0013_thread_lifecycle_reports.sql` — per-post close/`published_at` + reader `reports` table
- `0014_telegram.sql` — `telegram_links` (operator account ↔ Telegram identity, + digest opt-in)
- `0015_comment_depth.sql` — `comments.depth`, backfilled from `parent_id`; enforces the reply-depth cap at insert
- `0016_user_erasure.sql` — `users.erased_at`, for the admin erase-personal-data path
- `0017_subscriptions_email_index.sql` — `subscriptions(email, confirmed_at)`; the per-email pending cap was a full table scan on every subscribe
- `0018_email_send_budget.sql` — `email_send_budget`, the atomic global ceiling on outbound confirmation email (seeds its own counter rows)
- `0019_audit_log_pii.sql` — trims PII out of the audit log
- `0020_subscriptions_locale.sql` — `subscriptions.locale`, so each digest renders in the subscriber's own language
- `0021_moderator_notifications.sql` — `moderator_notifications`, the queue behind moderator email (seeds its own `moderator:*` budget rows)
- `0022_reaction_kind_fire.sql` — renames the `like` reaction to `fire`
- `0023_moderator_notes.sql` — `moderator_notes`, internal moderator context on one comment or one account. Never rendered to readers, and the note *body* never reaches `audit_log`

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
The exemptions are the import uploads — `POST /admin/api/ops/import-disqus`,
`POST /admin/api/ops/import-remark42`, `POST /admin/api/ops/import-comentario`
and `POST /admin/api/ops/import-isso`
— which take an export — gzipped or not — up to 50 MB and enforce their own
limit, on the decompressed bytes as well as the compressed ones. Implementation:
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
  restore, bulk actions, replies, saved replies, moderator notes).
  Cannot ban users, edit settings, run operator scripts, or
  grant/revoke roles.
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
| `/admin/queue` | Moderation queue. Status tabs (incl. a **Reported** tab — comments with open reader reports, with a count badge) + filter bar (body search, post slug, date range, scoped-by-user). Per-row + bulk actions (Approve/Spam/Delete/Restore). When filtered to a single post slug, a **Close / Open comments for this post** toggle appears. Rows also offer one-click **Ban author**. Each row shows author identity (avatar + provider + admin/banned pills), a `✎ n` badge when the comment or the account carries moderator notes, and the latest audit footer. Fully keyboard-drivable — see **Keyboard shortcuts** below. |
| `/admin/comments/:id` | Single-comment view: parent + replies, raw markdown, spam-verdicts per source, full audit history for that comment, author block with their last 5 comments, and the **Moderator notes** card. |
| `/admin/users` | User search + ban toggle. |
| `/admin/users/:id` | User detail: all their comments paginated, reactions received, audit history affecting them, the **Moderator notes** card, Ban/Unban, role controls, and two folded-away admin-only panels — **Export personal data** and **Erase personal data** (both below). |
| `/admin/audit` | Audit log with filter form (admin, action, target kind/id, date range). |
| `/admin/subscriptions` | Email subscription list. Filter by email/post/confirmed/unsubscribed. Actions: manual unsubscribe, resend confirmation. |
| `/admin/operator` | Batch operations: rerender stale comments (POSTs `/admin/api/ops/rerender` in 50-row chunks until done), seed-demo (idempotent; gated to `ENV != "production"`), the comment import upload (Disqus XML, a Remark42 backup, a Comentario/Commento JSON export, or the JSON `npm run dump-isso` produces from an isso `comments.db` — gzipped or not — see below), and two retention cards — IP-hash and audit-log — each showing how many rows are past the configured window and offering a manual drain. |
| `/admin/settings` | Editable form for feature flags, display/pagination numbers, and the moderation dials (edit window, thread auto-close, community auto-collapse, the three anti-spam heuristics), saved to the `settings` D1 table (no redeploy — see section 5). Also renders a read-only `(set)`/`(unset)` summary of deploy-time config (Turnstile, email, OAuth, spam provider), which still changes via `wrangler secret put` / `wrangler.toml`. |
| `/admin/webhooks` | Outbound webhook endpoints: add/pause/delete, per-endpoint secret + event filter, adapter (`generic` / `slack` / `discord` / `telegram`), failure counts and retry status. |
| `/admin/telegram` | **Admin-only.** Telegram operator bot: shows whether the bot token/webhook secret are set, links your personal Telegram account (one-time code or deep link), toggles the daily digest, and unlinks. See `docs/telegram.md`. |
| `/admin/saved-replies` | Moderator saved replies: create/edit canned responses, private or shared scope. Presets are a *prefill* for the reply composer, not the only way to reply — see **Replying from the admin panel** below. |
| `/admin/usage` | Cloudflare analytics (requests, comments by domain). Requires `CF_API_TOKEN` + `CF_ACCOUNT_ID`; renders setup instructions when unset. |

State-changing endpoints (all under `/admin/api/...`, all require admin
session + Origin allowlist, all write an `audit_log` row before
responding):

- `POST /admin/api/comments/:id` — `{action: approve|spam|delete|restore, reason?}`
- `POST /admin/api/comments/bulk` — `{ids: string[], action}` (cap 100)
- `POST /admin/api/comments/:id/reports/resolve` — clears open reader reports on a comment (audited `report.resolve`)
- `POST /admin/api/comments/:id/reply` — `{body_md, saved_reply_id?, notify?}` posts a moderator reply nested under `:id` (audited `comment.reply`; `notify` must be a real boolean when present, defaults to true, and fans out to the post's confirmed subscribers; `saved_reply_id` is audit provenance only and must be a preset this mod can see)
- `POST /admin/api/notes` — `{target_kind: comment|user, target_id, body}` writes an internal moderator note (mod or admin; audited `note.create` against the **target**, with only the note id in `meta`). Body caps at 4 000 characters; a target that does not exist is `404 target_not_found`.
- `DELETE /admin/api/notes/:id` — removes one note (audited `note.delete`, again against the target, with `meta.own` recording whether the caller wrote it). Author **or** admin, deliberately looser than saved replies' owner-only rule; another mod gets `403 not_author`.
- `POST /admin/api/posts/close` — `{slug, closed: boolean}` (per-post close/open; audited `post.close` / `post.open`; busts the cached first page)
- `POST /admin/api/users/:id` — `{banned: boolean, reason?, from_comment?}` (one-click ban-author records the originating comment in audit meta; admin-only)
- `POST /admin/api/users/:id/role` — `{role: user|mod|admin, reason?}` (admin-only; refuses self-change and the last-admin demotion)
- `POST /admin/api/users/:id/erase` — `{confirm: "ERASE", redact_bodies: boolean, reason?}` (admin-only, irreversible; see below)
- `POST /admin/api/users/:id/revoke-sessions` — no body (admin-only; kills every session the user holds via the revocation epoch — the stolen-cookie kill switch. Targeting yourself means "sign out everywhere else": the response sets a fresh cookie so the browser doing the revoking stays signed in. Audited `user.revoke_sessions`)
- `POST /admin/api/subscriptions/:id` — `{action: unsubscribe|resend, reason?}`
- `POST /admin/api/ops/rerender` — `{batch?: number, cursor?}` → `{processed, next_cursor}`
- `POST /admin/api/ops/seed-demo` — disabled when `ENV=production`
- `POST /admin/api/ops/ip-retention` — manual drain of the IP-hash sweep; no body. `400 retention_disabled` when `IP_HASH_RETENTION_DAYS` is `0` or below the 7-day floor. Audits `ip_retention.sweep` only when it actually cleared something.
- `POST /admin/api/ops/audit-retention` — same shape for the audit-log sweep, gated on `AUDIT_LOG_RETENTION_DAYS` and a 30-day floor, audited `audit_retention.sweep`.

One POST is unaudited, because it neither changes nor stores anything:

- `POST /admin/api/preview` — `{body_md}` → `{html}`, the reply composer's
  markdown preview. Renders through the same allowlist sanitizer as a real
  comment and persists nothing. Separate from the widget's
  `/api/v1/preview`, which is anonymous and IP-rate-limited.

One admin read is listed here too, because of what it returns:

- `GET /admin/api/users/:id/export` — the whole of one person's personal data as
  JSON (admin-only). See below.

**Exporting a user's personal data.** `/admin/users/<id>` → **Export
personal data** → *Download JSON*, or `GET /admin/api/users/:id/export`
directly. This is the answer to a GDPR Art. 15 / Art. 20 or CCPA
right-to-know request: one file (`garrul-export-<id>.json`) holding the
account row, every comment they wrote, reports they filed, subscriptions
for their address, Telegram link, votes, reactions, page engagement, spam
classifications on their comments, moderation actions taken against
them, and moderator notes written about them. Admin-only; a plain link
rather than a fetch, so the payload never sits in a JS variable.

Three shaping decisions worth knowing before you send one:

- `ip_hash` and `user_agent` **are** included — they are the subject's own
  data, and withholding them would make the export a false statement about
  what you hold. That also makes the file as sensitive as a `.sql` dump of
  their rows. Verify who you're talking to first.
- `audit_log.admin_id` is **excluded**. Which moderator acted is a third
  party's identifier, not the subject's, and Art. 15(4) doesn't require
  disclosing it. Only action, reason and timestamp are exported — and
  `reason` is free text a moderator typed, so skim it before releasing the
  file.
- `moderator_notes` follows the same rule as the audit log: bodies of notes
  written **about the subject** are included, author ids are not. Notes on
  the subject's individual *comments* are excluded — they are moderation
  reasoning about a piece of content rather than a record about the person.
  Note bodies are free text too, so skim them alongside `reason`. The export
  is `export_version: 2` since notes joined it.

Running an export writes a `user.export` audit row recording **row counts
only**, so you have a record that it happened without minting a second
copy of the data. The verify-locate-respond procedure, including what to do
for an email-only subscriber who has no account row at all, is
[`docs/compliance/dsar-runbook.md`](docs/compliance/dsar-runbook.md).

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
- Every moderator note written **about the account**. Two kinds
  deliberately survive: notes they *wrote* about someone else, which are
  records about a third party and stay attributed to the now-redacted
  `[deleted]` row; and notes on their individual *comments*, which are
  retained on the same footing as the moderation actions in `audit_log`
  — the comment they annotate survives too, anonymized. If a comment
  note holds something that has to go, delete it from the comment's
  detail page before running the erase.

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
it — which is also why no audit action records a subscriber address or a
target's display name any more (see `0019_audit_log_pii.sql`).

Retention windows now exist for both PII-bearing tables outside erasure's
reach (`IP_HASH_RETENTION_DAYS`, `AUDIT_LOG_RETENTION_DAYS` — §5 and §11).
Still missing: key epoching for `ip_hash`, and self-serve deletion for the
subject. See [`docs/ip-hashing.md`](docs/ip-hashing.md) and
[`docs/compliance/gdpr.md`](docs/compliance/gdpr.md).

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

**Replying from the admin panel.** A mod can answer a comment without
leaving the admin UI, from either the queue's **Reply** modal or the
single-comment view (`/admin/comments/:id`, which is the better surface
for a considered reply — the thread, the spam verdicts and any reader
reports are all on screen). The composer is free text: type the reply,
optionally **Preview** the rendered markdown, then post. It inserts a
regular comment nested under the target, authored by the signed-in
moderator, `status='approved'` — no Turnstile, no spam check, and no
`ip_hash`/`user_agent` stored. The moderator's name is shown above the
box, because a shared admin login otherwise puts the wrong face on
every reply. Audited as `comment.reply`.

**Notify thread subscribers** is a checkbox on the composer, **default
on**: the reply fans out to every confirmed, still-subscribed email
subscriber on that post — the same fan-out a reader's reply uses, and
the same batched digest drains it, with no moderator/reader distinction
in the email. Uncheck it for a housekeeping note ("dupe, see above")
that shouldn't email the thread. The mod's own address is always
skipped. Subscriptions are per *post*, not per comment, so this notifies
thread followers rather than only the person being replied to.

**Saved replies.** Canned moderator responses, managed on
`/admin/saved-replies`. Each reply is owned by its author and scoped
`private` (only the owner sees it) or `shared` (every mod/admin sees
it). In the composer they sit behind a collapsed **Insert a saved
reply** picker and only prefill the textarea — edit freely afterwards.
The reverse works too: **Save for reuse** turns whatever is in the box
into a new preset (title + scope). Presets cap at 8 000 characters
while a comment allows 10 000, so a long reply can be postable and
still too long to save; the button says so rather than failing. When a
preset prefilled the body its id is recorded in the audit row's
`saved_reply_id`, and it is cleared if the text is edited away from the
preset — provenance is never claimed for text the mod actually wrote.

A preset body may contain three placeholders, filled in at the moment
it prefills the composer — never stored expanded:

| Variable | Becomes |
| --- | --- |
| `{name}` | the display name of the commenter being replied to |
| `{post}` | the title of the post the thread is on, falling back to its slug |
| `{mod}` | the signed-in moderator's own display name |

Interpolation happens on *insert*, so the resolved text lands in the
textarea where it is editable and previewable, and what posts is exactly
what the mod approved. Post-time substitution would also rewrite a
`{name}` the mod typed by hand.

A placeholder with no value — `{name}` on an anonymous comment — is left
**literal**, as is anything not in the table above. A visible `{name}` in
the textarea is a prompt to fix it; an empty string is a sentence the mod
posts without noticing.

**Moderator notes.** Internal context on one comment or one account,
written from the **Moderator notes** card on `/admin/comments/:id` and
`/admin/users/:id`. This is for the case moderation has no verb for —
the comment is borderline, the account is one to watch, and there is no
action to take yet.

- **Every mod and admin sees every note; no reader ever does.** Notes
  are not markdown and are never rendered into a comment tree, a feed,
  a webhook or an email.
- **Deletion is author-or-admin**, deliberately looser than the
  owner-only rule saved replies use: a note is a claim about someone
  standing in front of the whole team, so an admin has to be able to
  strike one. The audit row's `meta.own` says which of the two happened.
- **The audit trail records that a note exists, not what it says.** A
  `note.create` row is filed against the comment or user the note is
  about — so it shows up in the audit history those detail pages already
  render — and carries only the note id. `audit_log` has its own
  retention sweep and its own export path; a body reaching it would
  outlive the note and travel further than it.
- **The queue shows counts, not text.** A `✎ n` badge appears on a queue
  row when the comment carries notes, and next to the author name when
  the *account* does. The account badge is usually the more useful of
  the two: "this handle has history" is exactly what one borderline
  comment cannot tell you. A `mod` sees the account badge but cannot
  open the notes behind it, because `/admin/users/:id` is admin-only —
  the same reason the queue's author link is already a dead end for
  mods. Comment notes are readable by anyone who can act on the comment.
- **Erasure and export.** Erasing a user deletes every note written
  *about* them, and keeps notes they authored (with the author row
  itself surviving, redacted, as `[deleted]`). A personal-data export
  includes note bodies written about that user, without the author ids —
  they are personal data about the subject, and a moderator's identity
  is not the subject's to receive. Notes on the subject's *comments* are
  deliberately excluded from the export.

**Keyboard shortcuts.** `/admin/queue` is drivable without the mouse.
`j` / `k` move a row cursor (an outline, not a background tint — every
even row is already `surface-2`, so a tint marked half the table and
left the other half looking untouched), `a` approves, `s` marks spam,
`d` deletes, `r` opens the reply modal, `Esc` clears the cursor. `a` and
`s` fire immediately; `d` asks first, because it is the one that is
awkward to undo.

A key only offers what the row's own buttons offer: in the `all` and
`reported` views the cursor lands on comments that are already approved,
spam or deleted, and `a` on an approved one would re-audit it and fire a
second approval webhook, `s` on a deleted one would quietly turn it into
spam. Both are refused with a toast instead. One `ROW_ACTIONS` table
decides for the buttons and the keys together.

Acted-on rows are skipped as the cursor advances, whether they were
hidden by a bulk action or by a row's own button — both announce the ids
they retired on the same event, so the cursor cannot land on a row that
has left the table. The keys are inert while you are typing in an
input, while a modal is open, and whenever a modifier is held, so
browser and OS shortcuts keep working. The same list appears in the hint
strip above the table and in the `?` help popover — one table in
`src/admin-ui/pages/queue.ts` feeds all three, so the popover cannot
promise a key the page stopped handling.

Three shortcuts are global to every admin page: `/` focuses the page's
search box, `?` toggles the help popover, `Esc` closes it. They are
matched on `KeyboardEvent.key` by hand in `src/admin-ui/layout.ts`
rather than through Alpine's key modifiers — Alpine has no alias for
`?`, so `.question-mark` never matched and the popover spent several
releases advertising a key that did nothing. `/` and `?` are inert
while you are typing and under any modifier; `Esc` is matched before
that guard, so a popover left open still closes from inside a textarea.

**Comment import.** Four sources today — Disqus, Remark42, Comentario
(which also reads a legacy Commento export) and isso — each with two
entry points, all of them idempotent (deduplicated by the source's own
comment ID, tracked in `0009_import_tracking.sql`; re-running the same
export inserts zero rows):

- CLI (preferred for big exports):
  `IP_HASH_SECRET=... npm run import-disqus -- ./export.xml --dry-run`,
  `IP_HASH_SECRET=... npm run import-remark42 -- ./userbackup.gz
  --dry-run`, `IP_HASH_SECRET=... npm run import-comentario --
  ./export.json --dry-run`, or `IP_HASH_SECRET=... npm run import-isso
  -- ./isso-dump.json --dry-run`, then without `--dry-run` to commit.
  isso needs a step before that one — see **isso specifics** below.
- Admin upload on `/admin/operator` — one card with a source select,
  capped at 50 MB, with dry-run / include-deleted / include-spam
  toggles.

**Gzipped exports work as-is, on every path.** Disqus hands you a
`.xml.gz`, Remark42's nightly `backup` writes a
`userbackup-<site>-<ts>.gz`, and Comentario offers its JSON gzipped;
hand any of them straight to the CLI or the upload and it is
inflated in memory. isso's dumper writes plain JSON — there is no
product-level gzip habit to match — but the same sniff accepts it
gzipped too, if you compress it yourself moving it between machines.
The 50 MB cap applies to the *decompressed* size
too — a file that inflates past it is rejected with `413
{"error":"too_large"}` partway through rather than allocated, which is
what keeps a hostile few-KB upload from being a memory-exhaustion
primitive. Note that the *compressed* file is also capped at 50 MB, so
the practical ceiling is whichever binds first.

Imported HTML is stripped and re-rendered through the standard
markdown allowlist. Thread titles and links go through the same
guards the comment write path applies — control characters stripped
and the title capped (it reaches mail subject lines), and a link that
isn't `http(s):` is stored as no URL rather than becoming a permalink
redirect target. Imported authors become `provider='anon'` ghost
users whose `provider_id` is an HMAC (keyed by `IP_HASH_SECRET`) of
the Disqus author identity, keeping their display names without
storing emails.

Two things carry across beyond the comment text itself. A thread
Disqus had closed to new comments imports as a **closed page** — that
is `posts.closed`, the same freeze the per-post toggle sets, so
reopening it afterwards is a normal operator action. And a comment's
moderation state comes across as-is rather than being flattened to
approved: a comment Disqus marked spam imports as spam (and is skipped
entirely without `--include-spam`), so it never appears publicly on
the strength of the migration alone.

**The dry-run plan's counters use Garrul's nouns, not Disqus'.** The
JSON the CLI prints and the operator card renders reports
`pages_total` / `new_pages` for rows in `posts` and `comments_total` /
`new_comments` for rows in `comments`, plus `new_users`,
`skipped_deleted` and `skipped_spam`. Disqus calls a comment a "post"
and calls the page a "thread", which put `posts_total` (comments) next
to `new_posts` (pages) in the same object; if you have a script
parsing the old field names, that is the rename.

**`merged_pages` is the counter to read before a large import.** Slugs
drop the query string, so `/search`, `/search?page=2` and
`/search?utm_source=x` are one page and the first thread in the export
wins the title and url; the comments on the others relocate onto it.
That is deliberate — keeping the query would fragment one page across
every URL it was ever shared with — but it used to happen silently.
`merged_pages` counts it. You cannot get the number by subtracting
`new_pages` from `pages_total`: that difference also includes pages
that already existed from an earlier run. A real Disqus export of 870
threads merged three. If the count surprises you, run with `--slug=`
to force everything onto one page deliberately, in which case
`merged_pages` reports zero because the collapse is what you asked
for.
**Remark42 specifics.** The export is JSONL — one metadata header
object, then one object per comment — and Garrul takes it with or
without that header, so both `backup`'s file and the export API's
`mode=stream` work. Three things differ from Disqus and are worth
knowing before you run it:

- **Pages are reconstructed, not imported.** A Remark42 export carries
  no page records at all, so each page is derived from the `url` its
  comments name, taking its title from the first comment that has one
  and its creation time from the earliest. `read_only` in the header
  becomes `posts.closed`.
- **Bodies prefer the markdown the author typed.** Remark42 stores both
  the original source (`orig`) and its rendered HTML (`text`). Garrul
  takes `orig` where it exists and falls back to converting `text`
  where it does not, so an import is lossless for anything the author
  wrote in markdown.
- **One site per export.** An export spanning two `locator.site`
  values is refused rather than merged; Garrul is single-site, so
  merging two would silently interleave two comment systems onto one
  set of slugs. Export per site.

A line missing its comment `id`, its `locator.url`, or its `user.id`
fails the whole run with the line number — never the line body, which
may carry an `ip` field. `user.id` is in that list because it is the
identity key: without it the importer would fall back to keying on
display name, merging two commenters who picked the same one.

`--include-spam` is accepted for flag parity and does nothing here:
Remark42 has no spam verdict, so the adapter never emits
`status='spam'`. Deleted comments are skipped unless
`--include-deleted`.

**Comentario and Commento specifics.** Both products write a single
JSON document whose own `version` field says which shape it is —
Comentario writes `3`, Commento wrote `1` — and one adapter reads
both, so both go to the same CLI and the same upload. They share an
`import_source` tag too, which means a v1 file and a later v3 file
from the same instance deduplicate against each other rather than
importing the same comments twice. Four things are worth knowing
before you run it:

- **One domain per run.** Both products are multi-site and neither
  namespaces its page paths by site, so an export carrying two domains
  is refused rather than flattened — two sites' `/about` would
  silently become one page here. Pass `--domain=<id>` (or fill the
  Domain field on the operator card) and run it once per domain. The
  error names the domains it found. For a v3 export that value is a
  `domainId` UUID, because a v3 export carries no hostnames at all;
  for v1 it is a bare host. A value that matches nothing in the file
  is refused as well, and the error names what would have worked — a
  mistyped domain would otherwise select no records and report a
  successful run that imported nothing.
- **Bodies come across as the author typed them.** Comentario stores
  markdown, so nothing is converted and nothing is inferred from
  rendered HTML.
- **What is marked spam is a moderator's decision, not a
  classifier's.** Neither product ships spam detection. A v3 comment
  that is neither approved nor pending is one a moderator rejected,
  and a v1 comment `flagged`; both import as `status='spam'` and are
  skipped without `--include-spam`. A comment still awaiting
  moderation imports as `pending` and is never skipped.
- **Pages come from page records in v3 and are reconstructed in v1.**
  A v3 export has real page records — Garrul imports only the ones
  that actually carry comments, so pages the widget merely loaded on
  do not become empty rows — and takes `isReadonly` as `posts.closed`.
  A v1 export has no page records, so each page is grouped from its
  comments' host and path, and gets no title because Commento never
  exported one.

One v1 quirk worth naming: a Commento export never actually selected
its `deleted` column, so the flag is always false even for comments
that really were deleted. The rewritten body is the only signal left,
so the adapter treats an empty body and a literal `[deleted]` body as
deleted too — matching what Comentario's own importer does with these
files.

**isso specifics.** isso ships no export command at all — its
`comments.db` SQLite file *is* the data store, read directly by the
isso server itself. So the CLI above needs a step before it:

```bash
npm run dump-isso -- /path/to/comments.db --out isso-dump.json
IP_HASH_SECRET=... npm run import-isso -- ./isso-dump.json --dry-run
```

Run the first command on whatever host actually has `comments.db` —
it reads the file read-only with Node's built-in `node:sqlite` driver
(no new dependency; this repo's `engines.node` is already `>=24`), so
isso can keep serving from the same file while it runs. Copy the JSON
it writes to wherever you'll run the import from and hand that JSON to
the CLI's `--dry-run` (or the admin upload, source **isso**) — never
the raw `.db` file itself. Four things are worth knowing:

- **No user accounts.** isso has none, so every commenter imports as
  anonymous; identity is the name+email HMAC seed, same as Disqus. A
  blank or missing name becomes the literal `"anonymous"`.
- **Bodies come across as the author typed them.** isso stores
  markdown, so nothing is converted.
- **`--include-deleted` reproduces isso's exact thread shape.**
  isso's `mode=4` tombstone is skipped by default like every other
  source's deleted comments, but isso only *keeps* a tombstone row
  while it still has live replies under it — skip it and those
  replies come across with no parent; pass `--include-deleted` and
  they keep isso's original shape, tombstone included.
- **`--site=<origin>` supplies the host isso doesn't have.** isso
  stores a path (`threads.uri`), not a URL, so `posts.url` needs a
  host from somewhere else. Give `--site=https://blog.example.com`
  (or fill the admin card's **Site origin** field, header
  `x-import-site`) and each thread's link resolves against that
  origin; without it, imported posts have no permalink until you set
  one by hand.

**Timestamps round-trip through UTC, not local time.** The dumper
writes `created` as a UTC `YYYY-MM-DD HH:MM:SS` string alongside the
raw epoch float in `created_epoch` — the adapter reads `created_epoch`
directly, so nothing here affects an import into Garrul. It matters
only if that same JSON is ever fed back into `isso import -t generic`:
isso's importer parses `created` with a **local-time** `mktime` and
ignores `parent`/`mode` entirely, so a round-tripped comment lands as
an approved root and its timestamp shifts by the importing machine's
UTC offset. See `docs/importing.md` for the full intermediate format
and this caveat in more detail.

**The importer is source-agnostic underneath.** `src/lib/import/core.ts`
holds everything true of every source — identity derivation,
idempotency, threading, depth capping, the size and gzip handling — and
`src/lib/import/disqus.ts`, `src/lib/import/remark42.ts`,
`src/lib/import/comentario.ts` and `src/lib/import/isso.ts` are just the
adapters that know how to read one format each. The CLIs are thin for the same reason:
`scripts/import-cli.ts` holds the flag parsing, the wrangler-backed D1
shim and the error hygiene, and each `scripts/import-<source>.ts` is a
docblock plus a call. A new adapter is one
file exporting an `ImportAdapter`; the remaining sources are tracked in
 #104, and they inherit all of the above rather than reimplementing it.

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

**Vulnerability disclosure (`security.txt`).** Set a disclosure contact —
Admin → Settings → Vulnerability disclosure, or the `SECURITY_CONTACT`
var as the deploy-time default — and the instance serves
`GET /.well-known/security.txt` (RFC 9116), the standard place a
security researcher looks for where to report a problem with *your
deployment*. Accepts an email address (published as `mailto:`) or an
`https://`/`mailto:` URI; anything else is treated as unset, and unset
means the route answers 404 rather than publishing a file that points
nowhere. `Expires` is generated ~6 months out on every response, so the
file never goes stale on its own. Like `/AGENTS.md`, the route is public
and needs no `Origin`.

### Mount cost and free-tier headroom (since v2.15.0)

The Workers free tier allows **100,000 requests/day**, and what a
comment widget spends that on is almost entirely *mounts* — a request
happens on every pageview whether or not the reader engages. So mount
cost is what sets the pageview ceiling for an install, and it is the
one number worth knowing before you worry about anything else on this
page.

A mount now costs **two** requests on a post with the comment box
rendered:

- `GET /api/v1/bootstrap?slug=…` — the config, the session user, the
  first page of comments, and page-level engagement and subscription
  state when those surfaces are on.
- `GET /api/v1/comments/form-token` — the signed form-render timestamp
  behind the anti-spam timing heuristic, prefetched when the composer
  renders. It stays a separate call on purpose: a shared timestamp would
  hand every reader the same start time and defeat the check. It costs a
  request even with that heuristic off, because the route 404s rather
  than not existing.

Before v2.15.0 it was four requests for a default install
(`/api/v1/config`, then `/api/v1/auth/me` and `/api/v1/comments` in
parallel, plus the form token) and six with page reactions/votes and
subscriptions enabled. Against the 100,000 requests/day allowance,
roughly: ~25k pageviews/day of headroom became ~50k, and an install
running every surface went from ~16k.

`/embed.js` is not in that count — it ships `s-maxage=86400`, so the
edge serves it and the Worker sees it about once per colo per day.

Two consequences worth planning around:

- **Enabling page reactions, page votes or subscriptions no longer
  costs you a request per pageview.** Those two sections ride along in
  the mount payload. They still cost D1 reads.
- **Lazy-loading matters less than it used to.** Deferring `embed.js`
  until the comments section scrolls into view still takes a bouncer
  to zero, so it is still worth doing on a high-traffic blog — but the
  saving is 2 requests per bounce, not 4 to 6.
- **Posting a comment normally costs one request, not two** (since
  v2.20.0). The widget renders the new comment from the `201` echo
  instead of re-fetching the thread's first page. That also fixed the
  case where a reader's own comment was missing after posting on a
  thread past `comments_per_page` under the oldest-first sort. It still
  spends the old second request when the echo cannot be placed — a
  Worker older than the bundle, or a reply whose spot on the page is not
  determined yet — so budget one per comment, occasionally two.

Nothing was removed. Every endpoint the old mount called still exists
and still behaves identically, and a widget bundle newer than the
Worker serving it falls back to the old sequence on a 404, so a
rollback or a pinned `embed.js` from another origin keeps working.

The tree portion of the bootstrap response is edge-cached for anonymous
readers exactly as `GET /api/v1/comments` is, and *in the same cache
entry* — a first page warmed by either route serves the other, and the
existing invalidation on a comment mutation covers both. Signed-in
readers still bypass that cache entirely. The bootstrap response as a
whole carries no cache headers, because it varies by session and by
locale.

You can watch the effect on **`/admin/usage`**, which reads Cloudflare
analytics for request counts (needs `CF_API_TOKEN` + `CF_ACCOUNT_ID`).
Expect requests-per-pageview to drop on the first deploy after the
upgrade, with a tail from readers still running a cached older bundle.

## 11. Backups and data export

D1 is the only durable store. KV holds sessions (30-day TTL), widget
OAuth handoff tokens (60-second TTL), and rebuildable caches (resolved
settings, version check, optional Workers-AI spam verdicts). Rate-limit
counters and the comment first-page and counts caches live in the edge
Cache API (`caches.default`), not KV — so they never count against the
KV write budget. If you enabled the optional `RATE_LIMIT_DO` Durable
Object, its counters are in-memory only and equally not worth backing
up: losing them just resets the current windows.

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
runs on the Cache API, or on the Durable Object if you bound one);
`OAUTH_STATE` holds 60-second widget handoff
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

### Exporting one person rather than the database

For a data-subject access or portability request, don't hand over a `.sql`
dump — it contains everyone. `/admin/users/<id>` → **Export personal
data**, or `GET /admin/api/users/:id/export`, returns that one account's
rows as JSON. Contract and caveats are in §10.

The hashed-IP warning above applies unchanged: an export carries the
subject's `comments.ip_hash` values, so against anyone who also holds
`IP_HASH_SECRET` you are disclosing IP addresses. Verify the requester
before you send it, and don't attach it to an unverified email thread.
[`docs/compliance/dsar-runbook.md`](docs/compliance/dsar-runbook.md).

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
npx wrangler d1 execute DB --remote --command \
  "UPDATE comments SET ip_hash = NULL, user_agent = NULL
   WHERE (ip_hash IS NOT NULL OR user_agent IS NOT NULL);"

npx wrangler d1 execute DB --remote --command \
  "UPDATE reports SET reporter_ip_hash = NULL WHERE reporter_ip_hash IS NOT NULL;"

# 3. Anonymous ghost identities. See the warning below BEFORE running this.
npx wrangler d1 execute DB --remote --command \
  "UPDATE users SET provider_id = NULL WHERE provider = 'anon' AND provider_id IS NOT NULL;"

# 4. Rotate the secret.
npx wrangler secret put IP_HASH_SECRET

# 5. Confirm nothing survived.
npx wrangler d1 execute DB --remote --command \
  "SELECT (SELECT COUNT(*) FROM comments
             WHERE (ip_hash IS NOT NULL OR user_agent IS NOT NULL)) AS comments,
          (SELECT COUNT(*) FROM reports WHERE reporter_ip_hash IS NOT NULL) AS reports,
          (SELECT COUNT(*) FROM users WHERE provider = 'anon' AND provider_id IS NOT NULL) AS ghosts;"
```

`DB` there is the *binding*, not the database name — `wrangler d1
execute` takes either, and the binding is the same on every install
whatever you called the database. Nothing to substitute.

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

### Personal-data breach

The section above is the *technical* response to one specific leak. This is
the reporting obligation that sits on top of any of them, because you are
the controller of the data in your instance.

**The clock is 72 hours** from the moment you become *aware* — not from the
moment you finish investigating (GDPR Art. 33(1)). Awareness includes a
processor telling you: if Cloudflare or Resend notify you of an incident
affecting your data, your clock started when their mail arrived. An
incomplete notification inside 72 hours beats a complete one on day four;
Art. 33(4) explicitly allows filing in phases.

**Step 1 — contain, without destroying evidence.**

- Rotate whatever leaked (`wrangler secret put …`). If it was
  `IP_HASH_SECRET`, run the emergency purge above *before* rotating.
- Revoke sessions if an admin credential or the `SESSIONS` namespace is in
  scope. Per account there is a button: "Sign out everywhere" on
  `/admin/users/:id` (on your own account it keeps the session you're
  clicking from). For a namespace-wide wipe there is not: sessions are
  `sess:<hex>` keys in KV, so you delete them with `wrangler kv key list` /
  `kv bulk delete` against that namespace. Everyone signs in again; nothing
  else breaks.
- Rotate per-endpoint webhook secrets from `/admin/webhooks` — they live in
  D1, so a database dump exposes them.
- Snapshot logs and take a dated `.sql` export *before* purging anything, and
  keep both encrypted and off shared storage. You will need them to describe
  the scope, and Art. 33(5) requires you to keep the record regardless.

**Step 2 — establish what was actually exposed.** For a D1 dump, that is:

| Data | Why it matters |
| --- | --- |
| Subscriber **email addresses** | The one class that is not already public. This is usually what makes a breach notifiable. |
| `comments.ip_hash`, `reports.reporter_ip_hash`, anon `users.provider_id` | Pseudonyms **unless the leak also included `IP_HASH_SECRET`** — in which case treat it as an IP-address disclosure, because the construction is unsalted and IPv4 is brute-forceable. |
| OAuth `email`, `name`, `avatar_url`, `provider_id` | Links a real identity to everything that account wrote. |
| `comments.body_md` / `body_html` | Already public on your site; not usually a disclosure. Pending, spam and soft-deleted rows are the exception — those were never published. |
| `telegram_links` | External chat ids for operators. |
| `subscriptions.token` / `confirm_token` | Lets a holder unsubscribe or confirm someone else. Low severity, real nuisance. |
| `webhook_endpoints.secret` | Lets a holder forge signed events at your endpoints. |

**Sessions are not in D1.** A database dump does not hand anyone a login —
session ids live in KV. That is worth stating in your assessment, because it
narrows the risk considerably.

**Step 3 — decide, and be honest about it.** Notify the supervisory
authority unless the breach is "unlikely to result in a risk" (Art. 33(1));
notify the **subjects** too where the risk is *high* (Art. 34(1)). The
combination that usually clears the "high risk" bar here is **an email
address plus the pseudonymous comments belonging to it** — that is
deanonymisation, and on a site about health, politics, sexuality or
employment it is exactly the harm the article is aimed at. Comment bodies
alone, already published under names their authors chose, usually is not.

Encryption is the Art. 34(3)(a) escape hatch, and hashing is **not**
encryption: an `ip_hash` leaked alongside its key does not qualify.

**Step 4 — record it either way.** Art. 33(5) requires an internal register
of *all* breaches, including the ones you decided not to report, with the
facts, the effects, and the remedial action. Your notification, if you filed
one, is part of that record.

Article-level detail, and where the erasure and export mechanisms fit:
[`docs/compliance/gdpr.md`](docs/compliance/gdpr.md). California has its own
regime (Civ. Code § 1798.29 / § 1798.82) with a different trigger set — see
[`docs/compliance/ccpa.md`](docs/compliance/ccpa.md).

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
4. **Drift detection** (read-only): secrets via `wrangler secret list`; `[vars]`, KV and D1 by parsing `wrangler.toml`; migrations via `SELECT name FROM _migrations`; renderer via `CURRENT_RENDERER_VERSION` vs `target.renderer.version`. Also compares each `[vars]` *value* against the placeholder the target ships — see *Unedited placeholders* below
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
| `vars[]`             | Each `wrangler.toml` `[vars]` name + `required` flag, plus `placeholder` for the four that ship one |
| `kvNamespaces[]`     | Each KV binding name                                        |
| `d1Databases[]`      | Each D1 binding + database name                             |
| `analyticsDatasets[]` | Workers Analytics Engine datasets                          |
| `migrations[]`       | List of `NNNN_*.sql` files in `src/db/migrations/`          |
| `breakingChanges[]`  | Free-text entries with `summary` + `manualSteps` + `addedIn` |

The committed manifest is generated by
`npm run manifest:build` and validated in CI by `npm run manifest:check`,
which fails if the source tree drifts from the declared contract. Both
`secrets[]` and `vars[]` come from `scripts/config-registry.ts` (§5).

`breakingChanges[]` is cumulative — entries are never removed, so an
operator on any supported version can still be warned. The plan filters
them by `addedIn` against the installed version, the same way `vars[]` and
`secrets[]` are filtered: a 2.5.0 → 2.7.1 hop prints none, while a 1.19.0
→ 2.7.1 hop still prints all nine. `manifest:check` rejects an entry with
no `addedIn`, since one would otherwise be shown to every operator on
every upgrade forever. The field is optional in the schema only so that
manifests published before 2.7.1 still parse.

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

### Unedited placeholders

The plan opens with any `[vars]` still set to the value
`wrangler.example.toml` ships them as — `ALLOWED_ORIGINS`,
`ADMIN_EMAILS`, `PUBLIC_BASE_URL`, `OAUTH_CALLBACK_BASE`:

```
Still set to the example value shipped in wrangler.example.toml:
  • PUBLIC_BASE_URL = "https://comments.example.com" — public URL of this Worker…
```

Nothing else in the upgrade path can catch these. Every var is
`required: false` by design, so `diffVars` never reports one — and these
are *set*, just set to `example.com`. A deploy with untouched example
values passes every check here and then fails at runtime with the two
most-reported errors in `docs/troubleshooting.md`: CORS rejections and
`redirect_uri_mismatch`. Neither error message points back at
`wrangler.toml`.

It is a warning, never a blocker. An operator whose domain really is
`example.com` must still be able to upgrade.

The placeholder strings live in `wrangler.example.toml` and nowhere
else. `npm run manifest:build` reads them out of that file and into
`vars[].placeholder`, and fails loudly if a var the registry marks
`mustEdit` has no string value there — the check going quiet is the
failure this is built to avoid. They travel in the manifest so an old
install is checked against the *target's* placeholders, not its own
checkout's.

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
reappears for each new tag. The check is cached in KV for 1h
(`meta:latest-release` in `TREE_CACHE`); a transient GitHub failure
caches a null marker for the same 1h to avoid hammering the API. Set the
optional `GITHUB_TOKEN` secret if you hit GitHub's 60/hr unauth rate
limit on shared Cloudflare egress IPs.

### Widget visual regression (`npm run vr`)

`npm run vr` shows you what a widget change actually does to readers'
rendering, not just that tests pass. It builds the widget twice — once
from a baseline git ref (default `main`; `--base <ref>` to compare
against, say, the tag you are upgrading from) and once from the current
working tree — mounts both against a local, seeded `wrangler dev`,
screenshots them in headless Chromium across five theme scenarios
(`auto`, `light`, `dark`, `light-on-dark`, `turnstile`), and pixel-diffs
each pair with ImageMagick.

Prerequisites, all local: Chromium at `/usr/bin/chromium`, ImageMagick
(the `compare` binary), and `python3`. Ports 8787 and 8080 must be free
— the script refuses to start if either is taken and names the holder
rather than killing it. It never touches a deployed instance, and it
never modifies your working tree: the baseline is built in a throwaway
git worktree that is removed afterwards.

Reading the report: one row per scenario — changed-pixel count
(ImageMagick's AE metric), the percentage of the 900×2200 shot that
changed, and the diff image path; the baseline and current shots sit
next to each diff in the run directory printed on the last line, kept
for eyeballing. Intentional diffs are normal, so the script exits 0
whenever the run completed; a nonzero exit means the harness itself
failed (build, server, screenshot, or compare). Two quirks to keep in
mind: headless Chromium reports `prefers-color-scheme: dark`, so the
`auto` scenario exercises the dark branch; and the `turnstile` scenario
force-reveals the normally hidden Turnstile slot with a dummy frame,
since a screenshot run can never focus the composer to arm the real one.

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

**Turnstile never appears at all.** Check that the visitor focused the
comment box — the mount is deferred until they do (section 7). If it
still doesn't appear on focus, it's the host CSP: `frame-src` must allow
the Worker origin. `docs/troubleshooting.md` has the full recipe.

**A commenter reports a permanently dead Post button.** That is the one
sticky Turnstile state. It is now reserved for errors a retry cannot fix:
a Turnstile code the vendor marks non-retryable, a second error after the
one-shot retry already ran, or a frame that never came up. Codes marked
retryable reset the challenge and leave the composer usable, so this
report is real signal rather than possible noise. Check
`challenges.cloudflare.com` reachability and that `TURNSTILE_SITE_KEY`
matches Cloudflare — those are the usual causes. One exception: within
five minutes of an upgrade, a cached older frame document sends no error
code, which latches by design. A reload clears it. See `docs/ANTISPAM.md`
§ "Turnstile mount timing" for the detail.

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

**Moderator email never arrives.** Everything above applies first — it
uses the same provider and the same cron. Then check the switch: it is
**off by default** and off *silently*, so an instance whose reader
digests work fine will still send you nothing until
`MODERATOR_EMAIL_ENABLED` (or *Settings → Moderation → Email me about
the queue*) is on. Note the flag gates the **enqueue** as well as the
send, so turning it on won't retroactively mail you about a queue that
built up while it was off. Also confirm `ADMIN_EMAILS` is populated, or
`MODERATOR_NOTIFY_EMAILS` if you set one — with neither, the pass
returns without sending.

**`*.workers.dev` in production.** Works just enough to be tempting,
then breaks sign-in for Safari/Brave users. Map a custom subdomain
(section 10).

For deeper failure modes see `docs/troubleshooting.md`. For embed-side
issues (widget mount, CSP, slug derivation) the user should consult
`AGENTS.md` instead — those concerns belong on the integrator side.
