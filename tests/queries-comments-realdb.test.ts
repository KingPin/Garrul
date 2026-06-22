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

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
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
