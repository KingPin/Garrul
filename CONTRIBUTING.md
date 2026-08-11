# Contributing to Garrul

Thanks for the interest. Garrul is small enough that a short doc covers
everything you need to know.

## Before you start

- Read [`CLAUDE.md`](CLAUDE.md). It documents project conventions
  (stack, cookie attributes, CSRF, markdown allowlist, sessions, etc.)
  and is the source of truth.
- Open an issue first if you're planning anything non-trivial. A short
  "I'd like to add X — does that fit?" thread saves both of us time.
- Bug reports: include the worker version (`wrangler --version`),
  Cloudflare region (from `wrangler tail`), and minimal repro.

## Development setup

```bash
git clone https://github.com/KingPin/Garrul.git
cd Garrul
npm install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
./scripts/setup.sh
npm run migrate
npm run dev
```

`npm test` runs the Vitest suite in-process in the plain `node` pool
against hand-rolled in-memory D1/KV stubs — no Miniflare, no network
access, no Cloudflare account required.

## Pull request process

1. **Branch from `main`.** Name it after the change (`fix/oauth-popup-safari`,
   `feat/webhook-signing`).
2. **Atomic commits.** One concern per commit. No "WIP" or
   "milestone done" commits. We use conventional-commits prefixes
   (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`).
3. **Run the checks locally** before opening the PR:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
   `lint` is Biome (`biome.jsonc`), linter only — the formatter is off, so it
   will never reformat your diff. `npm run lint:fix` applies the safe fixes.
   Where a rule is disabled or suppressed, the config or the `biome-ignore`
   comment says why; add the reason if you add a suppression.
4. **PR description** should explain *why*, not just *what*. The diff
   shows what. Link the issue if there is one.
5. **One PR per concern.** A 600-line PR that touches markdown, OAuth,
   and the admin UI is three PRs.

## Test bar

Critical paths only — the test suite covers API contracts, the
markdown sanitizer (XSS attempts), auth cookie roundtrip, rate-limit,
and the depth cap. New features that touch these areas need tests.
New features in less critical areas (theming, admin UI cosmetics)
don't.

No coverage threshold. We don't accept tests that exist only to
satisfy a coverage gate.

## Code style

- TypeScript strict mode is on. `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are both enabled — handle the
  `undefined` cases.
- No raw HTML in markdown output. Extend the allowlist in
  `src/lib/markdown.ts` if you genuinely need new tags, and add a
  sanitizer test for the new tag.
- No PII (names, emails, comment bodies) in logs.
- Bundle budget: `embed.js` ≤ 20KB gzipped. CI enforces.
- One file per logical surface in `src/routes/`. Don't create
  `utils.ts` grab-bags.

## Translations wanted

This is the easiest useful PR in the repo, and the one we most need
from people who aren't us.

Garrul ships German, Spanish and French. **All three are
machine-seeded: LLM output that no native speaker has checked.** What
that fails at is register and consistency — "Post" as a noun where it
should be an imperative, formal address where the rest of the file is
informal — not comprehensibility. Those are exactly the mistakes a
native speaker spots in thirty seconds, so a correction PR is usually
five lines.

Because they're unreviewed, machine-seeded locales are **opt-in only**:
they never get picked up automatically from a host page's
`<html lang>`. The only person who sees one is an operator who typed
`data-lang="de"`, and therefore reads German. A locale is promoted to
`reviewed` — and becomes auto-selectable — when a native speaker puts
their handle on it.

### Adding or fixing a locale

Two files per language, both plain TypeScript:

| File | What's in it |
| --- | --- |
| `src/i18n/widget/<locale>.ts` | Everything a reader sees in the comment widget (~70 strings) |
| `src/i18n/<locale>.ts` | API error bodies, subscription notices, email copy, the Atom feed (~55 strings) |

For a new language, add both, import them in `src/i18n/widget/index.ts`
and `src/i18n/index.ts`, and add an entry to `LOCALES` in
`src/i18n/index.ts`:

```ts
it: { label: "Italian", endonym: "Italiano", rtl: false, status: "machine-seeded" },
```

`endonym` is the language's name *in that language* — it's what an
operator picking a locale in the admin UI reads. Use `status:
"reviewed"` plus `maintainer: "@yourhandle"` instead if you actually
speak it and are willing to be asked about it later.

Rules:

- **Keep `{placeholders}` verbatim.** `{n}`, `{count}`, `{title}`,
  `{max}`, `{name}` are substituted at runtime. A renamed one renders
  as literal braces to every reader of that language, and CI fails the
  PR. You may *drop* a placeholder your phrasing doesn't need.
- **Partial is fine.** Missing keys fall back to English per key, so
  translating half a file and shipping beats translating none. CI
  reports coverage; it doesn't fail on it.
- **Plural keys are objects, not strings.** A handful of keys look like
  `{ one: "…", other: "…" }`. Fill in every form your language selects
  for a realistic comment count — CI checks this against
  `Intl.PluralRules`, so Russian is asked for `few` and French is not
  asked for `many`.
- **Don't translate**: OAuth provider names (`GitHub`, `Google`, …),
  the "Powered by Garrul" attribution, or `example.com` in the email
  placeholder — it's the RFC 2606 reserved domain.
- **Keep values terse.** Widget copy sits in buttons and a composer;
  German already averages ~30% longer than English. Every non-English
  mount also pays for the table on the wire.
- **One language per PR.** It's what makes review tractable for a
  maintainer who doesn't speak it.

### How we review

Honestly: we can't check your meaning, so we don't pretend to. The gate
is `npm test` (`tests/i18n-parity.test.ts` catches structural damage —
unknown keys, invented placeholders, missing plural forms) plus
`npm run typecheck`, which rejects a key that doesn't exist. Past that
we trust you, and the fix path for anything wrong is another five-line
PR. Gatekeeping we're not equipped to perform would just be theater.

**The admin UI is deliberately not translated.** It's ~280 strings seen
only by the technical operator of a self-hosted install — quadrupling
the per-locale tax for the lowest-value audience. Please don't open a
PR for it.

## Out of scope

The v2 backlog in [`CLAUDE.md`](CLAUDE.md) lists features we've
explicitly deferred (multi-site, real-time, image upload, WordPress
importer, self-serve account-delete, @mentions, in-comment search,
generic OIDC). PRs for these will be closed unless there's been prior
discussion.

Note that Disqus import and webhook signing were once on this list and
have since shipped — treat `CLAUDE.md` as the authority if the two
files ever disagree.

## License

By contributing, you agree your contributions are licensed under
[Apache 2.0](LICENSE), the same as the rest of the project.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md) — use
GitHub's private [Report a vulnerability](https://github.com/KingPin/Garrul/security/advisories/new)
flow (or email the maintainer, address in the GitHub profile) and we'll
coordinate disclosure. That file also covers what's in scope, what to
expect, and which versions are supported.
