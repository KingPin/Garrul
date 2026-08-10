# Garrul — Project Conventions

Self-hosted comment system on Cloudflare Workers + D1 + KV + Turnstile. This file documents conventions for human and AI contributors. Read it before writing code or opening a PR.

## Stack

- **Runtime**: Cloudflare Workers (not Pages Functions).
- **Framework**: Hono (TypeScript).
- **Database**: Cloudflare D1 (SQLite).
- **KV**: OAuth state, sessions, resolved settings, version checks, CF usage snapshots, the optional Workers-AI spam verdict cache.
- **Edge cache**: the comment-tree response cache and the rate limiter both use the Cache API (`caches.default`), *not* KV — see `src/lib/response-cache.ts` and `src/lib/ratelimit.ts`. The `TREE_CACHE` and `RATE_LIMITS` KV namespaces are still bound for historical reasons.
- **Never put a per-request write on KV.** The free tier allows 1000 writes/day *account-wide*, so any unauthenticated endpoint that writes KV per request is an account-wide outage primitive. Counters and response caches belong on the Cache API; KV is for sessions, OAuth state and settings.
- **Anti-spam**: Cloudflare Turnstile.
- **Email**: Resend only (`src/lib/email.ts`). The `EMAIL_PROVIDER` env var leaves room for more adapters, but Resend is the sole implementation today (MailChannels dropped its free Workers plan). Additional adapters are future work.
- **Widget**: vanilla TypeScript, no framework. Built with esbuild. Bundle budget: `embed.js` ≤ 20KB gzipped.
- **Admin UI**: server-rendered HTML (Hono JSX) + Alpine.js for interactivity.
- **Tests**: Vitest in the plain `node` pool. D1/KV are hand-rolled in-memory stubs, *not* Miniflare — see `vitest.config.ts`.

## Layout

```
src/
  index.ts              # Hono app entry, route mounting
  routes/               # one file per logical surface (api.comments, auth, admin, embed, rss, health)
  db/                   # migrations + typed query wrappers
  lib/                  # session, markdown, turnstile, ratelimit, oauth, ulid, identicon, ip-hash,
                        #   webhook, webhook-sig, cors, log, settings, thread, email (Resend), disqus-import
  i18n/                 # en.ts string table; t(key) shim
  widget/               # embed.ts (source), embed.bundled.ts (generated), load-error.ts
                        #   the iframe variant is a route, not a widget file: routes/embed-iframe.ts
  admin-ui/             # layout + per-page renderers (server-rendered HTML + Alpine attrs)
                        #   layout.ts, styles.ts, escape.ts
                        #   pages/   — dashboard, queue, comment-detail, users, user-detail,
                        #              audit, subscriptions, operator, settings, webhooks,
                        #              telegram, saved-replies, usage, about
                        #   components/ — spam-summary, host-filter
tests/                  # Vitest suites (+ tests/helpers/ for shared stubs)
examples/               # host-site integration snippets (astro, wordpress, hugo, jekyll,
                        #   plain-html, iframe, lazy-load)
scripts/                # setup.sh, rerender.ts, seed-demo.ts, db-export.sh, build-embed.ts,
                        #   build-agents-md.ts, build-version.ts, check-bundle-size.ts,
                        #   import-disqus.ts, upgrade.ts, upgrade/
docs/                   # THEMING.md, ANTISPAM.md, troubleshooting.md, webhooks.md, telegram.md,
                        #   api-keys-design.md, privacy-policy.template.md, tos.template.md
.github/workflows/      # ci.yml, release.yml, agents-docs-sync.yml
```

- `AGENTS.md`, `AGENTS-OPERATE.md` — AI assistant integration / operations guides. `AGENTS.md` is also served by the Worker at `/AGENTS.md` with light host templating.

## Conventions

### API versioning
All HTTP API routes live under `/api/v1/...`. Future breaking changes ship as `/api/v2`. Health is `/api/v1/health`.

### Cookies
Session cookies are `SameSite=None; Secure; HttpOnly; Partitioned`. Cross-site embed depends on this; do not change without understanding Safari ITP and Chrome 3PC behavior. Dev fallback: `SameSite=Lax` only when `ENV=dev`.

### CSRF
Browser CSRF defense is the `Origin` header allowlist (reuses `ALLOWED_ORIGINS`). Every state-changing route (`POST/PATCH/DELETE`) goes through the origin check middleware.

