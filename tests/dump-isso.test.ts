/**
 * `scripts/dump-isso.ts` reads an isso `comments.db` and emits the JSON
 * intermediate the isso adapter (#108, a later task) parses. This suite
 * covers:
 *
 *   1. Determinism — the dumper's output over the committed fixture SQL
 *      matches the committed `dump.json` byte-for-byte, not just
 *      structurally, so a silent formatting drift fails CI.
 *   2. Ordering — `comments.sql` inserts thread 1's rows out of `id`
 *      order on purpose; the dumper's own `ORDER BY tid, id` has to
 *      produce sorted output regardless.
 *   3. The empty thread (`/empty`) is present with `comments: []` rather
 *      than dropped — the dumper is a transport, not a translator; the
 *      adapter (not this file) is where a thread with no comments gets
 *      dropped (R7 in the design doc).
 *   4. `created` formatting — UTC, whole-second precision, independent of
 *      the fixture.
 *   5. `voters`/`likes`/`dislikes`/`notification` never reach the output —
 *      none of them has a Garrul column. This assertion can't actually fail
 *      against today's `dumpIsso` (the emitted object is a fixed literal,
 *      not a spread), so it is a guard against a future `SELECT *` or
 *      object-spread refactor reintroducing one of them, not a live pin —
 *      the byte-equality test above is the real pin on today's behavior.
 *   6. A missing database file throws rather than returning nothing, the
 *      one aspect of the read-only open this suite can observe without a
 *      second writer.
 *   7. NULLs and orphans — a NULL `mode`/`remote_addr` passes through as
 *      `null` (isso's DDL allows it), a NULL in a column isso itself
 *      requires is refused with a message that says `null`, and a comment
 *      whose `tid` matches no thread row stops the dump by name rather
 *      than being silently dropped.
 *
 * Fixture is hand-written SQL (see tests/fixtures/isso/PROVENANCE.md),
 * built into a real file in a temp dir with node:sqlite — the same
 * approach tests/admin-import-endpoint.test.ts uses for a migrations-
 * driven DB.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpIsso, formatIssoCreated } from "../scripts/dump-isso";

const FIXTURE_DIR = join(__dirname, "fixtures/isso");
const FIXTURE_SQL = readFileSync(join(FIXTURE_DIR, "comments.sql"), "utf8");
const DUMP_JSON_PATH = join(FIXTURE_DIR, "dump.json");
const DUMP_JSON_BYTES = readFileSync(DUMP_JSON_PATH, "utf8");

let dir: string;
let dbPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "isso-dump-test-"));
	dbPath = join(dir, "comments.db");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec(FIXTURE_SQL);
	} finally {
		// A failed exec must not leave the handle open — afterAll removes
		// `dir` regardless of whether this block succeeded.
		db.close();
	}
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("dumpIsso", () => {
	it("reproduces the committed dump.json structurally", () => {
		const threads = dumpIsso(dbPath);
		expect(threads).toEqual(JSON.parse(DUMP_JSON_BYTES));
	});

	it("reproduces the committed dump.json byte-for-byte", () => {
		const threads = dumpIsso(dbPath);
		const serialised = `${JSON.stringify(threads, null, 2)}\n`;
		expect(serialised).toBe(DUMP_JSON_BYTES);
	});

	it("orders threads by threads.id and comments by comments.id, even though the fixture inserts out of order", () => {
		const threads = dumpIsso(dbPath);
		expect(threads.map((t) => t.id)).toEqual([
			"/hello-world",
			"/posts/deep/nested/path/?page=2",
			"/posts/deep/nested/path/",
			"/empty",
			"/",
		]);
		const helloWorld = threads.find((t) => t.id === "/hello-world");
		expect(helloWorld?.comments.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("emits the empty thread with comments: []", () => {
		const threads = dumpIsso(dbPath);
		const empty = threads.find((t) => t.id === "/empty");
		expect(empty).toEqual({ id: "/empty", title: "Empty", comments: [] });
	});

	// Guards a future `SELECT *`/spread refactor — see the header note on why
	// this can't fail against today's implementation.
	it("never emits voters, likes, dislikes or notification", () => {
		const threads = dumpIsso(dbPath);
		for (const thread of threads) {
			for (const comment of thread.comments) {
				const keys = Object.keys(comment);
				expect(keys).not.toContain("voters");
				expect(keys).not.toContain("likes");
				expect(keys).not.toContain("dislikes");
				expect(keys).not.toContain("notification");
			}
		}
	});

	it("throws on a database path that does not exist, and does not create one", () => {
		const missing = join(dir, "does-not-exist.db");
		expect(() => dumpIsso(missing)).toThrow();
		// A read-write open would have created the file on open; this is the
		// one aspect of `readOnly: true` this suite can observe without a
		// second writer racing the same file.
		expect(existsSync(missing)).toBe(false);
	});
});

/**
 * isso's own DDL leaves every `comments` column but `id` and `tid` nullable,
 * so a NULL in any of them is a real shape a real database can hold. Which
 * NULLs the dumper carries and which it refuses follows that DDL: `mode` and
 * `remote_addr` pass through as `null` (the adapter defaults one and discards
 * the other), while `created` and `text` stay required — there is no faithful
 * value to invent for a comment with no timestamp. When it does refuse, the
 * message has to say which value it found, and `typeof null` is `"object"`,
 * which sends an operator looking for a JSON object in a SQLite column.
 *
 * The same harness covers a comment whose `tid` matches no thread row. isso
 * declares the foreign key but SQLite enforces nothing without
 * `PRAGMA foreign_keys`, so a hand-edited database can hold one; the dumper
 * must stop and name it rather than emit a dump that silently lost it.
 */
