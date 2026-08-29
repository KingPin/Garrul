# Importing comments

Garrul reads four comment systems today: Disqus, Remark42, Comentario (and
its predecessor Commento), and isso. All four share one core
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

isso is different, and gets its own page because of it: isso ships no export
command at all. `comments.db` — a SQLite file — *is* the data store, read
directly by the isso server itself. Getting comments out of it is a
**two-step** process, and this page is that second step's manual.

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
| `id` (thread) | string | `threads.uri` | A path, not a URL — isso has no host of its own. Becomes the Garrul slug via `issoSlug`: query string and fragment dropped, leading/trailing slashes stripped, repeated slashes collapsed, `/` falling back to `isso-root`. A `uri` is client-declared, so what it derives to isn't always a slug the read API accepts (`SLUG_RE`: letters, digits, `_`, `-`, `.`, `/`, at most 200 characters) — one carrying a space, a non-ASCII character, a `:` or more than 200 characters falls back to `isso-<16 hex digits>`, a stable digest of the derived path, rather than importing onto a page no reader could load. |
| `title` | string \| null | `threads.title` | Passed through as-is. |
| `comments[].id` | number | `comments.id` | isso's own comment ID; becomes the adapter's `import_id` for idempotency. |
| `comments[].parent` | number \| null | `comments.parent` | `null` for a root comment. Real isso never nests past one level — `comments.add()` resolves a reply to its top-level ancestor before inserting — so a parent always points at a root, never at another reply. |
| `comments[].mode` | number | `comments.mode` | isso's moderation state, mapped in the adapter: `1` → `approved`, `2` → `pending`, `4` → `deleted` (isso's soft-delete tombstone). A *missing* `mode` field defaults to `1`/`approved`; any other value that **is** present (not 1, 2 or 4) is refused. |
| `comments[].created` | string | `comments.created` | `created_epoch` formatted as UTC `YYYY-MM-DD HH:MM:SS`, seconds floored — the same shape isso's own importer reads back in (`isso import -t generic`). Used only as a fallback: the adapter parses this string (as UTC) when `created_epoch` is missing or not a finite number. See the round-trip note below before treating this as the value of record. |
| `comments[].created_epoch` | number | `comments.created` | The raw epoch float seconds, unrounded. The adapter reads this field when it's present and finite; `created` exists for format parity with what isso's own importer reads, and is where the adapter falls back when this one isn't usable. |
| `comments[].modified_epoch` | number \| null | `comments.modified` | `null` when the comment was never edited. |
| `comments[].author` | string \| null | `comments.author` | `null` on a tombstone (isso's `delete()` nulls it) or on a comment that was never given a name. Adapter defaults a blank or missing name to the literal `"anonymous"`. |
| `comments[].email` | string \| null | `comments.email` | Tombstones keep this — `delete()` nulls `author` and `website` but leaves `email` alone. |
| `comments[].website` | string \| null | `comments.website` | Carried by the dumper but **discarded by the adapter** — `SourceAuthor` has no author-URL column. |
| `comments[].remote_addr` | string | `comments.remote_addr` | Carried by the dumper but **discarded by the adapter** — isso already anonymises this to a /24, and Garrul hashes its own IPs with its own secret, so neither value is useful to the other. |
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

Both paths are idempotent: every comment carries `import_source='isso'` and
isso's own comment ID as `import_id`, so re-running the same dump — the CLI
against the same file twice, or a re-upload — inserts zero new rows.
