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
 *      none of them has a Garrul column, and two are checked with real
 *      non-default values in the fixture so an accidental pass-through
 *      would be visible.
 *   6. A missing database file throws rather than returning nothing, the
 *      one aspect of the read-only open this suite can observe without a
 *      second writer.
 *
 * Fixture is hand-written SQL (see tests/fixtures/isso/PROVENANCE.md),
 * built into a real file in a temp dir with node:sqlite — the same
 * approach tests/admin-import-endpoint.test.ts uses for a migrations-
 * driven DB.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
	db.exec(FIXTURE_SQL);
	db.close();
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

	it("throws on a database path that does not exist", () => {
		expect(() => dumpIsso(join(dir, "does-not-exist.db"))).toThrow();
	});
});

describe("formatIssoCreated", () => {
	it("formats a known epoch as UTC, floored to the second", () => {
		expect(formatIssoCreated(1700000000.9)).toBe("2023-11-14 22:13:20");
	});
});
