/**
 * nextPendingAfter and getUserByProvider against REAL SQLite (every migration
 * applied). The walk must order by (created_at, id), must step past a cursor
 * even after that comment was moderated, and must fall back to the oldest
 * pending comment when the cursor is unknown.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getUserByProvider, nextPendingAfter } from "../src/db/queries";
import { makeD1 } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return { sqlite, DB: makeD1(sqlite) };
};

const A = "01AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "01BBBBBBBBBBBBBBBBBBBBBBBB";
const C = "01CCCCCCCCCCCCCCCCCCCCCCCC";
const D = "01DDDDDDDDDDDDDDDDDDDDDDDD";

const seed = () => {
	const { sqlite, DB } = freshDb();
	sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)").run();
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES ('u1', 'github', '1', 'Author', 0, 'user', 1)`,
		)
		.run();
	const add = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, ip_hash, user_agent, created_at, depth)
		 VALUES (?, 'p', NULL, 'u1', 'x', '<p>x</p>', 1, ?, NULL, NULL, ?, 1)`,
	);
	// Ids are inserted out of order on purpose, so the walk cannot rely on insert order.
	add.run(C, "pending", 200);
	add.run(D, "approved", 150);
	add.run(B, "pending", 200);
	add.run(A, "pending", 100);
	return { sqlite, DB };
};

describe("nextPendingAfter", () => {
	it("walks pending comments oldest-first, ties broken by id", async () => {
		const { DB } = seed();
		expect((await nextPendingAfter(DB, null))?.id).toBe(A);
		expect((await nextPendingAfter(DB, A))?.id).toBe(B);
		expect((await nextPendingAfter(DB, B))?.id).toBe(C);
		expect(await nextPendingAfter(DB, C)).toBeNull();
	});

	it("keeps walking when the cursor comment was moderated mid-walk", async () => {
		const { sqlite, DB } = seed();
		sqlite.prepare("UPDATE comments SET status = 'approved' WHERE id = ?").run(A);
		expect((await nextPendingAfter(DB, A))?.id).toBe(B);
	});

	it("falls back to the oldest pending comment for an unknown cursor", async () => {
		const { DB } = seed();
		expect((await nextPendingAfter(DB, "01ZZZZZZZZZZZZZZZZZZZZZZZZ"))?.id).toBe(A);
	});

	it("returns the Comment shape with the getComment columns", async () => {
		const { DB } = seed();
		const row = await nextPendingAfter(DB, null);
		expect(row).toMatchObject({ id: A, post_slug: "p", status: "pending", created_at: 100, depth: 1 });
		expect(row).toHaveProperty("score_up");
		expect(row).toHaveProperty("as_staff");
	});

	it("returns null on an empty queue", async () => {
		const { DB } = freshDb();
		expect(await nextPendingAfter(DB, null)).toBeNull();
	});
});

describe("getUserByProvider", () => {
	it("returns the user for a provider id, or null", async () => {
		const { sqlite, DB } = freshDb();
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
				 VALUES (?, 'discord', '111111111111111111', 'Disc', 0, 'user', 1)`,
			)
			.run(A);
		const user = await getUserByProvider(DB, "discord", "111111111111111111");
		expect(user).toMatchObject({ id: A, provider: "discord", provider_id: "111111111111111111", name: "Disc" });
		expect(await getUserByProvider(DB, "discord", "999")).toBeNull();
		expect(await getUserByProvider(DB, "github", "111111111111111111")).toBeNull();
	});
});
