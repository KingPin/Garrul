/**
 * Migration 0022 — renaming the `like` reaction to `fire`.
 *
 * A vocabulary rename is the one kind of change that can silently delete reader
 * data: the widget renders only kinds it knows about, so a row left under the
 * old spelling still exists and is never seen again. That makes the interesting
 * assertions "the count survived" and "the row moved", not "the file parsed".
 *
 * Run against Node's built-in `node:sqlite` (no new dependency, no network) with
 * every earlier migration applied, the same way the real-DB query suite does —
 * a stub that routes by SQL substring would never execute the UPDATE at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const RENAME = "0022_reaction_kind_fire.sql";

const sqlFor = (file: string): string =>
	readFileSync(join(MIGRATIONS_DIR, file), "utf8");

/** Everything before the rename, so the rename itself can be run on demand. */
const dbBeforeRename = (): DatabaseSync => {
	const sqlite = new DatabaseSync(":memory:");
	const earlier = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && f < RENAME)
		.sort();
	for (const file of earlier) sqlite.exec(sqlFor(file));

	// reactions FKs comments(id) + users(id); page_reactions FKs posts(slug) +
	// users(id), and node:sqlite enforces both — seed the parents first.
	sqlite.exec(
		"INSERT INTO posts (slug, title, url, created_at) VALUES ('hello', 'Hello', NULL, 1700000000000)",
	);
	sqlite.exec(
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'u1', 1700000000000), ('u2', 'anon', 'x', 'u2', 1700000000000)",
	);
	sqlite.exec(
		"INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, created_at) VALUES ('c1', 'hello', NULL, 'u1', 'x', '<p>x</p>', 1700000000000)",
	);
	return sqlite;
};

const kinds = (sqlite: DatabaseSync, table: string): string[] =>
	(sqlite.prepare(`SELECT kind FROM ${table} ORDER BY kind`).all() as {
		kind: string;
	}[]).map((r) => r.kind);

describe("migration 0022 — like → fire", () => {
	it("renames comment reactions and keeps the count", () => {
		const sqlite = dbBeforeRename();
		sqlite.exec(
			"INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES ('c1', 'u1', 'like', 1), ('c1', 'u2', 'like', 2), ('c1', 'u1', 'love', 3)",
		);
		sqlite.exec(sqlFor(RENAME));
		expect(kinds(sqlite, "reactions")).toEqual(["fire", "fire", "love"]);
	});

	it("renames article reactions too", () => {
		// The article bar and the comment rows share one vocabulary, so rewriting
		// only `reactions` would leave the bar counting a kind nothing renders.
		const sqlite = dbBeforeRename();
		sqlite.exec(
			"INSERT INTO page_reactions (post_slug, user_id, kind, created_at) VALUES ('hello', 'u1', 'like', 1), ('hello', 'u2', 'hmm', 2)",
		);
		sqlite.exec(sqlFor(RENAME));
		expect(kinds(sqlite, "page_reactions")).toEqual(["fire", "hmm"]);
	});

	it("is a no-op on a second run", () => {
		// A migration that only works once fails a restored backup.
		const sqlite = dbBeforeRename();
		sqlite.exec(
			"INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES ('c1', 'u1', 'like', 1)",
		);
		sqlite.exec(sqlFor(RENAME));
		sqlite.exec(sqlFor(RENAME));
		expect(kinds(sqlite, "reactions")).toEqual(["fire"]);
	});

	it("survives a reader who holds both spellings", () => {
		// Impossible on a fresh install — `fire` did not exist before this release
		// — but reachable on a re-run against partially-migrated data. Plain UPDATE
		// would abort on the (comment_id, user_id, kind) primary key and take the
		// whole migration with it, so the rename is OR IGNORE.
		//
		// Not throwing is only half of it, and the half that hid the bug: OR IGNORE
		// *skips* the conflicting row instead of removing it, so the migration used
		// to leave the `like` row sitting in the table where no build renders it —
		// the exact orphan it exists to prevent. Hence the second assertion, and
		// the DELETE that makes it pass.
		const sqlite = dbBeforeRename();
		sqlite.exec(
			"INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES ('c1', 'u1', 'like', 1), ('c1', 'u1', 'fire', 2)",
		);
		expect(() => sqlite.exec(sqlFor(RENAME))).not.toThrow();
		expect(kinds(sqlite, "reactions")).toEqual(["fire"]);
	});

	it("keeps a reaction the reader holds only under the old spelling", () => {
		// The guard on the DELETE above: it may only drop rows the UPDATE refused
		// to move. A DELETE that ran unconditionally would silently discard every
		// `like` on a target with no `fire` counterpart — data loss dressed as a
		// rename, and invisible because the count simply comes back smaller.
		const sqlite = dbBeforeRename();
		sqlite.exec(
			"INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES ('c1', 'u1', 'like', 1), ('c1', 'u2', 'like', 2)",
		);
		sqlite.exec(sqlFor(RENAME));
		expect(kinds(sqlite, "reactions")).toEqual(["fire", "fire"]);
	});
});
