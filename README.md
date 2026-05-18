# Garrul

Self-hosted comments for static sites and blogs. Runs on Cloudflare
Workers + D1 + KV + Turnstile. One Worker per site, no per-comment
billing, your data stays in your account.

- **Threaded comments** with markdown, reactions, edit/delete window
- **OAuth sign-in** (GitHub + Google) + anonymous posting with rate
  limiting and Turnstile
- **Embeddable widget** (~17 KB) with Shadow-DOM isolation, theme
  variables, and an iframe alternative
- **Email digests**, RSS feeds, comment counts, permalinks
- **Admin UI** for moderation queue + user management
- **Webhook out** on every comment event

## Quick start

You'll need a Cloudflare account with Workers + D1 + KV enabled, and a
domain (Cloudflare-managed or `*.workers.dev`).

```bash
git clone https://github.com/KingPin/Garrul.git comments
cd comments
npm install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
./scripts/setup.sh        # creates D1 + KV bindings, prompts for secrets
npm run migrate           # applies SQL migrations
npm run dev               # http://localhost:8787
```

Drop the widget into any page:

```html
<div id="garrul" data-slug="hello-world" data-api="https://comments.example.com"></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

That's it.

## Deployment

```bash
npm run deploy            # wrangler deploy
```

**Custom domain (strongly recommended).** Workers on
`*.workers.dev` cause third-party-cookie friction in Safari and Brave.
Map a subdomain — typically `comments.<yourdomain>` — under `routes`
in `wrangler.toml`:

```toml
routes = [{ pattern = "comments.example.com", custom_domain = true }]
```

Then update `OAUTH_CALLBACK_BASE` and `PUBLIC_BASE_URL` to match.

## Configuration

All settings live in `wrangler.toml` (`[vars]`) for non-secrets, and
`wrangler secret put NAME` for secrets. See `wrangler.example.toml`
for the full list with comments.

| Variable                   | Required | Notes                                              |
| -------------------------- | -------- | -------------------------------------------------- |
| `ALLOWED_ORIGINS`          | yes      | Comma-separated list of sites allowed to embed     |
| `ADMIN_EMAILS`             | yes      | Comma-separated; matching OAuth signups auto-admin |
| `OAUTH_CALLBACK_BASE`      | yes\*    | `https://comments.example.com` (matches OAuth app) |
| `PUBLIC_BASE_URL`          | yes\*    | Same as above; used in digest emails               |
| `TURNSTILE_SITE_KEY/SECRET`| yes\*\*  | Cloudflare Turnstile keys                          |
| `GH_CLIENT_ID/SECRET`      | optional | Enable GitHub sign-in                              |
| `GOOGLE_CLIENT_ID/SECRET`  | optional | Enable Google sign-in                              |
| `EMAIL_PROVIDER=resend`    | optional | Set with `RESEND_API_KEY` + `EMAIL_FROM`           |
| `WEBHOOK_URL`              | optional | Fire-and-forget POST on comment events             |
| `EDIT_WINDOW_MINUTES`      | optional | Default 15                                         |
| `IP_HASH_SECRET`           | yes      | Pepper for HMAC IP hashing (no raw IP storage)     |
| `JWT_SECRET`               | yes      | Cookie signing                                     |

\* Required if you use OAuth or email digests respectively.
\*\* Required for anonymous commenting; signed-in users skip Turnstile.

## Embedding

### Script tag (default)

```html
<div
  id="garrul"
  data-slug="my-post-slug"
  data-api="https://comments.example.com"
  data-title="My post title"
  data-url="https://example.com/my-post/"
></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

### Iframe (CSP-strict hosts)

```html
<iframe
  src="https://comments.example.com/embed/my-post-slug"
  style="width:100%;border:0;min-height:400px"
></iframe>
```

The iframe page posts content height to the parent via
`postMessage({type:"garrul:height", height})`. See
`examples/iframe/index.html` for a ~10-line auto-resize listener.

## Theming

The widget mounts in Shadow DOM, so host-page CSS doesn't leak in. To
restyle, override CSS custom properties on the host element — see
[`docs/THEMING.md`](docs/THEMING.md) for the full list. These names
are part of the public, semver-protected API.

## Backups

```bash
npm run db:export         # writes a .sql dump locally
```

Cloudflare also keeps point-in-time backups of D1; the export is for
your local archive.

## Operations

- **Logs**: `wrangler tail` — every request emits a JSON line with a
  request id. No PII (names, emails, comment bodies) is logged.
- **Metrics**: Workers Analytics Engine writes `comment.posted`,
  `oauth.complete`, `ratelimit.hit`, etc. View in the Cloudflare
  dashboard under your worker.
- **Admin UI**: `/admin` (requires an OAuth sign-in whose email is in
  `ADMIN_EMAILS`).
- **Re-render**: bumping the markdown sanitizer? Run
  `npm run rerender` to re-render stored comments in place.

## Privacy

Garrul stores:

- Comment bodies + author names
- Email addresses (OAuth users, and subscribers who opted in to digests)
- HMAC-SHA-256 hashed IP addresses (never the raw IP)
- Provider IDs and avatar URLs for OAuth users

To deploy a public instance, copy `docs/privacy-policy.template.md` and
`docs/tos.template.md`, fill in your contact details, and link them
from your blog footer.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md). Common things:

- **Safari users not signing in**: cookies are
  `SameSite=None; Secure; Partitioned`. You must serve over HTTPS, and
  Safari ITP still blocks the popup if `comments.<yourdomain>` hasn't
  been visited top-level — the widget falls back to a top-level
  redirect. Documented in detail in the troubleshooting page.
- **`*.workers.dev` warnings**: don't use `*.workers.dev` in
  production. Map a custom subdomain (see "Deployment").

## Contributing

Bug reports and PRs welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md). Project conventions and code
layout are documented in [`CLAUDE.md`](CLAUDE.md).

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
