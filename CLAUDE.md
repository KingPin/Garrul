# Garrul — Project Conventions

Self-hosted comment system on Cloudflare Workers + D1 + KV + Turnstile. Conventions for human and AI contributors. Read before writing code or opening a PR. Rules here carry their *why* on purpose: when a rule looks wrong, check the reason before changing it.

## Stack

- **Runtime**: Cloudflare Workers (not Pages Functions). **Framework**: Hono (TypeScript). **Database**: D1 (SQLite).
- **KV**: sessions, OAuth state, resolved settings, version checks, CF usage snapshots, optional Workers-AI spam verdict cache. **Never put a per-request write on KV** — the free tier allows 1000 writes/day *account-wide*, so an unauthenticated endpoint that writes KV per request is an account-wide outage primitive. Counters and response caches belong on the Cache API.
- **Edge cache**: the comment-tree response cache and the rate limiter use the Cache API (`caches.default`) — `src/lib/response-cache.ts`, `src/lib/ratelimit.ts`. The `TREE_CACHE` / `RATE_LIMITS` KV namespaces are still bound for historical reasons only.
- **Anti-spam**: Turnstile, plus `src/lib/spam/` (heuristics, blocklist, Akismet, Workers AI).
- **Email**: Resend is the sole adapter (`src/lib/email.ts`). `EMAIL_PROVIDER` leaves room for more; none exist yet.
- **Widget**: vanilla TypeScript, no framework, esbuild. Budget: `embed.js` ≤ 30 KB gzipped. CSS lives in `src/widget/styles.css` and is minified into `styles.gen.ts` at build time, so comments there are free.
- **Admin UI**: server-rendered HTML (Hono JSX) + Alpine.js. English-only by design, as is the Telegram bot.
- **Tests**: Vitest, plain `node` pool. D1/KV are hand-rolled in-memory stubs in `tests/helpers/`, *not* Miniflare. `@cloudflare/vitest-pool-workers` is deliberately not a dependency until integration tests move to the Workers pool (see the header of `vitest.config.ts`).

## Layout

Directory purposes only — `ls` for the current file list.

```
src/
  index.ts        Hono app entry, route mounting
  routes/         one file per HTTP surface: api.*.ts (v1 API), auth, admin, embed,
                  embed-iframe (the iframe variant is a route, not a widget file),
                  feed, permalink, telegram, well-known, agents, health
  db/             migrations/ + typed query wrappers
  lib/            session, markdown, turnstile, ratelimit, oauth, cors, log, settings,
                  ip-hash, webhook*, email, tree-cache, moderation, …
    import/       core.ts (source-agnostic importer) + one adapter per source
    spam/         heuristics, blocklist, akismet, workers-ai
  i18n/           per-locale string tables (en + 8), widget/ mirrors them for the
                  widget surface, negotiate.ts (resolveLocale), tFor()
  widget/         embed.ts (source) → embed.bundled.ts (generated); boot.ts is the
                  DOM-free mount/fallback logic and the only browser-free testable part
  admin-ui/       layout, styles, pages/, components/ (server-rendered + Alpine attrs)
tests/            Vitest suites; tests/helpers/ holds the D1/KV/cache stubs
examples/         host-site snippets (astro, hugo, jekyll, wordpress, plain-html, iframe, lazy-load)
scripts/          setup.sh, build-*.ts, import-*.ts + dump-*.ts, upgrade.ts + upgrade/,
                  rerender.ts, seed-demo.ts, visual-regression.ts, check-*.ts
docs/             README.md is the index; THEMING, ANTISPAM, importing, webhooks, telegram,
                  i18n, notifications, ip-hashing, embedding, troubleshooting, templates
.github/workflows/  ci.yml, release.yml, docs-sync.yml, codeql.yml
```

`AGENTS.md` / `AGENTS-OPERATE.md` are the AI-assistant integration and operations guides. `AGENTS.md` is also served by the Worker at `/AGENTS.md` with light host templating.

## Conventions

### API versioning
All HTTP API routes live under `/api/v1/...`; breaking changes ship as `/api/v2`. Health is `/api/v1/health`.

