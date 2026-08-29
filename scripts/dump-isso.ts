#!/usr/bin/env tsx
/**
 * Dump an isso `comments.db` SQLite file to the JSON intermediate the isso
 * adapter (src/lib/import/isso.ts, #108) reads.
 *
 *   npm run dump-isso -- ./comments.db                  # to stdout
 *   npm run dump-isso -- ./comments.db --out dump.json  # to a file
 *
 * isso (isso-comments/isso) ships no export command at all — `comments.db`
 * *is* the data store, read directly by the isso server itself. This makes
 * it a Class B source per docs/importing.md (written alongside the isso
 * adapter, #108's Task 4): a node-only dumper reads the source's own
 * storage and emits a JSON document, and an ordinary adapter then parses
 * that document the same way it would parse any other source's real
 * export. `node:sqlite` is Node's own driver, built in since 22.5 (this
 * repo's `engines.node` is `>=24`), so reading it here is zero new
 * dependencies — but it is also exactly why this file lives in scripts/
 * and not src/lib/import/: no SQLite driver may ever be reachable from the
 * Worker bundle, and an import anywhere under src/ would put one there.
 *
 * The intermediate mirrors isso's own generic import format (`isso import
 * -t generic`, verified against `isso/migrate.py`'s `Generic` class): a
 * top-level array of `{ id, title, comments[] }`, `id` being the thread's
 * `uri` verbatim. It is deliberately not a 1:1 dump of the schema —
 * `likes`, `dislikes`, `voters` and `notification` have no Garrul column
 * and are never emitted here, and the moderation `mode` integer travels
 * through as-is rather than being translated (that mapping to Garrul's
 * `comments.status` vocabulary is the adapter's job, not this dumper's).
 *
 * Opens the database `readOnly: true` — a dumper has no business writing
 * to a live isso installation's store, and isso itself may still be
 * running against the same file while this reads it.
 *
 * Round-trip note: this is read-only and one-way. It does not have to
 * reproduce `comments.db` byte-for-byte from its own output — only the
 * fields the intermediate format carries have to survive a re-run
 * unchanged, which is what `tests/dump-isso.test.ts` pins (determinism
 * against a committed `dump.json`, not a claim about isso itself).
 *
 * `created`/`modified` are epoch **float seconds** in the isso schema.
 * The `created` string emitted here is formatted in UTC at whole-second
 * precision (`formatIssoCreated`), matching what isso's own generic-format
 * writer produces — and what its importer parses back with a local-time
 * `mktime`. Anything reading the *string* field therefore has to treat it
 * as UTC to agree with the adjacent `created_epoch`; when local time
 * matters, `created_epoch` is the field to trust, not the string.
 *
 * TZ caveat: epoch seconds are timezone-independent by construction, but a
 * `comments.db` that was itself populated by importing *into* isso from
 * some other system carries whatever wall-clock-to-epoch conversion that
 * earlier migration used. This dumper cannot tell a first-party isso
 * timestamp from one that arrived pre-converted; it only reads what the
 * column holds.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * One comment in the intermediate. Field order matches the format spec
 * exactly — this is a contract other code (the isso adapter, and its
 * fixture-driven tests) parses, not an incidental object shape.
 */
export type IssoDumpComment = {
	id: number;
	parent: number | null;
	mode: number;
	created: string;
	created_epoch: number;
	modified_epoch: number | null;
	author: string | null;
	email: string | null;
	website: string | null;
	remote_addr: string;
	text: string;
};

/** One thread in the intermediate, `comments` in `comments.id` order. */
export type IssoDumpThread = {
	id: string;
	title: string | null;
	comments: IssoDumpComment[];
};

type Row = Record<string, SQLOutputValue>;

const asNumber = (v: SQLOutputValue, field: string): number => {
	if (typeof v !== "number") {
		throw new Error(`isso dump: expected ${field} to be a number, got ${typeof v}`);
	}
	return v;
};

const asNullableNumber = (v: SQLOutputValue): number | null =>
	typeof v === "number" ? v : null;