describe("dumpIsso — NULLs and orphans a real database can hold", () => {
	let nullDir: string;
	let seq = 0;

	const dbWith = (mutation: string): string => {
		// One file per call: two DatabaseSync opens on the same path would
		// re-run the fixture SQL into a database that already has it.
		seq += 1;
		const path = join(nullDir, `null-${seq}.db`);
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
		nullDir = mkdtempSync(join(tmpdir(), "isso-dump-null-test-"));
	});

	afterAll(() => {
		rmSync(nullDir, { recursive: true, force: true });
	});

	const commentById = (threads: ReturnType<typeof dumpIsso>, id: number) => {
		const hit = threads.flatMap((t) => t.comments).find((c) => c.id === id);
		if (!hit) throw new Error(`fixture has no comment ${id}`);
		return hit;
	};

	it("carries a NULL mode through as null rather than refusing the database", () => {
		const path = dbWith("UPDATE comments SET mode = NULL WHERE id = 1");
		expect(commentById(dumpIsso(path), 1).mode).toBeNull();
	});

	it("carries a NULL remote_addr through as null rather than refusing the database", () => {
		const path = dbWith("UPDATE comments SET remote_addr = NULL WHERE id = 1");
		expect(commentById(dumpIsso(path), 1).remote_addr).toBeNull();
	});

	it("says 'got null' for a NULL in a still-required column, not 'got object'", () => {
		// `threads.uri` is the one required column isso's DDL leaves nullable
		// (`comments.created` and `comments.text` are NOT NULL at the source
		// too, so a NULL there can't be built without rewriting the schema).
		const path = dbWith("UPDATE threads SET uri = NULL WHERE id = 1");
		expect(() => dumpIsso(path)).toThrow(
			"isso dump: expected threads.uri (thread 1) to be a string, got null",
		);
	});

	it("still refuses a wrong type in a nullable column", () => {
		const path = dbWith("UPDATE comments SET mode = 'approved' WHERE id = 1");
		expect(() => dumpIsso(path)).toThrow(
			"isso dump: expected comments.mode (comment 1) to be a number or null, got string",
		);
	});

	it("throws, naming the comments, when a tid matches no thread row", () => {
		// node:sqlite turns foreign-key enforcement on by default; isso's own
		// connection never does, which is exactly how such a row gets to exist.
		const path = dbWith(
			"PRAGMA foreign_keys = OFF; UPDATE comments SET tid = 999 WHERE id IN (1, 2)",
		);
		expect(() => dumpIsso(path)).toThrow(
			"isso dump: comments reference threads that do not exist — tid 999: comments 1, 2",
		);
	});
});

describe("formatIssoCreated", () => {
	it("formats a known epoch as UTC, floored to the second", () => {
		expect(formatIssoCreated(1700000000.9)).toBe("2023-11-14 22:13:20");
	});
});