### The mount payload
`GET /api/v1/bootstrap?slug=…` carries all mount-time widget state in one call: config, session user, first comment page, page-engagement and subscription state. A real browser mount costs **two** Worker requests (this plus `/comments/form-token`), which is what sets the ~50k pageviews/day ceiling on the 100k-requests/day free tier. **New mount-time state goes in this payload, not in a new endpoint.**

Two load-bearing rules:

- **Compose, never cache the envelope.** It varies by session *and* locale, so it carries no `Cache-Control`. The comments section reuses `/api/v1/comments`' own `treeCacheKey` entry — same key, TTL and bytes — so `bustTreeCache` covers both paths without knowing bootstrap exists.
- **Every section stays byte-identical to its standalone endpoint.** That lets the widget parse both boot paths with one code path and makes the legacy fallback equivalent, not similar. `tests/bootstrap.test.ts` pins this by diffing against the real endpoints, not literals.

The composed endpoints all remain public. `src/widget/boot.ts` falls back to the old five-call sequence only on a 404, a body with no thread array, or a request that never landed. Any other non-2xx throws and renders an error: an edge that answered 429/5xx will refuse the five replacement calls too, turning one rejected request into six on an install already over its cap. Never fold in `/comments/form-token` — its signed timestamp is the minimum-elapsed-time anti-spam heuristic, and sharing it hands every reader the same start time.

### Cookies
Session cookies are `SameSite=None; Secure; HttpOnly; Partitioned`. Cross-site embed depends on this; do not change without understanding Safari ITP and Chrome 3PC. Dev fallback `SameSite=Lax` only when `ENV=dev`.

