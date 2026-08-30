/**
 * `scripts/dump-cusdis.ts` reads a Cusdis `db.sqlite` and emits the JSON
 * intermediate the Cusdis adapter (#109) parses. This suite covers:
 *
 *   1. Determinism — the dumper's output over the committed fixture SQL
 *      matches the committed `dump.json` byte-for-byte, not just
 *      structurally, so a silent formatting drift fails CI.
 *   2. Ordering — `cusdis.sql` inserts the projects and `/hello-world`'s
 *      comments out of order on purpose; the dumper's own `ORDER BY` has to
 *      produce sorted output regardless: projects and pages by `id`,
 *      comments by `(created_at, id)`.
 *   3. The empty page (`/empty`) is present with `comments: []` rather than
 *      dropped — the dumper is a transport, not a translator; the adapter
 *      is where a page with no comments gets dropped.
 *   4. Shape — `approved` is a real boolean, `deleted_at` is a number or
 *      null, timestamps are epoch milliseconds untouched, `source` is the
 *      first key.
 *   5. `projects.token` never reaches the output — it is the widget API
 *      credential — nor do `moderatorId`, `ownerId`, `webhook` or the
 *      notification columns. The fixture sets the token to a known
 *      placeholder so this is a pin on real bytes, not on a key name.
 *   6. A missing database file throws rather than returning nothing, the
 *      one aspect of the read-only open this suite can observe without a
 *      second writer.
 *   7. NULLs, wrong types and orphans — nullable columns pass through as
 *      `null`, a NULL or wrong type in a required column is refused with a
 *      message that says what it found, `approved` outside `0`/`1` is
 *      refused rather than coerced, and a comment or page whose foreign key
 *      matches nothing stops the dump by id rather than being dropped.
 *
 * Fixture is hand-written SQL (see tests/fixtures/cusdis/PROVENANCE.md),
 * built into a real file in a temp dir with node:sqlite.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CusdisDump, dumpCusdis } from "../scripts/dump-cusdis";

const FIXTURE_DIR = join(__dirname, "fixtures/cusdis");
const FIXTURE_SQL = readFileSync(join(FIXTURE_DIR, "cusdis.sql"), "utf8");
const DUMP_JSON_PATH = join(FIXTURE_DIR, "dump.json");
const DUMP_JSON_BYTES = readFileSync(DUMP_JSON_PATH, "utf8");

const BLOG = "11111111-1111-4111-8111-111111111111";
const DOCS = "22222222-2222-4222-8222-222222222222";
const OLD = "33333333-3333-4333-8333-333333333333";
const cid = (n: number): string => `c${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pid = (n: number): string => `p${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

let dir: string;
let dbPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "cusdis-dump-test-"));
	dbPath = join(dir, "db.sqlite");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(FIXTURE_SQL);
	} finally {
		db.close();
	}
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const pageBySlug = (dump: CusdisDump, projectId: string, slug: string) => {
	const project = dump.projects.find((p) => p.id === projectId);
	if (!project) throw new Error(`fixture has no project ${projectId}`);
	const page = project.pages.find((p) => p.slug === slug);
	if (!page) throw new Error(`fixture has no page ${slug} in ${projectId}`);
	return page;
};

describe("dumpCusdis", () => {
	it("reproduces the committed dump.json structurally", () => {
		expect(dumpCusdis(dbPath)).toEqual(JSON.parse(DUMP_JSON_BYTES));
	});

	it("reproduces the committed dump.json byte-for-byte", () => {
		const serialised = `${JSON.stringify(dumpCusdis(dbPath), null, 2)}\n`;
		expect(serialised).toBe(DUMP_JSON_BYTES);
	});

	it("puts source first, so the format tag is the first thing a reader sees", () => {
		const dump = dumpCusdis(dbPath);
		expect(Object.keys(dump)).toEqual(["source", "version", "projects"]);
		expect(dump.source).toBe("cusdis");
		expect(dump.version).toBe(1);
		expect(JSON.stringify(dump).startsWith('{"source":"cusdis"')).toBe(true);
	});

	it("orders projects and pages by id and comments by (created_at, id), regardless of insert order", () => {
		const dump = dumpCusdis(dbPath);
		expect(dump.projects.map((p) => p.id)).toEqual([BLOG, DOCS, OLD]);
		expect(dump.projects[0]?.pages.map((p) => p.id)).toEqual([1, 2, 3, 4, 5].map(pid));
		expect(dump.projects[1]?.pages.map((p) => p.id)).toEqual([pid(6)]);
		expect(dump.projects[2]?.pages.map((p) => p.id)).toEqual([pid(7)]);
		const hello = pageBySlug(dump, BLOG, "/hello-world");
		expect(hello.comments.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(cid));
	});

	it("emits the empty page with comments: []", () => {
		const empty = pageBySlug(dumpCusdis(dbPath), BLOG, "/empty");
		expect(empty).toEqual({
			id: pid(5),
			slug: "/empty",
			url: "https://blog.example.com/empty",
			title: "Empty",
			comments: [],
		});
	});

	it("carries nullable page columns through as null", () => {
		const about = pageBySlug(dumpCusdis(dbPath), BLOG, "/about");
		expect(about.url).toBeNull();
		expect(about.title).toBeNull();
	});

	it("emits approved as a boolean and deleted_at as a number or null, timestamps untouched", () => {
		const hello = pageBySlug(dumpCusdis(dbPath), BLOG, "/hello-world");
		const byId = new Map(hello.comments.map((c) => [c.id, c]));
		const c1 = byId.get(cid(1));
		const c5 = byId.get(cid(5));
		const c6 = byId.get(cid(6));
		const c9 = byId.get(cid(9));
		expect(c1).toMatchObject({
			parent_id: null,
			created_at: 1700000000000,
			updated_at: 1700000000000,
			deleted_at: null,
			approved: true,
			by_nickname: "Alice Example",
			by_email: "alice@example.com",
		});
		expect(c5?.approved).toBe(false);
		expect(c6).toMatchObject({ deleted_at: 1700001500000, approved: true, by_email: "dave@example.net" });
		expect(c9).toMatchObject({ created_at: 1700000800000, updated_at: 1700000900000 });
		expect(byId.get(cid(3))?.parent_id).toBe(cid(1));
		expect(byId.get(cid(4))?.by_email).toBeNull();
		expect(byId.get(cid(8))?.by_nickname).toBe("");
	});

	it("carries projects.deleted_at through as a number or null", () => {
		// The dumper is a transport: a deleted project's pages and comments are
		// emitted like any other's, and the adapter decides what to do with it.
		const dump = dumpCusdis(dbPath);
		expect(dump.projects.map((p) => p.deleted_at)).toEqual([null, null, 1700006000000]);
		expect(dump.projects[2]?.pages[0]?.comments).toHaveLength(1);
	});

	it("emits exactly the documented keys, in order, on every level", () => {
		const dump = dumpCusdis(dbPath);
		for (const project of dump.projects) {
			expect(Object.keys(project)).toEqual(["id", "title", "deleted_at", "pages"]);
			for (const page of project.pages) {
				expect(Object.keys(page)).toEqual(["id", "slug", "url", "title", "comments"]);
				for (const comment of page.comments) {
					expect(Object.keys(comment)).toEqual([
						"id",
						"parent_id",
						"created_at",
						"updated_at",
						"deleted_at",
						"approved",
						"by_nickname",
						"by_email",
						"content",
					]);
				}
			}
		}
	});

	it("never emits the project token or any operator column", () => {
		// The fixture sets a known placeholder so this pins bytes, not a key.
		expect(DUMP_JSON_BYTES).not.toContain("fixture-token-do-not-emit");
		expect(DUMP_JSON_BYTES).not.toContain("u0000001-0000-4000-8000-000000000001");
		for (const key of ["token", "ownerId", "moderatorId", "webhook", "enableWebhook", "enable_notification", "fetch_latest_comments_at"]) {
			expect(DUMP_JSON_BYTES).not.toContain(`"${key}"`);
		}
	});

	it("throws on a database path that does not exist, and does not create one", () => {
		const missing = join(dir, "does-not-exist.sqlite");
		expect(() => dumpCusdis(missing)).toThrow();
		expect(existsSync(missing)).toBe(false);
	});
});

/**
 * Which NULLs the dumper carries and which it refuses follows Cusdis' own
 * Prisma DDL: `deletedAt`, `by_email`, `parentId`, `pages.url` and
 * `pages.title` are nullable there and pass through; everything else is NOT
 * NULL at the source, so a NULL there is a corrupt file, not a shape Cusdis
 * can produce. SQLite's `NOT NULL` is enforced on insert, so the only way to
 * get such a row into the test is to rebuild the column — these tests use
 * `UPDATE` on the columns that allow it and a wrong *type* (which SQLite's
 * dynamic typing does allow) on the ones that don't.
 *
 * Foreign keys: Cusdis' DDL declares them, but SQLite enforces nothing
 * without `PRAGMA foreign_keys`, so a hand-edited or partially restored
 * database can hold an orphan. node:sqlite turns enforcement on by default,
 * which is why the mutation turns it off first — the same way such a row
 * gets to exist in a real file.
 */
