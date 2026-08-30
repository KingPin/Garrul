#!/usr/bin/env tsx
/**
 * Dump a Cusdis `db.sqlite` file to the JSON intermediate the Cusdis adapter
 * (src/lib/import/cusdis.ts, #109) reads.
 *
 *   npm run dump-cusdis -- ./db.sqlite                  # to stdout
 *   npm run dump-cusdis -- ./db.sqlite --out dump.json  # to a file
 *
 * Cusdis (djyde/cusdis) is deprecated upstream and ships no export: no
 * dashboard button, no CLI, no export endpoint. Its own README now points
 * users wanting their data at a support email. The database *is* the data,
 * which makes it a Class B source per docs/importing.md, same as isso: a
 * node-only dumper reads the store and emits a JSON document, and an
 * ordinary adapter parses that document the same way it would parse any
 * other source's real export. `node:sqlite` is Node's own driver, built in
 * since 22.5 (this repo's `engines.node` is `>=24`), so reading it here is
 * zero new dependencies — but it is also exactly why this file lives in
 * scripts/ and not src/lib/import/: no SQLite driver may ever be reachable
 * from the Worker bundle.
 *
 * SQLite only. Cusdis' `DB_TYPE` also allows `pgsql` and `mysql` with a
 * structurally identical schema, but SQLite is the default and what the
 * documented docker quickstart uses. A Postgres/MySQL operator converts to
 * SQLite first; the intermediate is database-agnostic, so a second dumper
 * could emit the same shape later without touching the adapter.
 *
 * ## Why not the API
 *
 * Three read paths exist and none is usable, recorded here so nobody
 * retries them: `GET /api/open/comments` returns only `approved: true`
 * rows and never `by_email` (silently lossy); `GET /api/open/project/
 * {id}/comments/latest` is authenticated but *destructive* — it marks what
 * it returns as read; and the dashboard route is gated by a NextAuth
 * session cookie with no public contract.
 *
 * ## The intermediate
 *
 * Cusdis has no import format of its own to mirror (its only importer reads
 * Disqus XML), so this is Garrul's own shape, nested the way the tables
 * relate — a project owns pages, a page owns comments:
 *
 *   { source: "cusdis", version: 1,
 *     projects: [ { id, title,
 *       pages: [ { id, slug, url, title,
 *         comments: [ { id, parent_id, created_at, updated_at, deleted_at,
 *                       approved, by_nickname, by_email, content } ] } ] } ] }
 *
 * `source` is written first so a reader — human or the admin upload
 * route.s sniff — sees the format tag before anything else. The sniff
 * itself is order-free, so a re-serialised dump still uploads.
 *
 * A transport, not a translator: rows arrive as Cusdis wrote them.
 * `approved` and `deleted_at` travel through untranslated — mapping them
 * onto Garrul's `comments.status` vocabulary is the adapter's job. The two
 * exceptions are shape, not meaning: `approved` becomes a real boolean
 * (SQLite has none; Prisma stores `0`/`1`), and the `camelCase` column
 * names Prisma left unmapped (`parentId`, `deletedAt`) are emitted in the
 * intermediate's own `snake_case` so a consumer sees one convention.
 *
 * ## What is read, and what is deliberately not
 *
 * `projects`, `pages`, `comments` — nothing else. The database also holds
 * next-auth's `users`, `accounts`, `sessions` and `verification_requests`:
 * a Cusdis commenter is never a registered user (identity is on the comment
 * row itself, `by_nickname` + `by_email`), so `users` describes only the
 * operator, and `accounts`/`sessions` hold OAuth access tokens and live
 * session tokens. `projects.token` — the widget's API token — is the one
 * credential on a table this does read, and it is never emitted. Nor are
 * `moderatorId`, `ownerId`, `webhook`, `fetch_latest_comments_at` or the
 * notification flags: they name the operator or configure the instance,
 * and no Garrul column wants them.
 *
 * Opens the database `readOnly: true` — a dumper has no business writing to
 * a live installation's store, and Cusdis may still be running against the
 * same file while this reads it.
 *
 * ## Timestamps
 *
 * Prisma stores SQLite `DateTime` as integer epoch **milliseconds**, which
 * is also Garrul's `created_at` unit, so they pass through as numbers with
 * no conversion and no string form. A `DATETIME` column whose value is not
 * a number (the DDL's `DEFAULT CURRENT_TIMESTAMP` would write a text
 * timestamp on a row inserted by hand, outside Prisma) is refused rather
 * than parsed — that row is not one Cusdis wrote, and guessing its
 * timezone would be inventing a fact.
 */
import { writeFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

/**
 * One comment in the intermediate. Field order matches the format spec
 * exactly — this is a contract other code (the Cusdis adapter, and its
 * fixture-driven tests) parses, not an incidental object shape.
 */
export type CusdisDumpComment = {
	id: string;
	parent_id: string | null;
	created_at: number;
	updated_at: number;
	deleted_at: number | null;
	approved: boolean;
	by_nickname: string;
	by_email: string | null;
	content: string;
};

/** One page in the intermediate, `comments` in `(created_at, id)` order. */
export type CusdisDumpPage = {
	id: string;
	slug: string;
	url: string | null;
	title: string | null;
	comments: CusdisDumpComment[];
};

/** One project in the intermediate, `pages` in `id` order. */
export type CusdisDumpProject = {
	id: string;
	title: string;
	pages: CusdisDumpPage[];
};

/** The whole document. `source` first, so the format tag is the first thing read. */
export type CusdisDump = {
	source: "cusdis";
	version: 1;
	projects: CusdisDumpProject[];
};

type Row = Record<string, SQLOutputValue>;

/**
 * `typeof`, except a SQL NULL reports as `"null"`.
 *
 * `typeof null` is `"object"`, and "expected comments.deletedAt to be a
 * number, got object" reads as though the column held a JSON object — it
 * sends an operator looking for the wrong thing in the right column.
 */
const typeName = (v: SQLOutputValue): string => (v === null ? "null" : typeof v);

const asNumber = (v: SQLOutputValue, field: string): number => {
	if (typeof v !== "number") {
		throw new Error(`cusdis dump: expected ${field} to be a number, got ${typeName(v)}`);
	}
	return v;
};

/**
 * `null` passes through untouched; anything else must be a number. Which
 * columns tolerate NULL follows Cusdis' own DDL, not what the adapter would
 * prefer — the caller decides by whether it calls this or `asNumber`. What
 * must not pass silently is a value of the *wrong* type turning into `null`
 * (a `deletedAt` that failed to parse quietly un-deleting a comment), which
 * is why this throws instead of defaulting, same as `asNumber`.
 */
const asNullableNumber = (v: SQLOutputValue, field: string): number | null => {
	if (v === null) return null;
	if (typeof v !== "number") {
		throw new Error(`cusdis dump: expected ${field} to be a number or null, got ${typeName(v)}`);
	}
	return v;
};

const asString = (v: SQLOutputValue, field: string): string => {
	if (typeof v !== "string") {
		throw new Error(`cusdis dump: expected ${field} to be a string, got ${typeName(v)}`);
	}
	return v;
};

/** Same tolerance as `asNullableNumber`, for a string column. */
const asNullableString = (v: SQLOutputValue, field: string): string | null => {
	if (v === null) return null;
	if (typeof v !== "string") {
		throw new Error(`cusdis dump: expected ${field} to be a string or null, got ${typeName(v)}`);
	}
	return v;
};

/**
 * Prisma stores a SQLite `Boolean` as integer `0`/`1`, and the column is
 * `NOT NULL`. Anything else — `NULL`, `2`, the text `"true"` — is a value
 * Cusdis never wrote, and reading it as either state would publish or hide
 * a comment on a guess.
 */
const asBoolean = (v: SQLOutputValue, field: string): boolean => {
	if (v === 0) return false;
	if (v === 1) return true;
	throw new Error(`cusdis dump: expected ${field} to be 0 or 1, got ${typeName(v)}`);
};

/**
 * Read a Cusdis `db.sqlite` and return its projects, pages and comments —
 * projects and pages ordered by `id`, comments within a page ordered by
 * `(created_at, id)` — independent of whatever order the rows happen to
 * live in on disk.
 *
 * The column list is explicit rather than `SELECT *`: this output is a
 * contract other code parses, so a future schema change adding a column
 * must not silently change what this emits — and `projects.token` is on the
 * same table as the two columns this does want.
 */
export const dumpCusdis = (dbPath: string): CusdisDump => {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const projectRows: Row[] = db.prepare('SELECT id, title FROM projects ORDER BY id').all();
		const pageRows: Row[] = db
			.prepare('SELECT id, slug, url, title, "projectId" FROM pages ORDER BY id')
			.all();
		const commentRows: Row[] = db
			.prepare(
				'SELECT id, "pageId", created_at, updated_at, "deletedAt", by_email, by_nickname, ' +
					'content, approved, "parentId" FROM comments ORDER BY "pageId", created_at, id',
			)
			.all();

		const commentsByPage = new Map<string, CusdisDumpComment[]>();
		for (const row of commentRows) {
			// `id` is a NOT NULL primary key, so it's the one column this reads
			// without a row to blame yet — every other error on this row names
			// it. Never the row's own content, only its id — that stays within
			// the "errors never name content" rule.
			//
			// Which columns tolerate NULL follows Cusdis' DDL: `deletedAt`,
			// `by_email` and `parentId` are nullable there; `created_at`,
			// `updated_at`, `by_nickname`, `content` and `approved` are NOT
			// NULL, so a NULL in any of them is a corrupt file, not a shape
			// Cusdis can produce.
			const id = asString(row.id ?? null, "comments.id");
			const pageId = asString(row.pageId ?? null, `comments.pageId (comment ${id})`);
			const comment: CusdisDumpComment = {
				id,
				parent_id: asNullableString(row.parentId ?? null, `comments.parentId (comment ${id})`),
				created_at: asNumber(row.created_at ?? null, `comments.created_at (comment ${id})`),
				updated_at: asNumber(row.updated_at ?? null, `comments.updated_at (comment ${id})`),
				deleted_at: asNullableNumber(
					row.deletedAt ?? null,
					`comments.deletedAt (comment ${id})`,
				),
				approved: asBoolean(row.approved ?? null, `comments.approved (comment ${id})`),
				by_nickname: asString(row.by_nickname ?? null, `comments.by_nickname (comment ${id})`),
				by_email: asNullableString(row.by_email ?? null, `comments.by_email (comment ${id})`),
				content: asString(row.content ?? null, `comments.content (comment ${id})`),
			};
			const existing = commentsByPage.get(pageId);
			if (existing) existing.push(comment);
			else commentsByPage.set(pageId, [comment]);
		}

		const pagesByProject = new Map<string, CusdisDumpPage[]>();
		for (const row of pageRows) {
			const id = asString(row.id ?? null, "pages.id");
			const projectId = asString(row.projectId ?? null, `pages.projectId (page ${id})`);
			const comments = commentsByPage.get(id) ?? [];
			commentsByPage.delete(id);
			const page: CusdisDumpPage = {
				id,
				slug: asString(row.slug ?? null, `pages.slug (page ${id})`),
				url: asNullableString(row.url ?? null, `pages.url (page ${id})`),
				title: asNullableString(row.title ?? null, `pages.title (page ${id})`),
				comments,
			};
			const existing = pagesByProject.get(projectId);
			if (existing) existing.push(page);
			else pagesByProject.set(projectId, [page]);
		}

		const projects = projectRows.map((row) => {
			const id = asString(row.id ?? null, "projects.id");
			const pages = pagesByProject.get(id) ?? [];
			pagesByProject.delete(id);
			return {
				id,
				title: asString(row.title ?? null, `projects.title (project ${id})`),
				pages,
			};
		});

		// Whatever is still in either map is a row whose foreign key matches
		// nothing. Cusdis' DDL declares both constraints but SQLite enforces
		// nothing without `PRAGMA foreign_keys`, so a hand-edited or partially
		// restored database can hold them. Emitting the dump without them
		// would report success while silently losing comments; a transport
		// that drops rows is worse than one that stops.
		if (commentsByPage.size > 0) {
			const orphans = [...commentsByPage.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([pageId, rows]) => `page ${pageId}: comments ${rows.map((c) => c.id).join(", ")}`)
				.join("; ");
			throw new Error(`cusdis dump: comments reference pages that do not exist — ${orphans}`);
		}
		if (pagesByProject.size > 0) {
			const orphans = [...pagesByProject.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(
					([projectId, rows]) => `project ${projectId}: pages ${rows.map((p) => p.id).join(", ")}`,
				)
				.join("; ");
			throw new Error(`cusdis dump: pages reference projects that do not exist — ${orphans}`);
		}

		return { source: "cusdis", version: 1, projects };
	} finally {
		db.close();
	}
};

// ------------------------------------ CLI -----------------------------------

const USAGE = "usage: npm run dump-cusdis -- <db.sqlite> [--out file.json]";

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

	const dump = dumpCusdis(dbPath);
	const json = `${JSON.stringify(dump, null, 2)}\n`;
	if (outPath) {
		try {
			writeFileSync(outPath, json);
		} catch (err) {
			// A raw stack trace here would be a Node internals dump for what is
			// almost always an operator typo (bad directory, no permission).
			const message = err instanceof Error ? err.message : String(err);
			console.error(`cusdis dump: cannot write ${outPath}: ${message}`);
			process.exit(1);
		}
	} else {
		process.stdout.write(json);
	}
};

// Guards the CLI so tests can import `dumpCusdis` without running it. Under
// vitest `process.argv[1]` is vitest's own binary, never this file, so the
// guard never fires there; it fires only when this file is executed directly
// (`tsx scripts/dump-cusdis.ts`, or the `dump-cusdis` npm script).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
