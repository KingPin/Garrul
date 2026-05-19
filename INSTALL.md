# Installing Garrul

End-to-end guide to deploying Garrul to production on Cloudflare
Workers. If you just want to poke at it locally, see the
[local development](#local-development) section at the bottom.

Estimated time: **20–30 minutes** the first time, most of it
spent waiting for DNS and clicking through OAuth consent screens.

> **Using an AI assistant for install?** `AGENTS-OPERATE.md` at the
> repo root is purpose-built for AI coding assistants helping you
> stand up a Garrul Worker — point your AI at it.

## Prerequisites

- A **Cloudflare account** (free plan is fine for small operators).
- A **domain on Cloudflare DNS**. The custom-domain route needs the
  zone to be on Cloudflare; if your DNS is elsewhere, move it first
  or skip the custom domain (not recommended — see
  [Custom domain](#5-configure-wranglertoml) below).
- **Node.js ≥ 22** and `npm`. The repo's `.nvmrc` pins the version.
- A few external credentials, gathered as you go:
  - GitHub OAuth app (optional, for GitHub sign-in)
  - Google OAuth app (optional, for Google sign-in)
  - Cloudflare Turnstile site + secret keys (required for anonymous
    commenting)
  - Resend API key (optional, for email digests)

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
Secret — you'll feed both to `wrangler secret put` in step 4.

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
./scripts/setup.sh
```

`setup.sh` will:

- create the D1 database (`garrul-db`) and four KV namespaces,
- write their generated IDs into `wrangler.toml`,
- prompt you to set each production secret via
  `wrangler secret put`. Skip any you don't have yet — you can
  re-run `wrangler secret put NAME` later.

Have these handy for the secret prompts:

| Secret                | Where it comes from                                |
| --------------------- | -------------------------------------------------- |
| `IP_HASH_SECRET`      | A random 32+ char string you generate              |
| `TURNSTILE_SITE_KEY`  | From step 3                                        |
| `TURNSTILE_SECRET`    | From step 3                                        |
| `GH_CLIENT_ID`        | From step 2 (GitHub)                               |
| `GH_CLIENT_SECRET`    | From step 2 (GitHub)                               |
| `GOOGLE_CLIENT_ID`    | From step 2 (Google)                               |
| `GOOGLE_CLIENT_SECRET`| From step 2 (Google)                               |
| `RESEND_API_KEY`      | <https://resend.com/api-keys> (only if using digests) |
| `WEBHOOK_URL`         | Optional — fire-and-forget POST on comment events  |

Tip for generating secrets: `openssl rand -hex 32`.

## 5. Configure `wrangler.toml`

Open `wrangler.toml` and set the non-secret values:

```toml
[vars]
ALLOWED_ORIGINS = "https://yourblog.example.com"   # comma-separated
ADMIN_EMAILS    = "you@example.com"                # comma-separated
PUBLIC_BASE_URL     = "https://comments.example.com"
OAUTH_CALLBACK_BASE = "https://comments.example.com"
EMAIL_PROVIDER = "resend"                          # remove if not using digests
EMAIL_FROM     = "Garrul <comments@example.com>"   # must be a verified Resend sender
```

**Custom domain (strongly recommended).** Uncomment the `routes`
block and point it at your subdomain:

```toml
routes = [
  { pattern = "comments.example.com", custom_domain = true }
]
```

`custom_domain = true` requires the apex zone (`example.com`) to be
on Cloudflare DNS. Wrangler creates the proxied subdomain record
for you on first deploy.

Workers on `*.workers.dev` work but trigger third-party-cookie
blocks in Safari and Brave — sign-in breaks for those users. Use a
real subdomain in production.

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

## 8. Verify

Smoke test the deploy:

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

## Cron / digest emails

`wrangler.example.toml` ships with a cron trigger that runs every
15 minutes to deliver email digests. The cron fires automatically
on deploy. If `EMAIL_PROVIDER`/`RESEND_API_KEY` are unset, the job
no-ops cleanly. Remove the `[triggers]` block if you don't want
the cron registered at all.

## Configuration reference

Non-secret values live in `wrangler.toml` under `[vars]`. Secrets
go through `wrangler secret put NAME` (one secret per command;
never check secrets into the repo).

| Variable                       | Required             | Notes |
| ------------------------------ | -------------------- | ----- |
| `ALLOWED_ORIGINS`              | yes                  | Comma-separated origins allowed to embed and POST. No trailing slash. |
| `ADMIN_EMAILS`                 | yes                  | Comma-separated; matching OAuth signups auto-admin. |
| `PUBLIC_BASE_URL`              | yes                  | Public URL of this worker; used in permalinks and digests. |
| `OAUTH_CALLBACK_BASE`          | if OAuth enabled     | Same value as `PUBLIC_BASE_URL` in most setups. |
| `IP_HASH_SECRET`               | yes                  | HMAC-SHA-256 pepper. Never store raw IPs. |
| `TURNSTILE_SITE_KEY` / `_SECRET` | for anon commenting | From the Turnstile dashboard. |
| `GH_CLIENT_ID` / `_SECRET`     | for GitHub sign-in   | From your GitHub OAuth app. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | for Google sign-in   | From your Google OAuth client. |
| `EMAIL_PROVIDER`               | for digests          | Set to `resend`. |
| `RESEND_API_KEY`               | for digests          | Sender domain must be verified in Resend. |
| `EMAIL_FROM`                   | for digests          | e.g. `Garrul <comments@example.com>`. |
| `WEBHOOK_URL`                  | optional             | Fire-and-forget POST on comment events. |
| `EDIT_WINDOW_MINUTES`          | optional             | Default 15. |
| `JWT_SECRET`                   | reserved             | Declared in bindings; not used yet (sessions are KV-backed). Safe to set a random value or skip. |

See `wrangler.example.toml` for the full template with inline comments.

## Updating

```bash
git pull
npm install
npm run migrate -- --remote   # only if new migrations landed
npm run deploy
```

If a release bumps the markdown renderer version, stored comments
are re-rendered lazily on read. To re-render eagerly:

```bash
npm run rerender
```

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
