import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { COMMENT_CHILD_TABLES, wipeCommentsSql } from "../scripts/seed-demo";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const migrated = (): DatabaseSync => {
	const db = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	return db;
};

const count = (db: DatabaseSync, sql: string): number =>
	(db.prepare(sql).get() as { n: number }).n;

describe("seed-demo comment wipe", () => {
	it("lists every table with a non-cascading FK to comments", () => {
		// A new migration adding such a table must join the list, or re-seeding a
		// demo thread that has rows in it fails with SQLITE_CONSTRAINT_FOREIGNKEY.
		const db = migrated();
		const tables = (
			db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((r) => r.name);
		const plain = tables.filter(
			(t) =>
				t !== "comments" &&
				(
					db.prepare(`PRAGMA foreign_key_list(${t})`).all() as {
						table: string;
						on_delete: string;
					}[]
				).some((fk) => fk.table === "comments" && fk.on_delete !== "CASCADE"),
		);
		expect([...COMMENT_CHILD_TABLES].sort()).toEqual(plain.sort());
	});

	it("clears a thread with dependent rows, twice, and spares other posts", () => {
		const db = migrated();
		expect(count(db, "SELECT foreign_keys AS n FROM pragma_foreign_keys")).toBe(1);
		const now = Date.now();
		db.exec(`
			INSERT INTO posts (slug, created_at) VALUES ('welcome', ${now}), ('other', ${now});
			INSERT INTO users (id, provider, name, created_at) VALUES ('u1', 'anon', 'A', ${now});
			INSERT INTO comments (id, post_slug, user_id, body_md, body_html, created_at)
				VALUES ('c1', 'welcome', 'u1', 'x', 'x', ${now}),
				       ('o1', 'other', 'u1', 'x', 'x', ${now});
			INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, created_at, depth)
				VALUES ('c2', 'welcome', 'c1', 'u1', 'x', 'x', ${now}, 2);
			INSERT INTO subscriptions (id, post_slug, email, token, created_at)
				VALUES ('s1', 'welcome', 'a@example.com', 't', ${now});
			INSERT INTO votes (comment_id, user_id, value, created_at) VALUES ('c2', 'u1', 1, ${now});
			INSERT INTO reactions (comment_id, user_id, kind, created_at)
				VALUES ('c1', 'u1', 'love', ${now}), ('o1', 'u1', 'love', ${now});
			INSERT INTO reports (id, comment_id, created_at) VALUES ('r1', 'c2', ${now});
			INSERT INTO notifications (id, subscription_id, comment_id, created_at)
				VALUES ('n1', 's1', 'c1', ${now});
			INSERT INTO moderator_notifications (id, comment_id, reason, created_at)
				VALUES ('m1', 'c1', 'pending', ${now});
			INSERT INTO spam_verdicts (comment_id, source, verdict, created_at)
				VALUES ('c1', 'heuristics', 'spam', ${now});
		`);

		db.exec(wipeCommentsSql("welcome"));
		db.exec(wipeCommentsSql("welcome"));

		expect(count(db, "SELECT count(*) AS n FROM comments WHERE post_slug = 'welcome'")).toBe(0);
		for (const t of [...COMMENT_CHILD_TABLES, "spam_verdicts"]) {
			expect(count(db, `SELECT count(*) AS n FROM ${t} WHERE comment_id IN ('c1', 'c2')`)).toBe(0);
		}
		expect(count(db, "SELECT count(*) AS n FROM comments WHERE id = 'o1'")).toBe(1);
		expect(count(db, "SELECT count(*) AS n FROM reactions WHERE comment_id = 'o1'")).toBe(1);
	});
});
