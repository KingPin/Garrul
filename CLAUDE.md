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
- **Widget**: vanilla TypeScript, no framework. Built with esbuild. Bundle budget: `embed.js` ≤ 30KB gzipped. Widget CSS lives in `src/widget/styles.css` and is minified into `styles.gen.ts` at build time — comments there cost the source nothing and readers nothing.
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
.github/workflows/      # ci.yml, release.yml, docs-sync.yml
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

### Lint
`npm run lint` runs `biome lint`, deliberately **not** `biome check`. Biome classifies import sorting as an *assist* (`assist/source/organizeImports`), not a lint rule, so `check` reports it and `lint` does not. That convention has never been adopted here: `biome check` flags ~145 files, and this version also sorts named specifiers inside the braces, so adopting it means reordering imports nobody wrote wrong across the whole tree — a `git blame`-wrecking diff for zero runtime change. Don't "fix" it with a `--write` sweep. Keep new imports in sorted position where the surrounding file already is; leave the rest alone.

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
Two string layers, deliberately separate:

- **Server** — `src/i18n/`. `tFor(locale)` returns a translator; `t` is the pre-bound English one. API error bodies, email and feed templates go through it. **Never reintroduce a module-global "active locale"** — one Worker isolate serves concurrent requests, so a mutable module-level locale leaks across requests at every `await`. Locale arrives per-request via `c.get("t")` (see `src/lib/locale.ts`); route handlers open with `const t = c.get("t") ?? tFor(DEFAULT_LOCALE);`, which shadows the module-level English `t` for the whole handler. Reach for the module-level `t` only for a string that gets **persisted** — `lib/moderation.ts` writes `t("ui.deleted")` into `users.name`, and localizing that would freeze the acting admin's language into every reader's view of the row.
- **Widget** — `src/widget/strings.ts`. `tsconfig.widget.json` includes only `src/widget/**/*`, so the widget *cannot* import `src/i18n/`; the dependency is inverted instead — the server imports `EN` from the widget and serializes the merged table into `/api/v1/config`. English ships inlined in the bundle as the per-key fallback; other locales are served, never bundled (30 KB gz budget).

Locale is a property of the **site**, not the reader: `data-lang` → operator `default_locale` → host page `<html lang>` (auto-selectable locales only) → `en` (`resolveLocale` in `src/i18n/negotiate.ts` is the one implementation). `Accept-Language` and `navigator.language` are deliberately not consulted — a German reader on an English blog should see an English widget.

Plurals use `Intl.PluralRules` with the value shape `{ one, other, … }`; the fallback chain is selected category → `other` → `one` → English. Numbers are deliberately **not** localized. Timestamps stay ISO everywhere they are *data* — API responses, feeds, email, and the `datetime` attribute — with exactly one exception: the widget's reader-facing comment timestamp, which renders a relative label ("2 hours ago") via `Intl.RelativeTimeFormat` in the site's resolved locale, with the exact ISO value preserved in `datetime` and the reader's local wall clock in `title` (`src/widget/time.ts`). That surface was the one place the rule produced a wrong answer rather than a neutral one — it showed UTC to every reader on earth with no timezone label.

The admin UI and Telegram bot are English-only by design and out of scope.

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
- `docs-sync.yml` — two independent doc gates, one per audience. Bypass labels are **per gate**, so waving off one can't silently wave off the other.
  - *AGENTS docs sync* — a PR touching watched source paths must update `AGENTS.md` / `AGENTS-OPERATE.md`. Bypass: `agents-docs-ok`.
  - *Human docs sync* — a PR that adds or removes an env var in `wrangler.example.toml`, `.dev.vars.example`, or `secrets.example.env` must update `README.md`, `INSTALL.md`, or a page under `docs/`. Bypass: `human-docs-ok`.

**Why the human gate exists.** For most of this project's life only the AGENTS gate did, and the asymmetry had a measurable cost. Email reply notifications shipped 2026-05-17; `AGENTS.md` was created two days later and described them in its first commit; `README.md` did not mention them until 2026-08-12 — 87 days, and only because a public comparison review marked the feature absent. Across the 32 commits that have touched the env/secret surface, 20 updated an AGENTS file and 8 updated a human-facing one. One set of docs could not go stale without failing CI and the other could go stale in silence, so drift was the designed outcome, not an accident. **A gate on one audience is a gate that teaches you to serve that audience.**

The human gate is scoped to the env/secret surface rather than all of `src/` on purpose: a gate that fires on every source commit gets bypass-labelled by reflex, which rebuilds the honour system in a CI costume. It also fires only when a variable *name* changes, so editing a comment or a placeholder value in a template doesn't demand a docs update — replayed over all 32 historical commits, that narrowing drops 25 failures to 20 and the 5 it spares are pure template hygiene.

Earlier versions gated every job on `github.event.repository.private == false` so private-repo pushes wouldn't burn billing. Those guards were removed once the repo went public. `ci.yml` and `release.yml` had grown a `|| github.event_name == 'workflow_dispatch'` escape hatch; the docs-sync workflow (then `agents-docs-sync.yml`) never did, so it sat unrunnable.
