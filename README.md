# Garrul

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=github)](https://github.com/sponsors/KingPin)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/kingpinx)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

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

## Install

Deploying to production takes ~20 minutes the first time. Step-by-step
guide — prerequisites, OAuth setup, Turnstile, custom domain, remote
migrations, deploy, smoke test — lives in [`INSTALL.md`](INSTALL.md).

For a quick local poke-around once you've installed deps:

```bash
git clone https://github.com/KingPin/Garrul.git comments
cd comments
npm install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
npm run migrate           # local Miniflare DB
npm run dev               # http://localhost:8787
```

Drop the widget into any page:

```html
<div id="garrul" data-slug="hello-world" data-api="https://comments.example.com"></div>
<script src="https://comments.example.com/embed.js" defer></script>
```

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

### Per-platform integration snippets

- [Astro](examples/astro/README.md) — content-collection slug + shared `<Comments>` component
- [WordPress](examples/wordpress/README.md) — child-theme partial + disabling native WP comments
- [Hugo](examples/hugo/README.md) — `comments.html` partial wired off `.File.ContentBaseName`
- [Jekyll](examples/jekyll/README.md) — `_includes/comments.html` keyed on `page.slug`
- [Plain HTML](examples/plain-html/index.html) — minimal copy-paste page
- [Iframe](examples/iframe/index.html) — auto-resize listener for CSP-strict hosts

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
  production. Map a custom subdomain (see [`INSTALL.md`](INSTALL.md)).

## Contributing

Bug reports and PRs welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md). Project conventions and code
layout are documented in [`CLAUDE.md`](CLAUDE.md).

## License

Apache 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
