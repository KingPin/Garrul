# Provenance — Cusdis fixture

`cusdis.sql` is hand-written, not exported from a live Cusdis instance.

- **Schema**: the DDL Prisma generates from Cusdis' own
  `prisma/sqlite/schema.prisma` (djyde/cusdis, v1.3.x) for the three tables
  the dumper reads — `projects`, `pages`, `comments`. Column names mix
  `snake_case` (`created_at`, `deleted_at` on `projects`) and `camelCase`
  (`deletedAt`, `parentId`, `pageId` on `comments`) because the schema maps
  some fields with `@map` and not others; the fixture reproduces that
  exactly, since it is what a real database has. The next-auth tables
  (`users`, `accounts`, `sessions`, `verification_requests`) are omitted —
  the dumper never opens them.
- **Shapes**: measured against a real Cusdis 1.3 database (Prisma's SQLite
  encodings — `DateTime` as integer epoch **milliseconds**, `Boolean` as
  `0`/`1`; UUID string ids; nullable `by_email`, `url`, `title`; the
  `deletedAt` soft-delete with no cascade to replies) but every row value in
  this file is invented. No project, page, comment, name or email here came
  from a real site.
- **Identity**: every email is on a reserved domain (`example.com`, `.org`,
  `.net` — RFC 2606), every id is a patterned placeholder UUID, and no name
  is a real person's. `npm run identity:check` enforces this for everything
  under `tests/`.
- **`token`**: the project's widget API token is a credential. It is set to
  an obvious placeholder on both projects so `tests/dump-cusdis.test.ts` can
  assert the dumper never emits it — a redaction that can't be tested is a
  redaction nobody knows is still there.
- **Two projects**: one Cusdis instance hosts many sites, and both fixture
  projects carry an `/about` page. This is the shape the adapter's
  `project` filter exists for.
- **Soft-delete**: `deletedAt` is a nullable timestamp, not a boolean, and
  Cusdis' `deleteComment` sets only that column — nickname, email and
  content stay, and replies are not touched. `c6` is a deleted parent with
  two live replies; `c10` is a deleted leaf.
- **Moderation**: `approved` is `false` by default on every new comment, and
  unapproved rows are invisible to the widget but present in the database.
  `c5` (root) and `c11` (reply) are unapproved.
- **Nesting**: `parentId` is an unbounded self-relation. `/deep-thread` is a
  ten-deep chain, two past `MAX_REPLY_DEPTH` (8).

`dump.json` in this same directory is not hand-written: it is
`scripts/dump-cusdis.ts`'s own output over a database built from this SQL
file, committed so `tests/dump-cusdis.test.ts` can pin the dumper's output
byte-for-byte (determinism) as well as structurally.
