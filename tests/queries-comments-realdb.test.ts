/**
 * Real-SQLite regression coverage for the comment write paths.
 *
 * The rest of the comment suite uses hand-rolled D1 stubs that route by SQL
 * substring — fast, but they never parse SQL, so a column/value-count mismatch
 * in an INSERT/UPDATE sails straight through (it did: the `deleted_by` column
 * was added to insertComment's column list without a matching VALUES entry,
 * breaking *all* comment creation, and no stub test caught it).
 *
 * These tests run the genuine queries against Node's built-in `node:sqlite`
 * (no new dependency, no network) with every migration applied, so the SQL is
 * executed for real and column drift fails loudly.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	insertComment,
	getComment,
	softDeleteComment,
	updateCommentStatus,
} from "../src/db/queries";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

// Minimal D1Database adapter over node:sqlite. Covers the surface the comment
// write/read queries use: prepare().bind().run()/first()/all().
const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				return this;
			},
			async run() {
				const r = stmt.run(...(bound as never[]));
				return { success: true, meta: { changes: r.changes } };
			},
			async first() {
				return stmt.get(...(bound as never[])) ?? null;
			},
			async all() {
				return { results: stmt.all(...(bound as never[])) };
			},
		};
	},
});

const migrationFiles = (): string[] =>
	readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

const applyMigrations = (sqlite: DatabaseSync, files: string[]) => {
	for (const file of files) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
};

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	applyMigrations(sqlite, migrationFiles());
	return makeD1(sqlite);
};

const baseInput = {
	post_slug: "hello",
	parent_id: null,
	user_id: "u1",
	body_md: "hi",
	body_html: "<p>hi</p>",
	renderer_version: 1,
	ip_hash: "iphash",
	user_agent: "ua",
	depth: 1,
};

describe("comment write paths (real SQLite)", () => {
	let db: any;
	beforeEach(async () => {
		db = freshDb();
		// comments has real FKs on post_slug → posts and user_id → users, and
		// node:sqlite enforces them — seed both parents first.
		await db
			.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
			.bind("hello", "Hello", null, 1_700_000_000_000)
			.run();
		await db
			.prepare(
				"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.bind("u1", "anon", null, "u1", 1_700_000_000_000)
			.run();
	});

	it("insertComment persists a row with fields in the right columns", async () => {
		const c = await insertComment(db, baseInput);
		const row = await getComment(db, c.id);
		expect(row).not.toBeNull();
		// The bug this guards: a column/value shift would land ip_hash in
		// deleted_by, etc. Assert each field landed in its own column.
		expect(row!.status).toBe("approved");
		expect(row!.deleted_by).toBeNull();
		expect(row!.deleted_at).toBeNull();
		expect(row!.ip_hash).toBe("iphash");
		expect(row!.user_agent).toBe("ua");
		expect(row!.body_html).toBe("<p>hi</p>");
		expect(typeof row!.created_at).toBe("number");
	});

	it("insertComment honors a forced 'pending' status", async () => {
		const c = await insertComment(db, { ...baseInput, status: "pending" });
		const row = await getComment(db, c.id);
		expect(row!.status).toBe("pending");
		expect(row!.deleted_by).toBeNull();
	});

	it("softDeleteComment attributes the removal to the author", async () => {
		const c = await insertComment(db, baseInput);
		await softDeleteComment(db, c.id);
		const row = await getComment(db, c.id);
		expect(row!.status).toBe("deleted");
		expect(row!.deleted_by).toBe("author");
		expect(typeof row!.deleted_at).toBe("number");
	});

	it("updateCommentStatus to 'deleted' attributes the removal to a moderator", async () => {
		const c = await insertComment(db, baseInput);
		await updateCommentStatus(db, c.id, "deleted");
		const row = await getComment(db, c.id);
		expect(row!.status).toBe("deleted");
		expect(row!.deleted_by).toBe("moderator");
		expect(typeof row!.deleted_at).toBe("number");
	});

	it("updateCommentStatus away from 'deleted' clears deleted_at/deleted_by", async () => {
		const c = await insertComment(db, baseInput);
		await updateCommentStatus(db, c.id, "deleted");
		await updateCommentStatus(db, c.id, "approved");
		const row = await getComment(db, c.id);
		expect(row!.status).toBe("approved");
		expect(row!.deleted_by).toBeNull();
		expect(row!.deleted_at).toBeNull();
	});
});

/**
 * 0015 backfills `depth` with a recursive CTE. A recursive UPDATE is the kind
 * of SQL the substring-matching D1 stubs cannot exercise at all, and getting
 * it wrong on an operator's live database is not recoverable forward-only, so
 * it runs here against real SQLite with real pre-migration rows.
 */
