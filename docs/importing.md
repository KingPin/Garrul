# Importing comments

Garrul reads five comment systems today: Disqus, Remark42, Comentario (and
its predecessor Commento), isso, and Cusdis. All five share one core
(`src/lib/import/core.ts`) and one contract — idempotent by the source's own
comment ID, markdown in and out, moderation state carried across rather than
flattened to approved, and every write INSERT-only so a re-run never
overwrites a decision an operator made on this side.

Disqus, Remark42 and Comentario/Commento are **single-step**: each product
writes an export file, and you hand that file straight to the CLI or the
`/admin/operator` upload. They're documented in
[`AGENTS-OPERATE.md`](../AGENTS-OPERATE.md), under "Comment import" in
section 10, alongside the rest of day-to-day operation — this page doesn't
repeat that.

isso and Cusdis are different, and get this page because of it: neither
ships an export command at all. isso's `comments.db` and Cusdis' `db.sqlite`
— both SQLite files — *are* the data stores, read directly by the server
itself. Getting comments out of either is a **two-step** process, and this
page is that second step's manual. isso comes first; the
[Cusdis section](#cusdis) follows the same pattern and calls out only what
differs.

## Why isso needs a dumper

Every other adapter parses a file its own product already knows how to
write. isso has nothing to parse — there's no `isso export` to run. So the
isso path splits into two pieces:

1. **`scripts/dump-isso.ts`** (`npm run dump-isso`) reads `comments.db`
   directly, using Node's built-in `node:sqlite` driver (Node ≥ 24, which is
   this repo's minimum already — no new dependency), and writes a JSON
   document.
2. **`src/lib/import/isso.ts`** is an ordinary adapter over that JSON, same
   shape as every other adapter in the core. It never touches SQLite.

That split matters for where the code is allowed to live. No SQLite driver
may ever be reachable from the Worker bundle, so the dumper stays in
`scripts/` — a Node-only, locally-run tool — while the adapter lives under
`src/lib/import/` like the others and ships in the Worker for the admin
upload path.

The JSON the dumper emits deliberately mirrors the shape isso's own
importer reads (`isso import -t generic`, per `isso/migrate.py`'s
`Generic` class — isso has no *writer* for this format, only a reader),
plus a handful of additive fields the adapter needs that format doesn't
carry on its own. That choice is what makes the round-trip statement below
true, and it's also just a sensible format to standardize on — it's the
one isso's own maintainers designed for moving comments between installs.

## The intermediate format

A top-level array of threads. Each thread carries a comments array:

```json
[
  {
    "id": "/hello-world",
    "title": "Hello World",
    "comments": [
      {
        "id": 1,
        "parent": null,
        "mode": 1,
        "created": "2023-11-14 22:13:20",
        "created_epoch": 1700000000.123456,
        "modified_epoch": null,
        "author": "Alice Example",
        "email": "alice@example.com",
        "website": null,
        "remote_addr": "127.0.0.0",
        "text": "raw **markdown**"
      }
    ]
  }
]
```

| Field | Type | Source column | Note |
| --- | --- | --- | --- |
| `id` (thread) | string | `threads.uri` | A path, not a URL — isso has no host of its own. Becomes the Garrul slug via `issoSlug`: leading/trailing slashes stripped, repeated slashes collapsed, `/` falling back to `isso-root`. Nothing is cut at `?` or `#` — the `uri` is isso's thread id verbatim, not a URL, and a query string in one is there because the site's `data-isso-id` put it there, so `/?p=1` and `/?p=2` stay two threads. A `uri` is client-declared, so what it derives to isn't always a slug the read API accepts (`SLUG_RE`: letters, digits, `_`, `-`, `.`, `/`, at most 200 characters) — one carrying a space, a non-ASCII character, a `:`, a `?` or more than 200 characters falls back to `isso-<16 hex digits>`, a stable digest of the derived path, rather than importing onto a page no reader could load. |
| `title` | string \| null | `threads.title` | Passed through as-is. |
| `comments[].id` | number | `comments.id` | isso's own comment ID; becomes the adapter's `import_id` for idempotency. |
| `comments[].parent` | number \| null | `comments.parent` | `null` for a root comment. Real isso never nests past one level — `comments.add()` resolves a reply to its top-level ancestor before inserting — so a parent always points at a root, never at another reply. |
| `comments[].mode` | number \| null | `comments.mode` | isso's moderation state, mapped in the adapter: `1` → `approved`, `2` → `pending`, `4` → `deleted` (isso's soft-delete tombstone). isso's DDL leaves the column nullable and the dumper carries a NULL through as `null` rather than refusing the database. A missing or `null` `mode` defaults to `1`/`approved`; a present value must be an integer (a numeric string such as `"2"` is read as one), and any integer other than 1, 2 or 4 — or a value that is not an integer at all — is refused, naming the record. |
| `comments[].created` | string | `comments.created` | `created_epoch` formatted as UTC `YYYY-MM-DD HH:MM:SS`, seconds floored — the same shape isso's own importer reads back in (`isso import -t generic`). Used only as a fallback: the adapter parses this string (as UTC) when `created_epoch` is missing or not a finite number. See the round-trip note below before treating this as the value of record. |
| `comments[].created_epoch` | number | `comments.created` | The raw epoch float seconds, unrounded. The adapter reads this field when it's present and finite; `created` exists for format parity with what isso's own importer reads, and is where the adapter falls back when this one isn't usable. |
| `comments[].modified_epoch` | number \| null | `comments.modified` | `null` when the comment was never edited. |
| `comments[].author` | string \| null | `comments.author` | `null` on a tombstone (isso's `delete()` nulls it) or on a comment that was never given a name. Adapter defaults a blank or missing name to the literal `"anonymous"`. |
| `comments[].email` | string \| null | `comments.email` | Tombstones keep this in the dump — `delete()` nulls `author` and `website` but leaves `email` alone. The adapter drops it on a tombstone: keeping it would mint one ghost per deleted author and re-attach an identity isso had already stripped. Every tombstone lands on one dedicated ghost instead, seeded on a constant `source_id` rather than on name+email — a `anonymous|` seed is what a live comment posted with no name and no email gets, and the tombstones must never share that commenter's user row. |
| `comments[].website` | string \| null | `comments.website` | Carried by the dumper but **discarded by the adapter** — `SourceAuthor` has no author-URL column. |
| `comments[].remote_addr` | string \| null | `comments.remote_addr` | Carried by the dumper (`null` when the column is NULL) but **discarded by the adapter** — isso already anonymises this to a /24, and Garrul hashes its own IPs with its own secret, so neither value is useful to the other. |
| `comments[].text` | string | `comments.text` | Raw markdown, passed through unchanged — isso stores markdown, so there's nothing to convert. Empty string on a tombstone. |

`likes`, `dislikes`, `voters` and `notification` never reach the
intermediate at all — the dumper doesn't emit them. isso's votes are a Bloom
filter plus counters with no Garrul column to land in, and there's no
notification concept on this side either.

Threads are ordered by `threads.id`; comments within a thread by
`comments.id`. Two-space indented JSON with a trailing newline, so a
regenerated dump diffs cleanly against a previously committed one.

The dumper emits every thread row it finds, including ones with no
comments at all — isso keeps a `threads` row for any page the widget was
ever mounted on. The adapter drops a thread with an empty `comments`
array rather than importing it as an empty page. So the dump's own
thread count can be higher than the dry-run plan's `pages_total` for the
same file; that difference is expected, not a sign anything was lost.

The reverse — a comment whose `tid` matches no `threads` row — is a
hard error. isso declares the foreign key but SQLite enforces nothing
without `PRAGMA foreign_keys`, so a hand-edited or partially restored
database can hold such rows. The dumper refuses to write a dump that would
silently drop them and names the affected comment ids instead; repair the
`threads` table (or the stray `tid`) and re-run.

## The round trip

`isso import -t generic <dump.json>` accepts the dumper's output — it's the
same shape isso's own importer reads back in. But the round trip isn't
lossless in both directions:

- isso's importer **ignores `parent` and `mode` on the way in**. Every
  comment it reads back becomes an approved root, regardless of what this
  dumper recorded. Threading and moderation state only survive the trip
  into Garrul, not a trip back into a second isso instance.
- isso's importer parses `created` with a **local-time** `mktime`, while this
  dumper writes it in **UTC**. A timestamp round-tripped back into isso
  shifts by whatever the importing machine's UTC offset is at that moment.
  `created_epoch` is timezone-independent and is what Garrul's adapter
  actually reads; treat the `created` string as isso-format-compatibility
  only, never as the value to trust for anything that cares about the exact
  instant.

None of this affects an import *into* Garrul — `created_epoch` is what the
adapter reads, and Garrul's own moderation/threading model doesn't go
through isso's reader at all. It matters only if you're using the dumper's
output for something other than Garrul, such as migrating an isso install
into a fresh isso instance.

## Operator procedure

isso's `comments.db` usually lives on whatever host runs the isso server —
not necessarily the machine you'll run the Garrul import from. So this is a
two-machine (or two-step) job:

1. **On the machine with `comments.db`**, dump it to JSON. That machine
   needs a Garrul checkout (for `npm run dump-isso`) and Node ≥ 24 — the
   same minimum this repo already requires, since `node:sqlite` is what
   the dumper reads the file with:

   ```bash
   npm run dump-isso -- /path/to/comments.db --out isso-dump.json
   ```

   This opens the database read-only — isso can keep running against the
   same file while this reads it — and never writes anything back to it.
   Drop `--out` and it writes to stdout instead, which is handy for piping
   straight off the isso host without leaving a file behind on it:
   `ssh issohost 'npm run dump-isso -- /path/to/comments.db' >
   isso-dump.json`. Move `isso-dump.json` to wherever you'll run the
   import from (it's a plain JSON file; gzip it first if you like, both
   the CLI and the admin upload sniff and inflate it either way).

2. **Import the JSON**, either from the CLI or the admin UI:

   - CLI (preferred for a large export):

     ```bash
     IP_HASH_SECRET=... npm run import-isso -- ./isso-dump.json --dry-run
     ```

     Drop `--dry-run` once the plan looks right. Add `--remote` to write to
     the deployed D1 instead of local Miniflare.
   - Admin upload: `/admin/operator` → **Import comments** → source
     **isso**. Same dry-run / include-deleted toggles as the CLI, plus a
     **Site origin** field (see below). The card also shows an "include
     spam" toggle (`x-include-spam`) shared with every other source, but
     it's a no-op here — isso only ever has modes 1/2/4, no spam
     verdict, so the adapter never emits `status: "spam"` for it to
     gate. The CLI wrapper doesn't expose the flag at all, for the same
     reason.

   Flags, either path:

   - `--include-deleted` / the "include deleted" toggle — brings across
     isso's `mode=4` tombstones. isso only *keeps* a tombstone row while it
     still has live replies under it, so every tombstone in a real isso
     export is load-bearing: skip it (the default) and those replies come
     across with no parent; pass it and they keep isso's exact shape,
     tombstone included.
   - `--site=<origin>` (CLI) / **Site origin** (admin, header
     `x-import-site`) — isso stores a path (`threads.uri`), not a URL, so
     `posts.url` needs a host isso doesn't have. Give it one —
     `https://blog.example.com`, say — and each thread's link resolves
     against that origin. Leave it unset and imported posts get no
     permalink until you set one by hand later; that's a normal state for a
     source with no URL concept of its own, not an error. The resolved
     link is kept only when its origin matches `--site`'s exactly — an
     absolute or protocol-relative `uri` (`//evil.example/x`) resolves off
     that origin instead, so the thread's `url` is stored `NULL` rather
     than pointing somewhere `--site` never named. That's silent, not an
     error: the thread's comments still import, just with no permalink.
   - `--slug=<slug>` (CLI only) — put every imported comment on one page
     slug, ignoring the slug each thread's `uri` derives to. Same flag,
     same meaning, as the other importers; useful when the whole export
     belongs to a single page.

Both paths are idempotent: every comment carries `import_source='isso'` and
isso's own comment ID as `import_id`, so re-running the same dump — the CLI
against the same file twice, or a re-upload — inserts zero new rows.

## Cusdis

[Cusdis](https://github.com/djyde/cusdis) is deprecated upstream and ships
no export — no dashboard button, no CLI, no export endpoint; its README now
points users who want their data at a support email. Its `db.sqlite` *is*
the data store, so it is the same two-step shape as isso:

1. **`scripts/dump-cusdis.ts`** (`npm run dump-cusdis`) reads `db.sqlite`
   with `node:sqlite` and writes a JSON document.
2. **`src/lib/import/cusdis.ts`** is an ordinary adapter over that JSON.
   It never touches SQLite, so nothing SQLite-shaped reaches the Worker.

**SQLite only.** Cusdis' `DB_TYPE` also allows `pgsql` and `mysql` with a
structurally identical schema, but SQLite is the default and what its
documented docker quickstart uses. If your instance runs on Postgres or
MySQL, convert to SQLite first (`pg_dump` → `sqlite3`, or any of the usual
converters); the intermediate is database-agnostic, so a second dumper
could emit the same shape later without touching the adapter.

### Why not the API

Cusdis has three read paths and none is usable for this, recorded here so
nobody retries them: `GET /api/open/comments` returns only `approved: true`
rows and never `by_email` (silently lossy); `GET
/api/open/project/{id}/comments/latest` is authenticated but *destructive*
— it marks what it returns as read; and the dashboard route is gated by a
NextAuth session cookie with no public contract.

### The intermediate format

Cusdis has no import format of its own to mirror (its only importer reads
Disqus XML), so this is Garrul's own shape, nested the way the tables
relate — a project owns pages, a page owns comments. The dumper writes
`source` first so the format tag is the first thing a reader sees; the admin
upload sniffs on the `"source": "cusdis"` pair wherever it sits in the
file.s head, so a dump re-serialised with sorted keys still uploads.

```json
{
  "source": "cusdis",
  "version": 1,
  "projects": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "Example Blog",
      "pages": [
        {
          "id": "p0000001-0000-4000-8000-000000000001",
          "slug": "/hello-world",
          "url": "https://blog.example.com/hello-world",
          "title": "Hello World",
          "comments": [
            {
              "id": "c0000001-0000-4000-8000-000000000001",
              "parent_id": null,
              "created_at": 1700000000000,
              "updated_at": 1700000000000,
              "deleted_at": null,
              "approved": true,
              "by_nickname": "Alice Example",
              "by_email": "alice@example.com",
              "content": "raw **markdown**"
            }
          ]
        }
      ]
    }
  ]
}
```

| Field | Type | Source column | Note |
| --- | --- | --- | --- |
| `source` | `"cusdis"` | — | Format tag. The admin upload sniffs on it; the adapter refuses any other value. |
| `version` | `1` | — | Intermediate version. The adapter refuses any other value. |
| `projects[].id` | string | `projects.id` | Cusdis' project UUID — one project is one site. This is what `--project` / `x-import-domain` selects on. |
| `projects[].title` | string | `projects.title` | Display only; Cusdis puts no uniqueness constraint on it, which is why selection is by id. |
| `pages[].id` | string | `pages.id` | Page UUID. The adapter keys threads on it, not on `slug`, so two pages in one project that happen to share a slug still resolve their parents independently; the core then merges them onto one Garrul page by slug. |
| `pages[].slug` | string | `pages.slug` | Whatever the host page passed as `data-page-id` — a path by convention (`/hello-world`), but client-declared, so anything. Becomes the Garrul slug the same way an isso `uri` does: leading/trailing slashes stripped, runs collapsed, `/` falling back to `cusdis-root`, and a result the read API would reject (`SLUG_RE`) replaced by `cusdis-<16 hex digits>`, a stable digest of the derived path. Nothing is cut at `?` or `#`. |
| `pages[].url` | string \| null | `pages.url` | Whatever the host page passed as `data-page-url`, often empty. Used as the post's permalink when it parses as an http(s) URL; otherwise the adapter falls back to `--site` resolution (below), and without that the post has no URL. |
| `pages[].title` | string \| null | `pages.title` | Client-declared `data-page-title`; nullable. |
| `comments[].id` | string | `comments.id` | Cusdis' own comment UUID; becomes `import_id` for idempotency. |
| `comments[].parent_id` | string \| null | `comments.parentId` | `null` for a root. Cusdis nests without limit; the core flattens anything past `MAX_REPLY_DEPTH` onto the deepest allowed ancestor. A parent that is not on the same page — possible only in a hand-edited database — is dropped and the comment re-rooted. |
| `comments[].created_at` | number | `comments.created_at` | Epoch **milliseconds**, Prisma's SQLite `DateTime` encoding, which is also Garrul's unit, so it passes through untouched. |
| `comments[].updated_at` | number | `comments.updated_at` | Carried, but **not read as an edit**. Cusdis has no comment-edit feature; this is Prisma's `@updatedAt`, bumped by approve and delete, so deriving `edited_at` from it would mark every moderated comment "edited". `edited_at` is always `null` on a Cusdis import. |
| `comments[].deleted_at` | number \| null | `comments.deletedAt` | Cusdis' soft delete. Set → `status: "deleted"`, gated by `--include-deleted`. The row keeps its nickname, email and content, so a deleted comment imports under its real author, not a tombstone ghost. |
| `comments[].approved` | boolean | `comments.approved` | Cusdis' one moderation bit, stored as `0`/`1` and emitted as a real boolean. `true` → `approved`, `false` → `pending` (never gated — it lands in the moderation queue). Cusdis has no spam state, so `--include-spam` is a no-op. |
| `comments[].by_nickname` | string | `comments.by_nickname` | Required in Cusdis. A blank one becomes the literal `"anonymous"`. |
| `comments[].by_email` | string \| null | `comments.by_email` | Optional in Cusdis and often empty. Identity is the core's name+email HMAC seed, same as isso and Disqus — Cusdis has no commenter accounts. |
| `comments[].content` | string | `comments.content` | Raw markdown, passed through unchanged. |

Not emitted, deliberately: `projects.token` is the widget's API token — a
credential — and `moderatorId`, `ownerId`, `webhook`,
`fetch_latest_comments_at` and the notification flags name the operator or
configure the instance. The database also holds next-auth's `users`,
`accounts`, `sessions` and `verification_requests`; those describe the
operator's login, not commenters, and hold live OAuth and session tokens.
The dumper reads `projects`, `pages` and `comments` and nothing else.

Projects and pages are ordered by id; comments within a page by
`created_at`, then id. Two-space indented JSON with a trailing newline, so
a regenerated dump diffs cleanly against a previous one.

The dumper emits every page row it finds, including ones with no comments.
The adapter drops a page with an empty `comments` array, so the dump's
page count can exceed the dry-run plan's `pages_total`; that is expected.
A comment whose `pageId` matches no page, or a page whose `projectId`
matches no project, is a hard error: the dumper names the affected ids
rather than silently dropping them.

### Operator procedure

Same two-machine shape as isso:

1. **On the machine with `db.sqlite`** (a Garrul checkout and Node ≥ 24):

   ```bash
   npm run dump-cusdis -- /path/to/db.sqlite --out cusdis-dump.json
   ```

   Read-only — Cusdis can keep running against the file. Drop `--out` to
   write to stdout, e.g. `ssh cusdishost 'npm run dump-cusdis --
   /path/to/db.sqlite' > cusdis-dump.json`. Gzip it for the move if you
   like; both import paths sniff and inflate it.

2. **Import the JSON**, from the CLI or the admin UI:

   - CLI:

     ```bash
     IP_HASH_SECRET=... npm run import-cusdis -- ./cusdis-dump.json --dry-run
     ```

     Drop `--dry-run` once the plan looks right; add `--remote` for the
     deployed D1.
   - Admin upload: `/admin/operator` → **Import comments** → source
     **Cusdis**. Same toggles as the CLI, plus the **Project** and
     **Site origin** fields below.

   Flags, either path:

   - `--project=<id>` (CLI) / **Project** (admin, header `x-import-domain`)
     — one Cusdis database holds every project (site) you created, and
     pages on two projects can share a slug, so a dump with more than one
     project is **refused** rather than flattened. The refusal lists each
     project's id and title; pass the id — Cusdis does not keep titles
     unique — and run once per project you want. A single-project dump
     needs no flag.
   - `--include-deleted` / the "include deleted" toggle — brings across
     soft-deleted comments (`deleted_at` set). Cusdis does not cascade a
     delete to replies, so without this a deleted parent's replies come
     across as roots; with it, the thread keeps its exact shape and the
     deleted comment keeps its real author and text.
   - `--site=<origin>` (CLI) / **Site origin** (admin, header
     `x-import-site`) — a page's `url` is client-declared and often empty.
     For pages that have one, it is used as-is; for the rest, this origin
     resolves the page's slug into a permalink, same-origin only, exactly
     as for isso. Without it, such pages have no URL until you set one by
     hand. An origin that is not `http(s)://…` is an error, not a silent
     no-URL import.
   - `--slug=<slug>` (CLI only) — put every imported comment on one page.

Idempotent like the rest: `import_source='cusdis'` plus Cusdis' comment UUID
as `import_id`, so a re-run — same file, or plain then gzipped — inserts
zero rows.