const asString = (v: SQLOutputValue, field: string): string => {
	if (typeof v !== "string") {
		throw new Error(`isso dump: expected ${field} to be a string, got ${typeof v}`);
	}
	return v;
};

const asNullableString = (v: SQLOutputValue): string | null =>
	typeof v === "string" ? v : null;

/**
 * `created`/`modified` as a UTC `YYYY-MM-DD HH:MM:SS` string, seconds
 * floored. This is the shape isso's own generic-format writer emits — see
 * the header caveat on this file for what a consumer needs to know about
 * it (it round-trips through isso's *local-time* parser, not UTC).
 */
export const formatIssoCreated = (epoch: number): string => {
	const d = new Date(Math.floor(epoch) * 1000);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	);
};

/**
 * Read an isso `comments.db` and return its threads and comments, threads
 * ordered by `threads.id` and comments within a thread ordered by
 * `comments.id` — matching the intermediate format spec, and independent
 * of whatever order the rows happen to live in on disk.
 *
 * The column list is explicit rather than `SELECT *`: unlike the private
 * import-lab prototype this was measured against, this output is a
 * contract other code parses, so a future isso schema change adding a
 * column must not silently change what this emits.
 */
export const dumpIsso = (dbPath: string): IssoDumpThread[] => {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const threadRows: Row[] = db
			.prepare("SELECT id, uri, title FROM threads ORDER BY id")
			.all();
		const commentRows: Row[] = db
			.prepare(
				"SELECT id, tid, parent, created, modified, mode, remote_addr, text, author, email, website " +
					"FROM comments ORDER BY tid, id",
			)
			.all();

		const commentsByThread = new Map<number, IssoDumpComment[]>();
		for (const row of commentRows) {
			const tid = asNumber(row.tid ?? null, "comments.tid");
			const comment: IssoDumpComment = {
				id: asNumber(row.id ?? null, "comments.id"),
				parent: asNullableNumber(row.parent ?? null),
				mode: asNumber(row.mode ?? null, "comments.mode"),
				created: formatIssoCreated(asNumber(row.created ?? null, "comments.created")),
				created_epoch: asNumber(row.created ?? null, "comments.created"),
				modified_epoch: asNullableNumber(row.modified ?? null),
				author: asNullableString(row.author ?? null),
				email: asNullableString(row.email ?? null),
				website: asNullableString(row.website ?? null),
				remote_addr: asString(row.remote_addr ?? null, "comments.remote_addr"),
				text: asString(row.text ?? null, "comments.text"),
			};
			const existing = commentsByThread.get(tid);
			if (existing) existing.push(comment);
			else commentsByThread.set(tid, [comment]);
		}

		return threadRows.map((row) => {
			const id = asNumber(row.id ?? null, "threads.id");
			return {
				id: asString(row.uri ?? null, "threads.uri"),
				title: asNullableString(row.title ?? null),
				comments: commentsByThread.get(id) ?? [],
			};
		});
	} finally {
		db.close();
	}
};

// ------------------------------------ CLI -----------------------------------

const USAGE = "usage: npm run dump-isso -- <comments.db> [--out file.json]";

const main = (): void => {
	const argv = process.argv.slice(2);
	const positional: string[] = [];
	let outPath: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--out") {
			outPath = argv[i + 1] ?? null;
			i++;
			continue;
		}
		positional.push(arg);
	}

	const dbPath = positional[0];
	if (!dbPath) {
		console.error(USAGE);
		process.exit(1);
	}

	const threads = dumpIsso(dbPath);
	const json = `${JSON.stringify(threads, null, 2)}\n`;
	if (outPath) {
		writeFileSync(outPath, json);
	} else {
		process.stdout.write(json);
	}
};

// Guards the CLI so tests can import `dumpIsso` (and `formatIssoCreated`)
// without running it. Under vitest `process.argv[1]` is vitest's own
// binary, never this file, so the guard never fires there; it fires only
// when this file is executed directly (`tsx scripts/dump-isso.ts`, or the
// `dump-isso` npm script, which runs it the same way).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
