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
 * precision (`formatIssoCreated`), matching the shape isso's own importer
 * reads (`isso import -t generic`) — which then parses it back with a
 * local-time `mktime`. Anything reading the *string* field therefore has
 * to treat it as UTC to agree with the adjacent `created_epoch`; when
 * local time matters, `created_epoch` is the field to trust, not the
 * string.
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

/**
 * `null` passes through untouched; anything else must be a number. Isso's own
 * DDL allows several columns this reads to be NULL, and a NULL is the one
 * value that must always pass here — the caller decides which columns tolerate
 * it by whether it calls this or `asNumber`. What must not pass silently is a
 * value of the *wrong* type turning into `null` (e.g. a `parent` that failed
 * to parse quietly re-rooting a reply) — that is why this throws instead of
 * defaulting, same as `asNumber`.
 */
const asNullableNumber = (v: SQLOutputValue, field: string): number | null => {
	if (v === null) return null;
	if (typeof v !== "number") {
		throw new Error(`isso dump: expected ${field} to be a number or null, got ${typeof v}`);
	}
	return v;
};

const asString = (v: SQLOutputValue, field: string): string => {
	if (typeof v !== "string") {
		throw new Error(`isso dump: expected ${field} to be a string, got ${typeof v}`);
	}
	return v;
};

/** Same tolerance as `asNullableNumber`, for a string column. */
const asNullableString = (v: SQLOutputValue, field: string): string | null => {
	if (v === null) return null;
	if (typeof v !== "string") {
		throw new Error(`isso dump: expected ${field} to be a string or null, got ${typeof v}`);
	}
	return v;
};

/**
 * `created`/`modified` as a UTC `YYYY-MM-DD HH:MM:SS` string, seconds
 * floored. This is the shape isso's own importer reads (`isso import -t
 * generic`) — see the header caveat on this file for what a consumer
 * needs to know about it (it round-trips through isso's *local-time*
 * parser, not UTC).
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
 * The column list is explicit rather than `SELECT *`: unlike the import-lab
 * prototype this was measured against, this output is a contract other code
 * parses, so a future isso schema change adding a column must not silently
 * change what this emits.
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
			// `id` is a NOT NULL primary key, so it's the one column this reads
			// without a row to blame yet — every other error on this row names
			// it, because `mode` and `remote_addr` (and every other column here)
			// are nullable in isso's own DDL, and "expected comments.mode to be a
			// number, got object" is useless without knowing which row failed.
			// Never the row's own content, only its id — that stays within the
			// "errors never name content" rule.
			const id = asNumber(row.id ?? null, "comments.id");
			const tid = asNumber(row.tid ?? null, `comments.tid (comment ${id})`);
			const comment: IssoDumpComment = {
				id,
				parent: asNullableNumber(row.parent ?? null, `comments.parent (comment ${id})`),
				mode: asNumber(row.mode ?? null, `comments.mode (comment ${id})`),
				created: formatIssoCreated(
					asNumber(row.created ?? null, `comments.created (comment ${id})`),
				),
				created_epoch: asNumber(row.created ?? null, `comments.created (comment ${id})`),
				modified_epoch: asNullableNumber(
					row.modified ?? null,
					`comments.modified (comment ${id})`,
				),
				author: asNullableString(row.author ?? null, `comments.author (comment ${id})`),
				email: asNullableString(row.email ?? null, `comments.email (comment ${id})`),
				website: asNullableString(row.website ?? null, `comments.website (comment ${id})`),
				remote_addr: asString(
					row.remote_addr ?? null,
					`comments.remote_addr (comment ${id})`,
				),
				text: asString(row.text ?? null, `comments.text (comment ${id})`),
			};
			const existing = commentsByThread.get(tid);
			if (existing) existing.push(comment);
			else commentsByThread.set(tid, [comment]);
		}

		return threadRows.map((row) => {
			// Same reasoning as the comment loop above: `id` first, then every
			// other column's error names the thread it belongs to.
			const id = asNumber(row.id ?? null, "threads.id");
			return {
				id: asString(row.uri ?? null, `threads.uri (thread ${id})`),
				title: asNullableString(row.title ?? null, `threads.title (thread ${id})`),
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
			// A missing or flag-shaped value ("--out" as the last argument, or
			// "--out --something-else") is a usage error, not "write to stdout" —
			// falling through would silently ignore the operator's --out entirely.
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				console.error(USAGE);
				process.exit(1);
			}
			outPath = value;
			i++;
			continue;
		}
		if (arg.startsWith("--")) {
			// Any other flag is unrecognised. Without this, it fell into
			// `positional` and could silently become the db path.
			console.error(USAGE);
			process.exit(1);
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
		try {
			writeFileSync(outPath, json);
		} catch (err) {
			// A raw stack trace here would be a Node internals dump for what is
			// almost always an operator typo (bad directory, no permission).
			const message = err instanceof Error ? err.message : String(err);
			console.error(`isso dump: cannot write ${outPath}: ${message}`);
			process.exit(1);
		}
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
