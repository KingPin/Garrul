# Garrul — Project Conventions

Self-hosted comment system on Cloudflare Workers + D1 + KV + Turnstile. This file documents conventions for human and AI contributors. Read it before writing code or opening a PR.

## Stack

- **Runtime**: Cloudflare Workers (not Pages Functions).
- **Framework**: Hono (TypeScript).
- **Database**: Cloudflare D1 (SQLite).
- **KV**: rate-limits, OAuth state, sessions, tree cache.
- **Anti-spam**: Cloudflare Turnstile.
- **Email**: pluggable adapter (Resend default; MailChannels/Postmark adapters available).
- **Widget**: vanilla TypeScript, no framework. Built with esbuild. Bundle budget: `embed.js` ≤ 20KB gzipped.
- **Admin UI**: server-rendered HTML (Hono JSX) + Alpine.js for interactivity.
- **Tests**: Vitest + Miniflare for in-memory D1/KV.

## Layout

```
src/
  index.ts              # Hono app entry, route mounting
  routes/               # one file per logical surface (api.comments, auth, admin, embed, rss, health)
  db/                   # migrations + typed query wrappers
  lib/                  # session, markdown, turnstile, ratelimit, oauth, ulid, identicon, ip-hash, webhook, cors, log
  email/                # adapter interface + per-provider impls
  i18n/                 # en.ts string table; t(key) shim
  widget/               # embed.ts (script), iframe.ts, iframe-resizer.ts, styles.css, templates.ts
  admin-ui/             # JSX layouts and pages
test/                   # Vitest suites
examples/               # host-site integration snippets (astro, wordpress, hugo, jekyll, plain-html)
scripts/                # setup.sh, rerender.ts, seed-demo.ts, db-export.sh
docs/                   # THEMING.md, privacy-policy.template.md, tos.template.md
.github/workflows/      # ci.yml, release.yml
```

## Conventions

### API versioning
All HTTP API routes live under `/api/v1/...`. Future breaking changes ship as `/api/v2`. Health is `/api/v1/health`.

### Cookies
Session cookies are `SameSite=None; Secure; HttpOnly; Partitioned`. Cross-site embed depends on this; do not change without understanding Safari ITP and Chrome 3PC behavior. Dev fallback: `SameSite=Lax` only when `ENV=dev`.

### CSRF
Browser CSRF defense is the `Origin` header allowlist (reuses `ALLOWED_ORIGINS`). Every state-changing route (`POST/PATCH/DELETE`) goes through the origin check middleware.

### Markdown
Server-side render via `marked` with a strict allowlist renderer in `src/lib/markdown.ts`. Allowed: `p br em strong code pre a blockquote ul ol li`. No raw HTML. No images. Links auto-get `rel="nofollow ugc"`. URLs validated against `^(https?:|mailto:)`. Every comment stores `body_md`, `body_html`, and `renderer_version`. Bump `CURRENT_RENDERER_VERSION` to trigger a re-render via `scripts/rerender.ts`.

### Sessions
Random 32-byte session ID in an HttpOnly cookie, KV-looked-up. No JWT. KV `SESSIONS` namespace, 30-day TTL, refreshed on use.

### Avatars
Server-side identicons for anonymous (deterministic from `user.id`, inline SVG). Provider avatar URL for OAuth. **No Gravatar.**

### IP handling
Never log or store raw IPs. Hash via HMAC-SHA-256 with `IP_HASH_SECRET` as the key (Workers don't ship BLAKE3 natively). `src/lib/ip-hash.ts` is the single entry point.

### Migrations
Forward-only SQL files in `src/db/migrations/NNNN_name.sql`. The `_migrations` table tracks applied. `npm run migrate` is idempotent. Never edit a migration that has been applied to prod.

### Logging
Use `src/lib/log.ts`. Every request gets an ID; every log line is JSON. Operators tail with `wrangler tail`. No PII (names, emails, comment bodies) in logs.

### Tests
Critical paths only: API contracts, sanitizer (XSS attempts), auth cookie roundtrip, rate-limit, depth cap. No coverage threshold. Tests must not require network or paid services — Miniflare for D1/KV, mocks for OAuth/email/Turnstile.

### Commits
Atomic commits per concern. Conventional-commits style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`). No giant "milestone done" commits.

### Secrets
Never commit `wrangler.toml` (gitignored — `wrangler.example.toml` is the template). Secrets go through `wrangler secret put` for production and `.dev.vars` (gitignored) for local. `.dev.vars.example` is the template.

### i18n
All user-facing strings go through `t(key)` from `src/i18n`. English is the only locale shipped in v1, but the indirection is in place from day 1 so translations don't require a refactor.

## Out of scope (v2 backlog)

Multi-site/multi-tenant per Worker, real-time updates, image uploads, Disqus/WordPress importers, self-serve account-delete, @mentions, in-comment search, generic OIDC, webhook signing.

## Domain layout (maintainer's instance)

- `garrul.com` — static marketing/landing (separate from this Worker).
- `comments.garrul.com` — this Worker (the canonical demo instance).
- Self-hosters: documented pattern is `comments.<yourdomain>`.

## CI

GitHub Actions workflows ship in `.github/workflows/` but every job is gated with `if: ${{ github.event.repository.private == false }}` while the repo is private. They auto-enable when the repo is flipped public at v1.0.
