# Provenance — isso fixture

`comments.sql` is hand-written, not exported from a live isso instance.

- **Schema**: copied from isso's own source — `threads` from
  `isso/db/threads.py`, `comments` from `isso/db/comments.py`.
- **Shapes**: measured against a real isso 0.14 database (column defaults,
  the `voters` Bloom-filter column, epoch-float timestamps, the mode
  vocabulary) but every row value in this file is invented. No thread,
  comment, name, email, or IP address here came from a real site.
- **Identity**: every email is on a reserved domain (`example.com`,
  `.org`, `.net` — RFC 2606), every `remote_addr` is `127.0.0.0`, and no
  name is a real person's. `npm run identity:check` enforces this for
  everything under `tests/`.
- **Nesting depth**: real isso never nests replies more than one level
  deep. `comments.add()` calls `_find()` to resolve a reply's parent to
  its *top-level* ancestor before inserting, so every row's `parent`
  either is `NULL` or points at a root comment — never at another reply.
  This fixture's replies-to-a-reply-free shape (thread 1: `c3` parents to
  root `c1`, `c7`/`c8` parent to root `c6`) mirrors that; it is not an
  arbitrary simplification.
- **Tombstones**: `mode=4` rows are isso's soft-delete. `comments.delete()`
  nulls `author` and `website` and blanks `text` to `''`. `email` is the one
  identity field it leaves in place. isso only *keeps* a mode-4 row at all
  while it still has live children, so every tombstone below is
  load-bearing (dropping it would orphan its replies).
- **`voters`**: a 256-byte Bloom filter in a real database. `X'00'` here —
  the dumper never reads this column, so its exact contents don't matter
  for anything this fixture is used to test.

`dump.json` in this same directory is not hand-written: it is
`scripts/dump-isso.ts`'s own output over a database built from this SQL
file, committed so `tests/dump-isso.test.ts` can pin the dumper's output
byte-for-byte (determinism) as well as structurally.
