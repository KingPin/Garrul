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
  routes/               # one file per logical surface (api.comments, api.bootstrap, auth, admin,
                        #   embed, rss, health)
  db/                   # migrations + typed query wrappers
  lib/                  # session, markdown, turnstile, ratelimit, oauth, ulid, identicon, ip-hash,
                        #   webhook, webhook-sig, cors, log, settings, thread, email (Resend)
                        #   import/  — source-agnostic importer core + one file per source adapter
                        #              core.ts, html-to-markdown.ts, disqus.ts
  i18n/                 # en.ts string table; t(key) shim
  widget/               # embed.ts (source), embed.bundled.ts (generated), load-error.ts
                        #   boot.ts — the mount fetches + fallback rule; DOM-free so it is the one
                        #   part of the boot path testable without a browser
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

### The mount payload
`GET /api/v1/bootstrap?slug=…` carries all of the widget's mount-time state in one call: config, session user, first page of comments, plus page-engagement and subscription state when those apply. Measured against a real browser mount, a post with the composer rendered costs **two** Worker requests — this one and `/comments/form-token` — so ~50k pageviews/day against the 100,000 requests/day free tier. Mount cost is what sets that ceiling, so **new mount-time state belongs in this payload, not in a sixth endpoint.**

Two rules keep it safe, and both are load-bearing:

- **Compose, never cache the envelope.** The response varies by session *and* by locale, so it carries no `Cache-Control`. The comments section is edge-cached by reusing `/api/v1/comments`' own `treeCacheKey` entry — same key, same TTL, same bytes — so bootstrap adds no second cache key and `bustTreeCache` keeps covering both paths without knowing bootstrap exists. Caching the whole envelope would need locale *and* session in the key; don't.
- **Every section stays byte-identical to its standalone endpoint.** That is what lets the widget parse both boot paths with one set of code, and it is what makes the legacy fallback equivalent rather than merely similar. `tests/bootstrap.test.ts` pins it by diffing against the real endpoints rather than against literals, so it cannot drift silently.

The endpoints it composes all remain — public API, `/comments` still serves load-more, and a widget bundle can outlive the Worker it talks to. `src/widget/boot.ts` falls back — one `null`, then the old five-call sequence — on a 404, a body with no thread array, or a request that never landed. It does **not** fall back on any other non-2xx; those throw and render an error. The distinction is cost, not behavior: the fallback is only worth running when it will succeed, and an edge that answered 429 or 5xx will refuse the five replacement calls too, turning one rejected request into six on an install already over its cap. Do not fold in `/comments/form-token` — its signed timestamp is the anti-spam minimum-elapsed-time heuristic, and a shared one hands every reader the same start time.

### Cookies
Session cookies are `SameSite=None; Secure; HttpOnly; Partitioned`. Cross-site embed depends on this; do not change without understanding Safari ITP and Chrome 3PC behavior. Dev fallback: `SameSite=Lax` only when `ENV=dev`.

### CSRF
Browser CSRF defense is the `Origin` header allowlist (reuses `ALLOWED_ORIGINS`). Every state-changing route (`POST/PATCH/DELETE`) goes through the origin check middleware. Three relaxations exist, all in `src/lib/cors.ts` and all deliberately narrow: `CARVE_OUT_PATHS` (GET only), `SELF_ORIGIN_POST_PATHS` (POST that still *requires* an Origin, matching our own), and `NO_ORIGIN_POST_PATHS` — POST with **no** Origin at all, for RFC 8058 one-click unsubscribe, where the caller is a mail provider's backend rather than a browser. That last class is only safe because the path is gated by an unguessable single-use token, so add to it only when the same is true.

### Markdown
Server-side render via `marked` with a strict allowlist renderer in `src/lib/markdown.ts`. Allowed tags: `p br em strong del code pre a blockquote ul ol li`. Allowed attributes: `href`/`rel`/`target`/`title` on `<a>`, and `class="language-…"` on `<code>` (clamped to `CODE_LANG_RE`) — nothing else, on any tag. No raw HTML. No images. No tables. Task-list checkboxes render as literal `[ ]`/`[x]` text, not `<input>`. Links auto-get `rel="nofollow ugc noopener" target="_blank"`. URLs validated against `^(https?:|mailto:)`. Every comment stores `body_md`, `body_html`, and `renderer_version`. Bump `CURRENT_RENDERER_VERSION` when emitted HTML changes and re-render via `npm run rerender` (or `/admin/operator` → Rerender); `body_html` is served verbatim, so existing comments do not pick up a sanitizer change on their own.

### Sessions
Random 32-byte session ID in an HttpOnly cookie, KV-looked-up. No JWT. KV `SESSIONS` namespace, 30-day TTL, refreshed on use.

### Avatars
Server-side identicons for anonymous (deterministic from `user.id`, inline SVG). Provider avatar URL for OAuth. **No Gravatar.**