### CSRF
Browser CSRF defense is the `Origin` allowlist (`ALLOWED_ORIGINS`); every `POST/PATCH/DELETE` goes through the origin-check middleware. Three deliberately narrow relaxations live in `src/lib/cors.ts`: `CARVE_OUT_PATHS` (GET only), `SELF_ORIGIN_POST_PATHS` (POST that still requires our own Origin), and `NO_ORIGIN_POST_PATHS` (POST with **no** Origin, for RFC 8058 one-click unsubscribe called from a mail provider's backend). The last is safe only because the path is gated by an unguessable single-use token — add to it only when the same is true.

### Markdown
Server-side render via `marked` with a strict allowlist renderer in `src/lib/markdown.ts`. Tags: `p br em strong del code pre a blockquote ul ol li`. Attributes: `href`/`rel`/`target`/`title` on `<a>`, `class="language-…"` on `<code>` (clamped to `CODE_LANG_RE`) — nothing else. No raw HTML, images or tables; task-list checkboxes render as literal `[ ]`/`[x]`. Links get `rel="nofollow ugc noopener" target="_blank"`; URLs must match `^(https?:|mailto:)`. Every comment stores `body_md`, `body_html`, `renderer_version`. `body_html` is served verbatim, so when emitted HTML changes, bump `CURRENT_RENDERER_VERSION` and re-render (`npm run rerender` or `/admin/operator` → Rerender).

### Sessions
Random 32-byte session ID in an HttpOnly cookie, looked up in the `SESSIONS` KV namespace. 30-day TTL, refreshed on use. No JWT.

### Avatars
Server-side identicons for anonymous users (deterministic from `user.id`, inline SVG); provider avatar URL for OAuth. **No Gravatar.**

### IP handling
Never log or store raw IPs. HMAC-SHA-256 keyed with `IP_HASH_SECRET` (Workers lack native BLAKE3); `src/lib/ip-hash.ts` is the single entry point.

### Importers
`src/lib/import/core.ts` owns everything true of every source; an adapter owns only how to read its own export. A new adapter is one file exporting an `ImportAdapter` (`source`, `slugFallbackPrefix`, `parse(input) => SourceExport`) plus a thin `run<Source>Import` wrapper over `runImport`. Nothing else should change. Adapters: `disqus`, `remark42`, `comentario` (reads Comentario v3 and legacy Commento v1 off the document's `version`, one `import_source` tag because they are one lineage), `isso`, `cusdis`. #110 tracks utterances/giscus.

Two adapter classes. **Class A** parses a source's own export file. **Class B** (isso, Cusdis) has no export: a node-only dumper in `scripts/dump-*.ts` reads the SQLite file via `node:sqlite` (Node ≥ 22.5; `engines.node` is `>=24`) and emits a JSON intermediate the adapter parses like any export. Dumpers stay under `scripts/`, never `src/lib/import/` — no SQLite driver may ever be reachable from the Worker bundle. A multi-site source's per-site filter lives on the **adapter**, not the dumper, so one dump serves every project. Formats and operator procedure: `docs/importing.md`.

Five rules the core enforces so adapters don't have to:

- **Adapters emit markdown, never HTML.** The core re-renders `body_md` through `renderMarkdown`. HTML-only sources convert with the shared `htmlToMarkdown`, which is a *converter*, not a sanitizer — the allowlist in `markdown.ts` stays the only thing between an untrusted export and stored HTML.
- **Moderation state is Garrul's vocabulary.** `SourceStatus` equals the `comments.status` values; the adapter maps its own flags once. `include_deleted` / `include_spam` gate those two; `pending` is never gated.
- **Identity is HMAC-derived and must never change for a shipped source.** `authorSeed` keys on the source's author id when supplied, else name+email, over `IP_HASH_SECRET`. Changing the seed re-ghosts every commenter that adapter ever imported.
- **Idempotency comes from `(import_source, import_id)`** via migration 0009's partial UNIQUE index. Every row needs a stable source id; re-running an export inserts zero rows.
- **Imports write on INSERT, never UPDATE.** Fidelity fields (`posts.closed`, `users.is_banned`) land only on rows the run creates — an existing row may carry an operator's decision, and an import is not an operator.

Input decoding is the core's (`decodeImportInput`): it sniffs gzip and inflates, capped at `MAX_IMPORT_BYTES` on the **decompressed** side. Any new upload path must decode *before* sniffing its own format, or every `.gz` looks like the wrong file type.

### Migrations
Forward-only SQL in `src/db/migrations/NNNN_name.sql`; `_migrations` tracks applied. `npm run migrate` is idempotent. Never edit a migration applied to prod.

### Logging
Use `src/lib/log.ts`: request ID on every request, JSON on every line, tailed with `wrangler tail`. No PII (names, emails, comment bodies).

### Lint
`npm run lint` runs `biome lint`, deliberately **not** `biome check`. Biome treats import sorting as an *assist*, and this repo never adopted it — `check` flags ~145 files and would produce a blame-wrecking diff for zero runtime change. Don't "fix" it with a `--write` sweep. Keep new imports in sorted position where the surrounding file already is.

### Type checking
`tsconfig.json` sets `"types": ["node", "@cloudflare/workers-types"]`. **That order is load-bearing.** Since 5.20260810.1, workers-types declares the `nodejs_compat` globals (`Buffer`, `process`, `global`) as `any`; `skipLibCheck` hides the collision, so whichever package is listed first wins. With workers-types first, `process` becomes `any` across `scripts/`, `src/db/migrate.ts` and the tooling tests, and the only symptom is an unrelated-looking `TS7006` on array callbacks. Importing `node:process` does not help (`export = process` resolves to the same clobbered global). `tsconfig.widget.json` sets `"types": []` and is unaffected.

### Tests
Critical paths only: API contracts, sanitizer (XSS), auth cookie roundtrip, rate limit, depth cap. No coverage threshold. No network or paid services — stubs for D1/KV, mocks for OAuth/email/Turnstile.

### Dependency overrides
`package.json` can't carry comments, so every `overrides` entry is documented here. They exist only when a Cloudflare dev-tooling package pins a transitive dependency to an exact version with an open advisory that Dependabot can't move. None reach the Worker runtime. Re-check on every `wrangler` bump and drop an entry once upstream catches up — a stale override holds a dependency *back*. **There are no overrides today** (the last, `undici`, was dropped when `miniflare` 5.20260804.0-alpha pinned 7.29.0 itself).

### Commits
Atomic commits per concern, conventional-commits style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`). No "milestone done" commits.

### Releases
`npm run upgrade` (`scripts/upgrade.ts`) fetches and prints the **GitHub Release body** before the drift plan, so every tag needs a concise, operator-focused body. `generate_release_notes: true` in `release.yml` is a stub — always rewrite it.

- **Body**: group by `feat:`/`fix:`/`chore:` or `Highlights:`/`Notes:`, 3–6 lines. Say what changes for someone upgrading (env vars, endpoints, behavior), not internal refactors. Patch releases get notes too; never publish a bare `"v1.5.1"`. Mirror the summary in the annotated tag message.
- **Title**: every release gets one via `gh release edit vX.Y.Z --title "..."`, format `vX.Y.Z — <operator-visible change>` (lowercase unless it opens on a proper noun; two clauses joined by *and* for a headline pair). Keep the tag in the title — GitHub notifications and the Atom feed show the name alone. Describe a patch's effect, not the bug's name. The title is not part of the upgrade contract (`upgrade.ts` reads `tag_name`, `body`, `html_url`), so it can be retitled after the fact.

### Secrets
`wrangler.toml` is gitignored (`wrangler.example.toml` is the template). Production secrets via `wrangler secret put`; local via `.dev.vars` (`.dev.vars.example` is the template).

### i18n
Two string layers, deliberately separate:

- **Server** — `src/i18n/`. `tFor(locale)` returns a translator; `t` is the pre-bound English one. **Never reintroduce a module-global "active locale"** — one isolate serves concurrent requests, so it leaks at every `await`. Locale arrives per-request (`src/lib/locale.ts`); handlers open with `const t = c.get("t") ?? tFor(DEFAULT_LOCALE);`. Use module-level `t` only for a string that gets **persisted** (e.g. `lib/moderation.ts` writing `t("ui.deleted")` into `users.name`).
- **Widget** — `src/widget/strings.ts`. `tsconfig.widget.json` can't import `src/i18n/`; the server imports `EN` from the widget and serves the merged table via `/api/v1/config`. English is inlined as the per-key fallback; other locales are served, never bundled (30 KB budget).

Locale is a property of the **site**, not the reader: `data-lang` → operator `default_locale` → host `<html lang>` (auto-selectable locales only) → `en`, all in `resolveLocale`. `Accept-Language` / `navigator.language` are deliberately ignored. Plurals via `Intl.PluralRules` with `{ one, other, … }`; fallback chain is category → `other` → `one` → English. Numbers are not localized. Timestamps stay ISO wherever they are *data*; the one exception is the widget's reader-facing relative label (`src/widget/time.ts`), with ISO kept in `datetime` and local wall clock in `title`.

### Upgrades
`scripts/upgrade.ts` is the operator entry point. The version contract is `release-manifest.json` at repo root — generated by `scripts/upgrade/build-manifest.ts`, validated in CI by `npm run manifest:check`. Hand-edit only the free-text fields (descriptions, `breakingChanges`).

## Out of scope (v2 backlog)

Multi-tenant per Worker, real-time updates, image uploads, WordPress importer, self-serve account delete, @mentions, in-comment search, generic OIDC, per-post custom auto-close schedules (global rule + per-post manual override only), community hide-and-hold (reader reporting + auto-collapse already cover the moderation value without suppressing legit content).

## Domain layout (maintainer's instance)

- `garrul.com` — static marketing site, separate from this Worker.
- `comments.garrul.com` — this Worker, the canonical demo. Self-hosters use `comments.<yourdomain>`.

## CI

Workflows in `.github/workflows/` run unconditionally; the repo is public.

- `ci.yml` — `lint`, `typecheck`, `test`, `manifest:check`, `build`, `size` on push/PR to `main` and `workflow_dispatch`. Run the same set locally before a PR.
- `release.yml` — fires on `v*` tags. Auto-generated body and title are stubs; rewrite both (see Releases).
- `codeql.yml` — security-extended queries on push/PR to `main` plus a weekly cron.
- `docs-sync.yml` — two independent gates with **per-gate** bypass labels, so waving off one can't silently wave off the other.
  - *AGENTS docs sync*: a PR touching watched source paths must update `AGENTS.md` / `AGENTS-OPERATE.md`. Bypass: `agents-docs-ok`.
  - *Human docs sync*: a PR that adds or removes an env var *name* in `wrangler.example.toml`, `.dev.vars.example` or `secrets.example.env` must update `README.md`, `INSTALL.md` or `docs/`. Bypass: `human-docs-ok`.

The human gate exists because for most of the project's life only the AGENTS gate did, and README lagged AGENTS.md by 87 days on one feature — a gate on one audience teaches you to serve that audience. It is scoped to env-var *names* rather than all of `src/` because a gate that fires on every commit gets bypass-labelled by reflex, and comment or placeholder edits shouldn't demand a docs update.