### Markdown
Server-side render via `marked` with a strict allowlist renderer in `src/lib/markdown.ts`. Allowed tags: `p br em strong del code pre a blockquote ul ol li`. Allowed attributes: `href`/`rel`/`target`/`title` on `<a>`, and `class="language-…"` on `<code>` (clamped to `CODE_LANG_RE`) — nothing else, on any tag. No raw HTML. No images. No tables. Task-list checkboxes render as literal `[ ]`/`[x]` text, not `<input>`. Links auto-get `rel="nofollow ugc noopener" target="_blank"`. URLs validated against `^(https?:|mailto:)`. Every comment stores `body_md`, `body_html`, and `renderer_version`. Bump `CURRENT_RENDERER_VERSION` when emitted HTML changes and re-render via `npm run rerender` (or `/admin/operator` → Rerender); `body_html` is served verbatim, so existing comments do not pick up a sanitizer change on their own.

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
Critical paths only: API contracts, sanitizer (XSS attempts), auth cookie roundtrip, rate-limit, depth cap. No coverage threshold. Tests must not require network or paid services — hand-rolled in-memory D1/KV stubs (see `tests/helpers/`), mocks for OAuth/email/Turnstile. Moving integration tests onto the Workers pool is future work; `@cloudflare/vitest-pool-workers` is deliberately *not* a dependency until then, so install it as part of that work (`vitest.config.ts:8-12`).

### Dependency overrides
`package.json` has no comment syntax, so every entry in `overrides` is documented here. All of them exist for the same reason: a Cloudflare dev-tooling package pins a transitive dependency to an *exact* version that has an open advisory, so Dependabot can never open a PR for it — only an override moves it. None of these packages reach the Worker runtime; they are build- and dev-time only.

Each override is temporary. Re-check them when bumping `wrangler`, and drop the entry once the upstream pin has caught up — a stale override silently holds a dependency *back*, which is the opposite of what it was added for.

| Override | Why | Drop it when |
| --- | --- | --- |
| `undici: ^7.29.0` | `miniflare` (via `wrangler`) pins undici at exactly 7.28.0. Clears five advisories, including GHSA-4cwx-7wf7-3272 (high, cross-user disclosure + parse-time crash via degenerate private cache directives). | `miniflare` pins undici ≥ 7.29.0 itself. Note the ceiling: if miniflare moves to undici 8.x, this `^7` range would pin it back — widen or remove it. |

### Commits
Atomic commits per concern. Conventional-commits style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`). No giant "milestone done" commits.

### Releases
Every tagged release must ship a concise, operator-focused changelog in the **GitHub Release body** — that's what `npm run upgrade` fetches and prints before the drift plan (`scripts/upgrade.ts`). `generate_release_notes: true` in `release.yml` is a starting point, not the final body: review and rewrite it before publishing.

- Group by `feat:` / `fix:` / `chore:` or `Highlights:` / `Notes:`. 3–6 lines is usually enough.
- Focus on what changes for someone running the upgrade (new env vars, new endpoints, behavior changes), not internal refactors.
- Patch releases get notes too, even one line. Never publish a stub body like `"v1.5.1"`.
- Mirror the same summary in the annotated tag message (`git tag -a vX.Y.Z -m "..."`) so `git show <tag>` is also useful.

### Secrets
Never commit `wrangler.toml` (gitignored — `wrangler.example.toml` is the template). Secrets go through `wrangler secret put` for production and `.dev.vars` (gitignored) for local. `.dev.vars.example` is the template.

### i18n
All user-facing strings go through `t(key)` from `src/i18n`. English is the only locale shipped in v1, but the indirection is in place from day 1 so translations don't require a refactor.

### Upgrades
`scripts/upgrade.ts` is the operator entry point (`npm run upgrade`). The version contract lives in `release-manifest.json` at repo root — auto-generated by `scripts/upgrade/build-manifest.ts`, validated in CI by `npm run manifest:check`. Hand-edit only the free-text fields (descriptions, `breakingChanges`).

## Out of scope (v2 backlog)

Multi-site/multi-tenant per Worker, real-time updates, image uploads, WordPress importer (Disqus import shipped), self-serve account-delete, @mentions, in-comment search, generic OIDC, per-post custom auto-close schedules (global rule + per-post manual override only), community hide-and-hold (auto-suppress on a downvote threshold — reader reporting + auto-collapse cover the moderation value without auto-suppressing legit content).

## Domain layout (maintainer's instance)

- `garrul.com` — static marketing/landing (separate from this Worker).
- `comments.garrul.com` — this Worker (the canonical demo instance).
- Self-hosters: documented pattern is `comments.<yourdomain>`.

## CI

GitHub Actions workflows ship in `.github/workflows/` and run unconditionally — the repo is public.

- `ci.yml` — `lint`, `typecheck`, `test`, `manifest:check`, `build`, `size`. Runs on push/PR to `main` plus `workflow_dispatch`.
- `release.yml` — fires on `v*` tags. Remember the auto-generated release body is a stub; rewrite it (see Releases above).
- `agents-docs-sync.yml` — fails a PR that touches watched source paths without updating `AGENTS.md` / `AGENTS-OPERATE.md`. Add the `agents-docs-ok` label to bypass for refactors and dep bumps.

Earlier versions gated every job on `github.event.repository.private == false` so private-repo pushes wouldn't burn billing. Those guards were removed once the repo went public. `ci.yml` and `release.yml` had grown a `|| github.event_name == 'workflow_dispatch'` escape hatch; `agents-docs-sync.yml` never did, so it sat unrunnable.