describe("migration 0015 depth backfill (real SQLite)", () => {
	const DEPTH_MIGRATION = "0015_comment_depth.sql";

	// Rows as they existed before 0015: no depth column to write to.
	const seedLegacy = (
		sqlite: DatabaseSync,
		rows: { id: string; parent_id: string | null }[],
	) => {
		sqlite.exec(
			"INSERT INTO posts (slug, title, url, created_at) VALUES ('hello', 'Hello', NULL, 1700000000000)",
		);
		sqlite.exec(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'u1', 1700000000000)",
		);
		const stmt = sqlite.prepare(
			"INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, created_at) VALUES (?, 'hello', ?, 'u1', 'x', '<p>x</p>', 1700000000000)",
		);
		for (const r of rows) stmt.run(r.id, r.parent_id);
	};

	const backfilled = (rows: { id: string; parent_id: string | null }[]) => {
		const sqlite = new DatabaseSync(":memory:");
		const files = migrationFiles();
		const cut = files.indexOf(DEPTH_MIGRATION);
		expect(cut).toBeGreaterThan(0); // guard against a rename orphaning this test
		applyMigrations(sqlite, files.slice(0, cut));
		seedLegacy(sqlite, rows);
		applyMigrations(sqlite, [DEPTH_MIGRATION]);
		const out = new Map<string, number>();
		for (const row of sqlite.prepare("SELECT id, depth FROM comments").all() as {
			id: string;
			depth: number;
		}[]) {
			out.set(row.id, row.depth);
		}
		return out;
	};

	it("assigns 1 to roots and parent+1 down a chain", () => {
		const depths = backfilled([
			{ id: "a", parent_id: null },
			{ id: "b", parent_id: "a" },
			{ id: "c", parent_id: "b" },
			{ id: "d", parent_id: "c" },
		]);
		expect(depths.get("a")).toBe(1);
		expect(depths.get("b")).toBe(2);
		expect(depths.get("c")).toBe(3);
		expect(depths.get("d")).toBe(4);
	});

	it("handles siblings and multiple roots independently", () => {
		const depths = backfilled([
			{ id: "r1", parent_id: null },
			{ id: "r2", parent_id: null },
			{ id: "r1a", parent_id: "r1" },
			{ id: "r1b", parent_id: "r1" },
			{ id: "r2a", parent_id: "r2" },
			{ id: "r1a1", parent_id: "r1a" },
		]);
		expect([...depths.values()].length).toBe(6);
		expect(depths.get("r2")).toBe(1);
		expect(depths.get("r1b")).toBe(2);
		expect(depths.get("r2a")).toBe(2);
		expect(depths.get("r1a1")).toBe(3);
	});

	it("fails an unreachable row closed instead of violating NOT NULL", () => {
		// A dangling parent_id is the reachable stand-in for "the recursion never
		// got here"; the other case is a chain past the migration's depth guard.
		// Either way the row must end up unreplyable, not NULL (NOT NULL column)
		// and not 1 (which would reopen the chain for more replies).
		const sqlite = new DatabaseSync(":memory:");
		const files = migrationFiles();
		const cut = files.indexOf(DEPTH_MIGRATION);
		applyMigrations(sqlite, files.slice(0, cut));
		seedLegacy(sqlite, [{ id: "a", parent_id: null }]);
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(
			"INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, created_at) VALUES ('orphan', 'hello', 'gone', 'u1', 'x', '<p>x</p>', 1700000000000)",
		);
		sqlite.exec("PRAGMA foreign_keys = ON");
		expect(() => applyMigrations(sqlite, [DEPTH_MIGRATION])).not.toThrow();
		const row = sqlite
			.prepare("SELECT depth FROM comments WHERE id = 'orphan'")
			.get() as { depth: number };
		expect(row.depth).toBe(1000);
		// The healthy root alongside it is unaffected.
		expect(
			(sqlite.prepare("SELECT depth FROM comments WHERE id = 'a'").get() as { depth: number })
				.depth,
		).toBe(1);
	});
});