describe("dumpCusdis — NULLs, wrong types and orphans a real database can hold", () => {
	let mutDir: string;
	let seq = 0;

	const dbWith = (mutation: string): string => {
		seq += 1;
		const path = join(mutDir, `mut-${seq}.sqlite`);
		const db = new DatabaseSync(path);
		try {
			db.exec(FIXTURE_SQL);
			db.exec(mutation);
		} finally {
			db.close();
		}
		return path;
	};

	beforeAll(() => {
		mutDir = mkdtempSync(join(tmpdir(), "cusdis-dump-mut-test-"));
	});

	afterAll(() => {
		rmSync(mutDir, { recursive: true, force: true });
	});

	it("still refuses a wrong type in a nullable column, saying what it found", () => {
		const path = dbWith(`UPDATE comments SET "deletedAt" = 'yesterday' WHERE id = '${cid(1)}'`);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: expected comments.deletedAt (comment ${cid(1)}) to be a number or null, got string`,
		);
	});

	it("refuses a text timestamp in a required column rather than parsing it", () => {
		// The DDL's `DEFAULT CURRENT_TIMESTAMP` writes exactly this on a row
		// inserted by hand, outside Prisma.
		const path = dbWith(`UPDATE comments SET created_at = '2023-11-14 22:13:20' WHERE id = '${cid(1)}'`);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: expected comments.created_at (comment ${cid(1)}) to be a number, got string`,
		);
	});

	it("refuses a REAL in a timestamp column rather than dumping a value the adapter will reject", () => {
		// SQLite's DATETIME affinity is NUMERIC, so a hand-typed 1700000000000.5
		// is stored as a REAL and read back as one. The adapter refuses any
		// non-integer epoch, so this has to fail here, naming the row.
		const path = dbWith(`UPDATE comments SET created_at = 1700000000000.5 WHERE id = '${cid(1)}'`);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: expected comments.created_at (comment ${cid(1)}) to be an integer, got 1700000000000.5`,
		);
		const nullable = dbWith(`UPDATE comments SET "deletedAt" = 0.5 WHERE id = '${cid(1)}'`);
		expect(() => dumpCusdis(nullable)).toThrow(
			`cusdis dump: expected comments.deletedAt (comment ${cid(1)}) to be an integer, got 0.5`,
		);
	});

	it("refuses an approved value that is neither 0 nor 1 rather than coercing it", () => {
		const path = dbWith(`UPDATE comments SET approved = 2 WHERE id = '${cid(1)}'`);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: expected comments.approved (comment ${cid(1)}) to be 0 or 1, got number`,
		);
	});

	it("says 'got null' for a NULL in a required column, not 'got object'", () => {
		// `pages.url` is nullable, `pages.slug` is not — rebuild slug's
		// constraint away to plant the NULL.
		const path = dbWith(
			`PRAGMA foreign_keys = OFF; CREATE TABLE p2 AS SELECT * FROM pages; DROP TABLE pages; ALTER TABLE p2 RENAME TO pages; UPDATE pages SET slug = NULL WHERE id = '${pid(2)}'`,
		);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: expected pages.slug (page ${pid(2)}) to be a string, got null`,
		);
	});

	it("throws, naming the comments, when a pageId matches no page row", () => {
		const path = dbWith(
			`PRAGMA foreign_keys = OFF; UPDATE comments SET "pageId" = 'p0000099-0000-4000-8000-000000000099' WHERE id IN ('${cid(1)}', '${cid(2)}')`,
		);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: comments reference pages that do not exist — page p0000099-0000-4000-8000-000000000099: comments ${cid(1)}, ${cid(2)}`,
		);
	});

	it("throws, naming the pages, when a projectId matches no project row", () => {
		const path = dbWith(
			`PRAGMA foreign_keys = OFF; UPDATE pages SET "projectId" = '99999999-9999-4999-8999-999999999999' WHERE id = '${pid(5)}'`,
		);
		expect(() => dumpCusdis(path)).toThrow(
			`cusdis dump: pages reference projects that do not exist — project 99999999-9999-4999-8999-999999999999: pages ${pid(5)}`,
		);
	});
});
