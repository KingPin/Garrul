/**
 * Query plans for migration 0031 (admin list and dashboard indexes).
 *
 * Each admin read below used to scan its table and sort in a temp B-tree.
 * The plans pin the index each one now takes, and pin the two public reads
 * that the new status index would otherwise capture (see the unary `+` in
 * listLatestApprovedComments and isNameClaimed).
 *
 * Real SQLite, every migration applied, EXPLAIN on the exact SQL and binds
 * the code issued.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	adminListComments,
	adminListSubscriptions,
	adminListUsers,
	adminOldestPending,
	adminTimeline,
	isNameClaimed,
	listLatestApprovedComments,
} from "../src/db/queries";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

let sqlite: DatabaseSync;
let last: { sql: string; binds: unknown[] } | null = null;

const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		last = { sql, binds: bound };
		return {
			bind(...args: unknown[]) {
				bound = args;
				last = { sql, binds: args };
				return this;
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

const plan = (): string => {
	if (!last) throw new Error("nothing captured");
	return (sqlite
		.prepare(`EXPLAIN QUERY PLAN ${last.sql}`)
		.all(...(last.binds as never[])) as { detail: string }[])
		.map((r) => r.detail)
		.join("\n");
};

let db: D1Database;
beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	db = makeD1(sqlite);
	last = null;
});

describe("0031 admin indexes", () => {
	it("queue by status seeks the status index, no sort", async () => {
		await adminListComments(db, { status: "pending" }, 51, null, null);
		expect(plan()).toContain("comments_status_created_idx (status=?)");
		expect(plan()).not.toContain("TEMP B-TREE FOR ORDER BY");
		await adminListComments(db, { status: "pending" }, 51, 1_700_000_000_000, "01J");
		expect(plan()).toContain("comments_status_created_idx (status=? AND (created_at,id)<(?,?))");
	});

	it("queue 'all' walks the created index, no sort", async () => {
		await adminListComments(db, { status: "all" }, 51, null, null);
		expect(plan()).toContain("comments_created_idx");
		expect(plan()).not.toContain("TEMP B-TREE FOR ORDER BY");
	});

	it("oldest pending and the 30-day timeline use the new indexes", async () => {
		await adminOldestPending(db);
		expect(plan()).toContain("COVERING INDEX comments_status_created_idx (status=?)");
		await adminTimeline(db, 30);
		expect(plan()).toContain("comments_created_idx (created_at>?)");
	});

	it("users and subscriptions lists page on (created_at, id)", async () => {
		await adminListUsers(db, null, 51, 1_700_000_000_000, "01J");
		expect(plan()).toContain("users_created_idx ((created_at,id)<(?,?))");
		await adminListSubscriptions(db, {}, 51, 1_700_000_000_000, "01J");
		expect(plan()).toContain("subscriptions_created_idx ((created_at,id)<(?,?))");
	});
});

describe("public reads the status index must not capture", () => {
	it("the feed query starts from the post, not every approved comment", async () => {
		await listLatestApprovedComments(db, "hello", 50);
		expect(plan()).toContain("comments_post_idx (post_slug=?)");
		expect(plan()).not.toContain("comments_status_created_idx");
	});

	it("the name-claim check starts from the name key", async () => {
		await isNameClaimed(db, "ann");
		expect(plan()).toContain("idx_users_name_key (name_key=?)");
		expect(plan()).not.toContain("comments_status_created_idx");
	});
});
