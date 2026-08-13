# Garrul

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-db61a2?logo=github)](https://github.com/sponsors/KingPin)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/kingpinx)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Self-hosted comments for static sites and blogs. Runs on Cloudflare
Workers + D1 + KV + Turnstile. One Worker per site, no per-comment
billing, your data stays in your account.

**[Try the live demo →](https://comments.garrul.com)**

Self-hosted, but not the hard kind: **there is no container, no VPS, and
no database server**. Nothing to patch, no uptime to monitor, no TLS to
renew — Cloudflare keeps point-in-time backups of D1 for you. It is one
Worker, and keeping it current is a single dry-runnable command per
release. Two credentials to get started (a Turnstile key pair, from one
dashboard page); every other integration is optional.

- **Threaded comments** with markdown, reactions, edit/delete window
- **OAuth sign-in** (GitHub, Google, Facebook, X, Discord) + anonymous
  posting with rate limiting and Turnstile
- **Embeddable widget**, CI-capped at 30 KB gzipped, with Shadow-DOM
  isolation, theme variables, and an iframe alternative
- **Reply notifications by email**, built in — readers opt in from the
  widget, confirm by double-opt-in, and get a debounced digest when new
  comments land. No webhook or external pipeline required; bring a
  Resend key — [`docs/notifications.md`](docs/notifications.md)
- **Moderator notifications by email** — a digest of what's sitting in
  the queue or has been reported, to `ADMIN_EMAILS` or a shared alias.
  Off by default; one switch in *Settings → Moderation*
- **Import from Disqus** — upload an export in the admin UI, or run
  `npm run import-disqus -- ./export.xml --dry-run` to see the plan
  before it writes anything
- **RSS feeds**, comment counts, permalinks
- **Admin UI** for moderation queue + user management
- **Webhook out** on every comment event — generic, Slack, Discord, or Telegram
- **Telegram operator bot** — moderate from your phone with inline buttons,
  query the queue with `/queue` & `/stats`, optional daily digest

Every doc in the repo, grouped by task:
[`docs/README.md`](docs/README.md).

## Screenshots

What your readers see — threaded comments, reactions, and a markdown composer,
rendered inside a Shadow DOM so the host page's CSS can't collide with it:

![Garrul comment widget on a host page, showing the page reaction bar, the markdown composer, and a threaded discussion](docs/screenshots/widget-light.png)

The admin dashboard: counts at a glance, your embed snippet ready to copy, and
30-day comment volume.

![Admin dashboard showing comment and user counts, the embed snippet, and a comments-per-day chart](docs/screenshots/admin-dashboard.png)

The moderation queue, where comments are approved, marked spam, or deleted
inline:

![Moderation queue listing pending comments with author, body, metadata and per-row actions](docs/screenshots/admin-queue-pending.png)

More, including dark mode, mobile, and the rest of the admin UI:
[`docs/screenshots.md`](docs/screenshots.md).

## Install

Deploying to production takes ~20 minutes the first time — and then
`npm run upgrade` per release, which is one command with a `--dry-run`
that prints its plan before touching anything. That is the whole
maintenance story; there is no OS to patch and no service to restart.

Step-by-step guide — prerequisites, OAuth setup, Turnstile, custom
domain, remote migrations, deploy, smoke test — lives in
[`INSTALL.md`](INSTALL.md); upgrades in
[`INSTALL.md#updating`](INSTALL.md#updating).

**Want to try it first? No Cloudflare account needed.**
`.dev.vars.example` ships working dev defaults — including Cloudflare's
"always passes" Turnstile test keys — so this runs with zero edits and
zero credentials:

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

If your host page sets a Content-Security-Policy, allow the Worker
origin (where `embed.js`, the API, and the Turnstile-hosting iframe all
live):

```
script-src  ... https://comments.example.com;
connect-src ... https://comments.example.com;
frame-src   ... https://comments.example.com;
```

`script-src` lets the embed bundle execute, `connect-src` lets it call
the API, and `frame-src` lets the widget mount its same-origin iframe
that hosts the Turnstile anti-spam challenge. You do **not** need
`*.cloudflare.com` in your CSP — the challenge frame is nested inside
ours and governed by its CSP, not yours. See
[docs/troubleshooting.md](docs/troubleshooting.md) for symptom-by-symptom
diagnosis, or use the iframe variant below to keep your host CSP
untouched entirely.

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

### Language

The widget's language is a property of **the site, not the reader** — a
German visitor to an English blog gets an English comment box, because a
German composer under English prose reads as broken. `Accept-Language`
and `navigator.language` are deliberately never consulted.

```html
<div id="garrul" data-slug="my-post" data-lang="de"></div>
```

English, German, Spanish and French ship. The last three are
**machine-seeded** — LLM output no native speaker has checked — so they
are reachable only through an explicit `data-lang` and are never picked
up automatically from your `<html lang>`. If you speak one, correcting
it is a five-line PR and promotes the locale to reviewed:
[CONTRIBUTING.md](CONTRIBUTING.md#translations-wanted).

Resolution order, the iframe variant's `?lang=`, what is and isn't
translated, and how timestamps render:
[`docs/i18n.md`](docs/i18n.md).

### Per-platform integration snippets

- [Astro](examples/astro/README.md) — content-collection slug + shared `<Comments>` component
- [WordPress](examples/wordpress/README.md) — child-theme partial + disabling native WP comments
- [Hugo](examples/hugo/README.md) — `comments.html` partial wired off `.File.ContentBaseName`
- [Jekyll](examples/jekyll/README.md) — `_includes/comments.html` keyed on `page.slug`
- [Plain HTML](examples/plain-html/index.html) — minimal copy-paste page
- [Iframe](examples/iframe/index.html) — auto-resize listener for CSP-strict hosts

### Lazy-loading (saving Worker invocations)

By default the widget fires three Worker requests on page load
(`/api/v1/config`, `/api/v1/auth/me`, `/api/v1/comments?slug=…`),
before the reader has scrolled. On read-heavy blogs that's most of
your Cloudflare usage spent on bouncers.

See [`examples/lazy-load`](examples/lazy-load/README.md) for two
deferred-loading patterns: a scroll-into-view loader (recommended —
zero cost for bouncers, seamless for engaged readers) and a
click-to-load button (more savings, but documented caveats around
discussion visibility and engagement).

### Using an AI assistant?

Garrul ships an AI-targeted integration guide at `AGENTS.md` in this
repo. Once your instance is deployed it's also served at
`https://<your-garrul-host>/AGENTS.md` with embed snippets pre-filled
for your instance. Point your AI at either URL (use `?format=txt` if
your AI prefers plain text), and it'll have everything it needs to
embed Garrul on your site without re-deriving the data attributes,
slug conventions, or theming variables from source.

Self-hosters: `AGENTS-OPERATE.md` is the operator-side counterpart
(install, secrets, `ALLOWED_ORIGINS`, migrations).

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

## Access control

Your instance is gated by `ALLOWED_ORIGINS` (set in `wrangler.toml`,
comma-separated, no wildcards). Every request under `/api/*` — including
plain GET reads of comment trees, counts, and config — must carry a
matching `Origin` header. Browser fetches from your own sites send it
automatically; direct curl or scraper hits to `/api/v1/*` return
`403 err.origin.forbidden`.

Exempt by design (no `Origin` header reaches them):

- `GET /api/v1/health` — uptime probes
- `GET /api/v1/auth/:provider/{start,callback}` — OAuth top-level navigation
- `GET /feed/:slug`, `GET /c/:id`, `GET /embed/:slug`, `GET /embed.js` —
  outside the `/api/*` gate; intentionally public

**Build-time fetchers get 403s.** An SSG that reads comments at deploy
time should consume `GET /feed/:slug` (Atom, ungated) until the planned
API-keys system ships — design in
[`docs/api-keys-design.md`](docs/api-keys-design.md), not implemented.
Symptom-level help in
[`docs/troubleshooting.md`](docs/troubleshooting.md).

## Privacy

Garrul stores:

- Comment bodies + author names
- Email addresses (OAuth users, and subscribers who opted in to digests)
- HMAC-SHA-256 hashed IP addresses (never the raw IP) and user-agent strings
- Provider IDs and avatar URLs for OAuth users

No analytics, no tracking pixels, no advertising, no Gravatar. One
strictly-necessary cookie. Data-subject requests are served by a per-user
JSON export and an admin erase panel, both on `/admin/users/<id>`.

Deploying a public instance? Copy `docs/privacy-policy.template.md` and
`docs/tos.template.md`, fill in your contact details, and link them from
your footer.

Running an instance that European or Californian readers comment on makes
**you** the controller of that data, not this project.
[`docs/compliance/`](docs/compliance/) has the paperwork that follows: a
personal-data inventory, the data-subject rights mapped to the mechanisms
that serve them, CCPA/CPRA categories, a subprocessor register, and a DSAR
runbook. Not legal advice, and it does not claim Garrul "is GDPR
compliant" — compliance is a property of a deployment.

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
