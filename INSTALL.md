# Installing Garrul

End-to-end guide to deploying Garrul to production on Cloudflare
Workers. If you just want to poke at it locally, see the
[local development](#local-development) section at the bottom.

Estimated time: **a few minutes** to get a live instance on
`*.workers.dev`, or **20–30 minutes** for the full production setup —
most of that spent waiting on DNS and clicking through OAuth consent
screens.

You don't have to decide up front. `*.workers.dev` is a real
deployment on the same free tier, not a sandbox, and moving to a
custom domain later is one config block and a redeploy — no data
migration. Every step below works on both paths; only
[step 5](#5-configure-wranglertoml) differs.

> **Using an AI assistant for install?** `AGENTS-OPERATE.md` at the
> repo root is purpose-built for AI coding assistants helping you
> stand up a Garrul Worker — point your AI at it.

## Prerequisites

- A **Cloudflare account** (free plan is fine for small operators).
- **Node.js ≥ 24** and `npm`. The repo's `.nvmrc` pins the version.
- **Optional: a domain on Cloudflare DNS.** Only the custom-domain
  route needs it, and only because `custom_domain = true` requires the
  zone to be on Cloudflare. Skip it and you deploy to `*.workers.dev`
  instead — see [step 5](#5-configure-wranglertoml) for what that
  costs you.
- A few external credentials, gathered as you go:
  - OAuth apps for whichever sign-in providers you want (all
    optional): GitHub, Google, Facebook, X, Discord
  - Cloudflare Turnstile site + secret keys (required for anonymous
    commenting)
  - Resend API key (optional, for reply notifications by email)

## 1. Authenticate `wrangler`

Wrangler ships as a dev dependency, so `npm install` (next step)
will install it. After that, log in once per machine:

```bash
npx wrangler login
```

A browser tab opens; approve the OAuth scope. The token lands in
`~/.wrangler/config/default.toml`.

## 2. Register OAuth apps (optional)

Skip this step if you only want anonymous commenting.

Decide your worker's public URL first — typically
`https://comments.<yourdomain>`. The callback URL pattern is:

```
<OAUTH_CALLBACK_BASE>/api/v1/auth/<provider>/callback
```

So for `comments.example.com`:

- GitHub callback: `https://comments.example.com/api/v1/auth/github/callback`
- Google callback: `https://comments.example.com/api/v1/auth/google/callback`

**GitHub.** Create an OAuth app at
<https://github.com/settings/developers> → New OAuth App. Use the
callback URL above. Save the Client ID and generate a Client
Secret — you'll set both in step 4.

GitHub apps allow exactly one callback URL. If you need staging +
production, register two apps.

**Google.** Create OAuth credentials at
<https://console.cloud.google.com/apis/credentials> → Create
Credentials → OAuth client ID → Web application. Add the callback
URL under "Authorized redirect URIs."

Until you publish the app for verification, only test users on the
consent screen can sign in. For public deployments, complete
Google's OAuth verification (7–10 business days).

## 3. Create a Turnstile widget

Required for anonymous commenting. Signed-in users skip Turnstile.

1. Open <https://dash.cloudflare.com/?to=/:account/turnstile>.
2. Add a site. Hostname is your **blog**'s domain (the page that
   embeds the widget), not the worker.
3. Copy the **Site Key** and **Secret Key** — you'll set them in
   step 4.

## 4. Clone, install, run setup

```bash
git clone https://github.com/KingPin/Garrul.git comments
cd comments
npm install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
npm run setup
```

`npm run setup` will:

- create the D1 database (`garrul-db`) and four KV namespaces,
- write their generated IDs into `wrangler.toml`,
- generate `JWT_SECRET` and `IP_HASH_SECRET` and stream them
  straight into Cloudflare — the values are never written to disk,
- then offer two ways to set the remaining secrets.

### Bulk or one at a time

Nothing is lost by picking either; you can re-run `npm run setup`, or set
any secret later with `wrangler secret put NAME`.

**Bulk** (fewer keystrokes — one file, one upload):

```bash
cp secrets.example.env secrets.env   # then edit it
npx wrangler secret bulk secrets.env
rm secrets.env
```

`secrets.example.env` lists every secret Garrul reads, grouped by
feature, with a one-line note on where each value comes from.

> **Leave the lines you aren't using commented out.** Wrangler treats
> an empty value as a real, empty secret — an uncommented
> `RESEND_API_KEY=` overwrites your live key with nothing rather than
> skipping it. An unedited file is rejected outright, which is
> deliberate.

`secrets.env` holds plaintext credentials. It is gitignored; delete it
once the upload succeeds.

**One at a time**: `setup.sh` asks about each secret in turn and runs
`wrangler secret put` for the ones you say yes to. Skip anything you
don't have yet.

Have these handy either way:

| Secret                | Where it comes from                                |
| --------------------- | -------------------------------------------------- |
| `TURNSTILE_SITE_KEY`  | From step 3                                        |
| `TURNSTILE_SECRET`    | From step 3                                        |
| `GH_CLIENT_ID`        | From step 2 (GitHub)                               |
| `GH_CLIENT_SECRET`    | From step 2 (GitHub)                               |
| `GOOGLE_CLIENT_ID`    | From step 2 (Google)                               |
| `GOOGLE_CLIENT_SECRET`| From step 2 (Google)                               |
| `RESEND_API_KEY`      | <https://resend.com/api-keys> (only for email notifications) |
| `WEBHOOK_URL`         | Optional — fire-and-forget POST on comment events  |

Those are the common ones; `secrets.example.env` has the full set,
including the Facebook / X / Discord providers, Telegram, Akismet and
the Cloudflare usage dashboard.

Tip for generating a secret by hand:
`openssl rand -base64 32 | npx wrangler secret put NAME` — that keeps
the value off disk and out of your shell history.

## 5. Configure `wrangler.toml`

Open `wrangler.toml` and set the non-secret values:

```toml
[vars]
ALLOWED_ORIGINS = "https://yourblog.example.com"   # comma-separated
ADMIN_EMAILS    = "you@example.com"                # comma-separated
PUBLIC_BASE_URL     = "https://comments.example.com"
OAUTH_CALLBACK_BASE = "https://comments.example.com"
EMAIL_PROVIDER = "resend"                          # remove if you don't want email
EMAIL_FROM     = "Garrul <comments@example.com>"   # must be a verified Resend sender
```

Then pick where the Worker answers requests. Both options are real
deployments on the same free tier; the only difference is sign-in.

**Trying it out — `*.workers.dev`.** Leave the `routes` block
commented out and deploy. Cloudflare hands you a
`garrul.<your-subdomain>.workers.dev` URL, which `wrangler deploy`
prints in step 7. Set `PUBLIC_BASE_URL`, `OAUTH_CALLBACK_BASE` and
`ALLOWED_ORIGINS` to match once you have it.

**Running it for real — a custom subdomain.** Uncomment the `routes`
block and point it at your subdomain:

```toml
routes = [
  { pattern = "comments.example.com", custom_domain = true }
]
```

`custom_domain = true` requires the apex zone (`example.com`) to be
on Cloudflare DNS. Wrangler creates the proxied subdomain record
for you on first deploy.

**Why production wants the subdomain.** The embed's session cookie is
set from wherever the Worker lives, so on `*.workers.dev` it is a
third-party cookie for every host page — and Safari and Brave block
those, so sign-in silently fails for those readers. Anonymous
commenting, moderation and the admin UI are unaffected.

Switching from the first to the second is this config block plus a
redeploy. The D1 database, KV namespaces and every comment in them
stay exactly where they are.

## 6. Apply migrations to the production D1

```bash
npm run migrate -- --remote
```

Without `-- --remote`, migrations run against the local Miniflare
DB only — your deployed worker would 500 on the first request.

## 7. Deploy

```bash
npm run deploy
```

Wrangler uploads the worker, builds the embed bundle, and (if a
custom domain is configured) provisions the DNS record. The first
deploy can take ~30 seconds while the certificate is issued.

Wrangler prints the live URL when it finishes. On the `*.workers.dev`
path that URL is the one you didn't know yet in step 5 — put it into
`PUBLIC_BASE_URL` and `OAUTH_CALLBACK_BASE` now and deploy once more.
(`ALLOWED_ORIGINS` is unaffected: it lists the sites that embed the
widget, not the Worker itself.)

## 8. Verify

Smoke test the deploy (substitute your `*.workers.dev` URL if you
haven't set up a custom domain):

```bash
curl -fsSL https://comments.example.com/api/v1/health
# → {"ok":true,...}
```

Tail logs while you exercise it:

```bash
npm run tail
```

Open `https://comments.example.com/admin` and sign in with an
address listed in `ADMIN_EMAILS` to confirm OAuth + admin work.

Drop the widget into a page on your blog:

```html
<div id="garrul" data-slug="hello-world" data-api="https://comments.example.com"></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

Post a comment as a signed-in user and as a guest (the guest path
exercises Turnstile + rate-limit + sanitizer).

## Cron / reply notification emails

`wrangler.example.toml` ships with a cron trigger that runs every
15 minutes and delivers reply notifications to readers who subscribed
to a thread. It fires automatically on deploy. The cron is what
*debounces* the sends — a burst of replies coalesces into one email per
subscriber instead of N — not what schedules them; the send is caused by
the comment. If `EMAIL_PROVIDER`/`RESEND_API_KEY` are unset, the job
no-ops cleanly. Remove the `[triggers]` block if you don't want the cron
registered at all.

Full picture — reader flow, the other notification channels, and what to
check when mail doesn't arrive: [`docs/notifications.md`](docs/notifications.md).

## Configuration reference

Non-secret values live in `wrangler.toml` under `[vars]`. Secrets go
through `wrangler secret put NAME`, or `wrangler secret bulk` for a
whole file at once. Never check secrets into the repo.

The table below is the shortlist most instances need. The **complete**
reference — every setting, whether it's a var or a secret, and where it
goes — is section 5 of `AGENTS-OPERATE.md`, generated from
`scripts/config-registry.ts` so it cannot drift from the code.

| Variable                       | Required             | Notes |
| ------------------------------ | -------------------- | ----- |
| `ALLOWED_ORIGINS`              | yes                  | Comma-separated origins allowed to embed and POST. No trailing slash. |
| `ADMIN_EMAILS`                 | yes                  | Comma-separated; matching OAuth signups auto-admin. |
| `PUBLIC_BASE_URL`              | yes                  | Public URL of this worker; used in permalinks and notification emails. |
| `OAUTH_CALLBACK_BASE`          | if OAuth enabled     | Same value as `PUBLIC_BASE_URL` in most setups. |
| `IP_HASH_SECRET`               | yes                  | HMAC-SHA-256 pepper. Never store raw IPs. |
| `TURNSTILE_SITE_KEY` / `_SECRET` | for anon commenting | From the Turnstile dashboard. |
| `GH_CLIENT_ID` / `_SECRET`     | for GitHub sign-in   | From your GitHub OAuth app. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | for Google sign-in   | From your Google OAuth client. |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | for Facebook sign-in | From your Facebook app (developers.facebook.com). |
| `TWITTER_CLIENT_ID` / `_SECRET` | for X sign-in        | X OAuth 2.0 credentials; provider slug is `twitter`. X returns no email. |
| `DISCORD_CLIENT_ID` / `_SECRET` | for Discord sign-in  | From discord.com/developers → OAuth2. |
| `EMAIL_PROVIDER`               | for reply notifications | Set to `resend`. |
| `RESEND_API_KEY`               | for reply notifications | Sender domain must be verified in Resend. |
| `EMAIL_FROM`                   | for reply notifications | e.g. `Garrul <comments@example.com>`. |
| `WEBHOOK_URL`                  | optional             | Fire-and-forget POST on comment events. |
| `EDIT_WINDOW_MINUTES`          | optional             | Default 15; `0` disables editing. Overridable at runtime from Admin → Settings. |
| `JWT_SECRET`                   | required             | HMAC key for the signed OAuth state cookie. Sign-in fails without it. Generated by `setup.sh`. |

See `wrangler.example.toml` for the `[vars]` template with inline
comments, and `secrets.example.env` for the secrets.

## Updating

The one-liner:

```bash
npm run upgrade
```

That command pulls the latest tag, compares your live Worker against
the target version's `release-manifest.json`, prints a plan, asks you
to confirm, then applies it: create any missing KV/D1 bindings,
prompt for new secrets, run forward-only migrations, deploy.

Useful flags:

| Flag                    | Effect                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `--dry-run`             | Print the plan only. No git, wrangler, or deploy side effects. |
| `--version vX.Y.Z`      | Target a specific tag instead of "latest release."            |
| `--yes`                 | Non-interactive (CI). Refuses if any secret is missing — they need a value you must type. |
| `--allow-dirty`         | Proceed even if `git status` is non-empty.                    |
| `--skip-migrations`     | Skip `npm run migrate -- --remote`.                           |
| `--skip-deploy`         | Stop after migrations. Useful when staging a deploy by hand.  |
| `--rerender`            | Run `npm run rerender -- --remote` after deploy (if the renderer version bumped). |

The admin UI (`/admin`) shows a dismissible banner when a newer
release is available; the check is cached in KV for 1h and only fires
on admin requests.

**If you prefer to step through manually:**

```bash
git fetch --tags
git checkout vX.Y.Z
npm ci
npm run migrate -- --remote   # only if new migrations landed
npm run deploy
npm run rerender -- --remote  # only if the renderer version bumped
```

**Failure modes worth knowing:**

- Migration applied, deploy failed → migrations are forward-only and
  already committed; the previous Worker keeps serving traffic. Fix
  the deploy issue and re-run `npm run deploy`, or
  `wrangler rollback` to the prior deployment. Do **not** hand-revert
  the schema — Garrul migrations are additive.
- Missing secret with `--yes` → the orchestrator refuses, because a
  non-interactive value would have to be inlined (and that leaks via
  shell history / CI logs). Run interactively or set the secret first
  with `wrangler secret put NAME`.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for the
common failure modes: OAuth redirect mismatch, CORS errors,
Safari ITP + sign-in, Resend domain verification, etc.

## Local development

For a no-Cloudflare local loop after the initial install:

```bash
npm run migrate          # local Miniflare DB
npm run dev              # http://localhost:8787
```

`.dev.vars` holds local-only secrets. For OAuth or cross-origin
embed testing locally, see the troubleshooting doc's "Cookies and
sessions" section.