### IP handling
Never log or store raw IPs. Hash via HMAC-SHA-256 with `IP_HASH_SECRET` as the key (Workers don't ship BLAKE3 natively). `src/lib/ip-hash.ts` is the single entry point.

### Importers
`src/lib/import/core.ts` owns everything that is true of every source; a source adapter owns only how to read its own export. Disqus is the first adapter (`disqus.ts`); #104 tracks the rest. A new adapter is one file exporting an `ImportAdapter` — `source`, `slugFallbackPrefix`, `parse(input) => SourceExport` — plus a thin `run<Source>Import` wrapper over `runImport`. Nothing else should need to change.

Five rules the core enforces, so no adapter has to:

- **Adapters emit markdown, never HTML.** `SourceComment.body_md` is markdown; the core re-renders it through `renderMarkdown` and stores both. A source that only has HTML converts it in the adapter with the shared `htmlToMarkdown` (`import/html-to-markdown.ts`) — which is a *converter*, not a sanitizer. The allowlist in `src/lib/markdown.ts` stays the only thing standing between an untrusted export and stored HTML.
- **Moderation state is Garrul's vocabulary, not the source's.** `SourceStatus` is exactly the `comments.status` values, so an adapter maps its own flags once, in the adapter. `include_deleted` / `include_spam` gate the last two; `pending` is never gated — a comment awaiting moderation is unfinished work, not junk.
- **Identity is HMAC-derived and must never change for a source that shipped.** `authorSeed` keys on the source's own author id when the adapter supplies one and on name+email when it doesn't. Both feed an HMAC over `IP_HASH_SECRET`, so changing the seed for an existing adapter re-ghosts every commenter it ever imported. Choose per source, at the point the adapter is written.
- **Idempotency comes from `(import_source, import_id)`.** Migration 0009's partial UNIQUE index does the work; every row an adapter produces must carry a stable source id. Re-running the same export inserts zero rows.
- **Imports write on INSERT, never UPDATE.** Fidelity fields (`posts.closed`, `users.is_banned`) land only on rows the run creates. An existing row may carry a decision an operator made on this side, and an import is not an operator.

Input decoding is also the core's (`decodeImportInput`): it sniffs gzip and inflates, capped at `MAX_IMPORT_BYTES` on the **decompressed** side. Any new upload path must decode *before* it sniffs for its own format, or every `.gz` looks like the wrong file type.

### Migrations
Forward-only SQL files in `src/db/migrations/NNNN_name.sql`. The `_migrations` table tracks applied. `npm run migrate` is idempotent. Never edit a migration that has been applied to prod.

### Logging
Use `src/lib/log.ts`. Every request gets an ID; every log line is JSON. Operators tail with `wrangler tail`. No PII (names, emails, comment bodies) in logs.

### Lint
`npm run lint` runs `biome lint`, deliberately **not** `biome check`. Biome classifies import sorting as an *assist* (`assist/source/organizeImports`), not a lint rule, so `check` reports it and `lint` does not. That convention has never been adopted here: `biome check` flags ~145 files, and this version also sorts named specifiers inside the braces, so adopting it means reordering imports nobody wrote wrong across the whole tree — a `git blame`-wrecking diff for zero runtime change. Don't "fix" it with a `--write` sweep. Keep new imports in sorted position where the surrounding file already is; leave the rest alone.

### Type checking
`tsconfig.json` sets `"types": ["node", "@cloudflare/workers-types"]`. **That order is load-bearing — it is not alphabetical drift, do not "tidy" it.** Since 5.20260810.1, `@cloudflare/workers-types` declares the `nodejs_compat` globals (`Buffer`, `process`, `global`) as `any`, colliding with the same globals from `@types/node`. `skipLibCheck` suppresses the duplicate-declaration error, so whichever package is listed *first* silently wins. With workers-types first, `process` becomes `any` across every Node script in `scripts/`, `src/db/migrate.ts` and the tooling tests — `process.argv`/`process.env` lose their types, and the only visible symptom is an unrelated-looking `TS7006 implicit any` on array callbacks. With `node` first, Node's `process` survives and the Worker types (`D1Database`, `KVNamespace`, `Request`, …) still resolve.

Importing the module explicitly does **not** work around this: `@types/node` types `node:process` as `export = process`, so the import resolves to the same clobbered global. `tsconfig.widget.json` is unaffected — it sets `"types": []`.

### Tests
Critical paths only: API contracts, sanitizer (XSS attempts), auth cookie roundtrip, rate-limit, depth cap. No coverage threshold. Tests must not require network or paid services — hand-rolled in-memory D1/KV stubs (see `tests/helpers/`), mocks for OAuth/email/Turnstile. Moving integration tests onto the Workers pool is future work; `@cloudflare/vitest-pool-workers` is deliberately *not* a dependency until then, so install it as part of that work (`vitest.config.ts:8-12`).

### Dependency overrides
`package.json` has no comment syntax, so every entry in `overrides` is documented here. All of them exist for the same reason: a Cloudflare dev-tooling package pins a transitive dependency to an *exact* version that has an open advisory, so Dependabot can never open a PR for it — only an override moves it. None of these packages reach the Worker runtime; they are build- and dev-time only.

Each override is temporary. Re-check them when bumping `wrangler`, and drop the entry once the upstream pin has caught up — a stale override silently holds a dependency *back*, which is the opposite of what it was added for.

There are no overrides today. The `undici: ^7.29.0` entry — added when `miniflare` pinned undici at exactly 7.28.0, to clear five advisories including GHSA-4cwx-7wf7-3272 (high, cross-user disclosure + parse-time crash via degenerate private cache directives) — was dropped once `miniflare` 5.20260804.0-alpha began pinning undici 7.29.0 itself. Resolution is unchanged without it: the lockfile is byte-identical either way.

### Commits
Atomic commits per concern. Conventional-commits style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`). No giant "milestone done" commits.

### Releases
Every tagged release must ship a concise, operator-focused changelog in the **GitHub Release body** — that's what `npm run upgrade` fetches and prints before the drift plan (`scripts/upgrade.ts`). `generate_release_notes: true` in `release.yml` is a starting point, not the final body: review and rewrite it before publishing.

Every release also gets a **title**, not just a tag. The default title `softprops/action-gh-release` writes is the bare tag, which makes the releases page a column of version numbers that says nothing about which one you want. Set it with `gh release edit vX.Y.Z --title "..."` in the same pass that rewrites the body.

- Format is `vX.Y.Z — <what changed>`, em dash, the phrase lowercase unless it opens on a proper noun (`v2.9.0 — moderator email notifications`, `v2.13.0 — Turnstile challenges for signed-in commenters`). Keep the tag in the title: GitHub shows the name alone in notification emails and the Atom feed, so a title without it loses the version.
- Name the operator-visible change, not the internal one — same test as the body. One clause for a single feature (`v2.14.0 — ad hoc moderator replies`), two joined by *and* when a release has a headline pair (`v2.10.0 — reaction vocabulary re-cut and a subscribe bell`).
- Patch releases get titles too, and this is where they earn the most: `v2.7.1 — upgrade plan stops replaying old breaking changes` tells a self-hoster whether to bother. Describe the fix's effect, not the bug's name.
- Unlike the body, the title is **not** part of the upgrade contract — `scripts/upgrade.ts` reads `tag_name`, `body` and `html_url`, never `name`. It is for humans scanning the releases page and for whoever gets the GitHub notification, which is why it can be retitled after the fact without breaking anything.

The body rules:

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
- `release.yml` — fires on `v*` tags. Remember the auto-generated release body is a stub and the auto-generated title is the bare tag; rewrite both (see Releases above).
- `docs-sync.yml` — two independent doc gates, one per audience. Bypass labels are **per gate**, so waving off one can't silently wave off the other.
  - *AGENTS docs sync* — a PR touching watched source paths must update `AGENTS.md` / `AGENTS-OPERATE.md`. Bypass: `agents-docs-ok`.
  - *Human docs sync* — a PR that adds or removes an env var in `wrangler.example.toml`, `.dev.vars.example`, or `secrets.example.env` must update `README.md`, `INSTALL.md`, or a page under `docs/`. Bypass: `human-docs-ok`.

**Why the human gate exists.** For most of this project's life only the AGENTS gate did, and the asymmetry had a measurable cost. Email reply notifications shipped 2026-05-17; `AGENTS.md` was created two days later and described them in its first commit; `README.md` did not mention them until 2026-08-12 — 87 days, and only because a public comparison review marked the feature absent. Across the 32 commits that have touched the env/secret surface, 20 updated an AGENTS file and 8 updated a human-facing one. One set of docs could not go stale without failing CI and the other could go stale in silence, so drift was the designed outcome, not an accident. **A gate on one audience is a gate that teaches you to serve that audience.**

The human gate is scoped to the env/secret surface rather than all of `src/` on purpose: a gate that fires on every source commit gets bypass-labelled by reflex, which rebuilds the honour system in a CI costume. It also fires only when a variable *name* changes, so editing a comment or a placeholder value in a template doesn't demand a docs update — replayed over all 32 historical commits, that narrowing drops 25 failures to 20 and the 5 it spares are pure template hygiene.

Earlier versions gated every job on `github.event.repository.private == false` so private-repo pushes wouldn't burn billing. Those guards were removed once the repo went public. `ci.yml` and `release.yml` had grown a `|| github.event_name == 'workflow_dispatch'` escape hatch; the docs-sync workflow (then `agents-docs-sync.yml`) never did, so it sat unrunnable.
