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

`npm test` runs the Vitest suite in-process against Miniflare. No
network access required.

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

## Out of scope

The v2 backlog in [`CLAUDE.md`](CLAUDE.md) lists features we've
explicitly deferred (multi-site, real-time, image upload, importers,
@mentions, in-comment search, generic OIDC, webhook signing). PRs for
these will be closed unless there's been prior discussion.

## License

By contributing, you agree your contributions are licensed under
[Apache 2.0](LICENSE), the same as the rest of the project.

## Reporting security issues

Please don't open a public issue. Email the maintainer (address in the
GitHub profile) with details and we'll coordinate disclosure.
