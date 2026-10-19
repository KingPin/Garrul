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
	listThreadRefsForPost,
	getThreadCreatedAt,
	softDeleteComment,
	updateCommentStatus,
} from "../src/db/queries";
import { sweepExpiredIpHashes } from "../src/db/ip-retention";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

/** Every prepare+bind the code under test issued, oldest first. */
const captured: { sql: string; binds: unknown[] }[] = [];

// Minimal D1Database adapter over node:sqlite. Covers the surface the comment
// write/read queries use: prepare().bind().run()/first()/all(). Records each
// bound statement so a test can EXPLAIN the exact SQL + parameters the code
// ran, rather than a hand-typed copy of it.
const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				captured.push({ sql, binds: args });
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

/** EXPLAIN QUERY PLAN for the last captured statement, one detail per line. */
const lastPlan = (sqlite: DatabaseSync): string => {
	const last = captured[captured.length - 1];
	if (!last) throw new Error("nothing captured");
	return (sqlite
		.prepare(`EXPLAIN QUERY PLAN ${last.sql}`)
		.all(...(last.binds as never[])) as { detail: string }[])
		.map((r) => r.detail)
		.join("\n");
};

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
 * Thread paging runs on a keyset cursor, and each sort keys on a different
 * column in a different direction. The substring-matching D1 stubs never
 * execute an ORDER BY or a cursor predicate, so a sort whose ordering and
 * whose cursor direction disagree would pass every stub test while skipping or
 * repeating threads in production — the one failure mode that matters here.
 * Real SQLite is the only place that can be proven.
 */
describe("listThreadRefsForPost paging (real SQLite)", () => {
	let db: any;
	let sqlite: DatabaseSync;

	// Ids and created_at are independent. Live writes mint time-prefixed ULIDs
	// so the two usually agree, but imports keep the source's historical
	// created_at under a fresh ULID, so id order says nothing about time order
	// there. Chronological paging therefore cursors on (created_at, id), and the
	// tests below seed both aligned and deliberately misaligned rows.
	const threadId = (i: number) => `01J${String(i).padStart(23, "0")}`;

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		applyMigrations(sqlite, migrationFiles());
		db = makeD1(sqlite);
		sqlite.exec(
			"INSERT INTO posts (slug, title, url, created_at) VALUES ('hello', 'Hello', NULL, 1700000000000)",
		);
		sqlite.exec(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'u1', 1700000000000)",
		);
	});

	const seedThread = (
		i: number,
		opts: {
			status?: string;
			score?: number;
			parent_id?: string | null;
			created_at?: number;
		} = {},
	) => {
		sqlite
			.prepare(
				`INSERT INTO comments
				   (id, post_slug, parent_id, user_id, body_md, body_html, status,
				    score_up, score_down, depth, created_at)
				 VALUES (?, 'hello', ?, 'u1', 'x', '<p>x</p>', ?, ?, 0, ?, ?)`,
			)
			.run(
				threadId(i),
				opts.parent_id ?? null,
				opts.status ?? "approved",
				opts.score ?? 0,
				opts.parent_id ? 2 : 1,
				opts.created_at ?? 1_700_000_000_000 + i,
			);
	};

	/**
	 * Walk every page the way the route does: fetch pageSize + 1, keep pageSize,
	 * and cursor from the last row actually kept.
	 */
	const walk = async (sort: "new" | "top" | "old", pageSize: number) => {
		const seen: string[] = [];
		let cursor: { score?: number; created_at?: number; id: string } | null = null;
		for (let guard = 0; guard < 20; guard++) {
			const refs = await listThreadRefsForPost(db, "hello", {
				sort,
				limit: pageSize + 1,
				cursor,
			});
			const page = refs.slice(0, pageSize);
			seen.push(...page.map((r) => r.id));
			const last = page[page.length - 1];
			if (refs.length <= pageSize || !last) break;
			cursor =
				sort === "top"
					? { score: last.score, id: last.id }
					: { created_at: last.created_at, id: last.id };
		}
		return seen;
	};

	it("pages 'old' oldest-first without skipping or repeating a thread", async () => {
		for (let i = 1; i <= 7; i++) seedThread(i);
		const seen = await walk("old", 3);
		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7].map(threadId));
		expect(new Set(seen).size).toBe(7);
	});

	it("pages 'new' newest-first without skipping or repeating a thread", async () => {
		for (let i = 1; i <= 7; i++) seedThread(i);
		const seen = await walk("new", 3);
		expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1].map(threadId));
		expect(new Set(seen).size).toBe(7);
	});

	it("pages 'new' by created_at when ids disagree with timestamps (imported rows)", async () => {
		// Fresh ULIDs ascend 1..6 but the timestamps are shuffled, the shape an
		// import produces. Expected order is by created_at DESC, not id DESC.
		const stamps = [5, 1, 6, 2, 4, 3];
		for (const [idx, t] of stamps.entries()) {
			seedThread(idx + 1, { created_at: 1_700_000_000_000 + t });
		}
		const seen = await walk("new", 2);
		// created_at 6,5,4,3,2,1 → ids 3,1,5,6,4,2
		expect(seen).toEqual([3, 1, 5, 6, 4, 2].map(threadId));
	});

	it("pages 'old' by created_at when ids disagree with timestamps", async () => {
		const stamps = [5, 1, 6, 2, 4, 3];
		for (const [idx, t] of stamps.entries()) {
			seedThread(idx + 1, { created_at: 1_700_000_000_000 + t });
		}
		const seen = await walk("old", 2);
		// created_at 1,2,3,4,5,6 → ids 2,4,6,5,1,3
		expect(seen).toEqual([2, 4, 6, 5, 1, 3].map(threadId));
	});

	it("breaks created_at ties on id without skipping or repeating", async () => {
		for (let i = 1; i <= 6; i++) seedThread(i, { created_at: 1_700_000_000_000 });
		expect(await walk("new", 2)).toEqual([6, 5, 4, 3, 2, 1].map(threadId));
		expect(await walk("old", 4)).toEqual([1, 2, 3, 4, 5, 6].map(threadId));
	});

	it("returns created_at on every ref", async () => {
		seedThread(1, { created_at: 1_700_000_000_123 });
		const refs = await listThreadRefsForPost(db, "hello", { sort: "new", limit: 5 });
		expect(refs).toEqual([{ id: threadId(1), score: 0, created_at: 1_700_000_000_123 }]);
	});

	it("getThreadCreatedAt resolves a top-level thread on the slug and nothing else", async () => {
		seedThread(1, { created_at: 1_700_000_000_001 });
		seedThread(2, { parent_id: threadId(1), created_at: 1_700_000_000_002 });
		expect(await getThreadCreatedAt(db, "hello", threadId(1))).toBe(1_700_000_000_001);
		expect(await getThreadCreatedAt(db, "hello", threadId(2))).toBeNull(); // a reply
		expect(await getThreadCreatedAt(db, "other", threadId(1))).toBeNull(); // wrong slug
		expect(await getThreadCreatedAt(db, "hello", threadId(9))).toBeNull(); // missing
	});

	it("'old' excludes replies, spam and pending just as 'new' does", async () => {
		seedThread(1);
		seedThread(2, { status: "spam" });
		seedThread(3, { status: "pending" });
		seedThread(4);
		seedThread(5, { parent_id: threadId(1) });
		const seen = await walk("old", 10);
		expect(seen).toEqual([threadId(1), threadId(4)]);
	});

	it("pages 'old' through negative (pre-1970) created_at without skipping or repeating", async () => {
		// Imports can carry a pre-1970 source created_at. Paging one row at a
		// time forces every intermediate cursor to round-trip a negative value.
		seedThread(1, { created_at: -7200000 });
		seedThread(2, { created_at: -3600000 });
		seedThread(3, { created_at: 0 });
		const seen = await walk("old", 1);
		expect(seen).toEqual([threadId(1), threadId(2), threadId(3)]);
		expect(new Set(seen).size).toBe(3);
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

describe("migration 0030 indexes (real SQLite)", () => {
	const indexNames = (sqlite: DatabaseSync): string[] =>
		(sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
			.all() as { name: string }[]).map((r) => r.name);

	it("adds the root, score and retention indexes and drops comments_score_idx", () => {
		const sqlite = new DatabaseSync(":memory:");
		applyMigrations(sqlite, migrationFiles());
		const names = indexNames(sqlite);
		expect(names).toContain("comments_root_chrono_idx");
		expect(names).toContain("comments_root_score_idx");
		expect(names).toContain("comments_ip_retention_idx");
		expect(names).toContain("reports_ip_retention_idx");
		expect(names).not.toContain("comments_score_idx");
	});

	it("is idempotent", () => {
		const sqlite = new DatabaseSync(":memory:");
		const files = migrationFiles();
		applyMigrations(sqlite, files);
		const target = files.find((f) => f.startsWith("0030_")) as string;
		expect(target).toBeDefined();
		expect(() => applyMigrations(sqlite, [target])).not.toThrow();
	});
});

describe("listThreadRefsForPost seeks on the 0030 indexes (real SQLite)", () => {
	const SLUG = "seek";
	let sqlite: DatabaseSync;
	let db: D1Database;

	// 200 roots over 5 shared timestamps and 5 shared scores. Ids are NOT in
	// time order (imports do this), so a bare-id cursor would misorder them.
	const seed = (): void => {
		sqlite.prepare("INSERT INTO posts (slug, created_at) VALUES (?, 1)").run(SLUG);
		sqlite
			.prepare("INSERT INTO users (id, provider, name, created_at) VALUES ('u1', 'anon', 'A', 1)")
			.run();
		const ins = sqlite.prepare(
			`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, status, created_at, score_up)
			 VALUES (?, ?, 'u1', 'b', '<p>b</p>', 'approved', ?, ?)`,
		);
		for (let i = 0; i < 200; i++) {
			const id = `R${String((i * 37) % 200).padStart(3, "0")}`;
			ins.run(id, SLUG, 1_000 + (i % 5), i % 5);
		}
	};

	const pageAll = async (
		sort: "new" | "old" | "top",
		viewer_id: string | null,
	): Promise<string[]> => {
		const seen: string[] = [];
		let cursor: { score?: number; created_at?: number; id: string } | null = null;
		for (let guard = 0; guard < 20; guard++) {
			const page = await listThreadRefsForPost(db, SLUG, {
				sort,
				limit: 26,
				cursor,
				viewer_id,
			});
			if (page.length === 0) break;
			for (const r of page) seen.push(r.id);
			const last = page[page.length - 1] as { id: string; score: number; created_at: number };
			cursor =
				sort === "top"
					? { score: last.score, id: last.id }
					: { created_at: last.created_at, id: last.id };
		}
		return seen;
	};

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		applyMigrations(sqlite, migrationFiles());
		captured.length = 0;
		db = makeD1(sqlite);
		seed();
	});

	for (const viewer of [null, "u1"] as const) {
		const who = viewer ? "authenticated" : "anonymous";

		it(`pages 'new' and 'old' through tied timestamps with no skip or repeat (${who})`, async () => {
			for (const sort of ["new", "old"] as const) {
				const ids = await pageAll(sort, viewer);
				expect(ids).toHaveLength(200);
				expect(new Set(ids).size).toBe(200);
				const reference = (
					await listThreadRefsForPost(db, SLUG, { sort, limit: 1000, viewer_id: viewer })
				).map((r) => r.id);
				expect(ids).toEqual(reference);
			}
		});

		it(`pages 'top' through tied scores with no skip or repeat (${who})`, async () => {
			const ids = await pageAll("top", viewer);
			expect(ids).toHaveLength(200);
			expect(new Set(ids).size).toBe(200);
			const reference = (
				await listThreadRefsForPost(db, SLUG, { sort: "top", limit: 1000, viewer_id: viewer })
			).map((r) => r.id);
			expect(ids).toEqual(reference);
		});

		it(`the cursorless first page seeks and never temp-sorts (${who})`, async () => {
			for (const sort of ["new", "old", "top"] as const) {
				await listThreadRefsForPost(db, SLUG, { sort, limit: 26, viewer_id: viewer });
				const plan = lastPlan(sqlite);
				const idx = sort === "top" ? "comments_root_score_idx" : "comments_root_chrono_idx";
				expect(plan).toContain(`USING INDEX ${idx} (post_slug=?)`);
				expect(plan).not.toContain("TEMP B-TREE");
			}
		});

		it(`seeks the chrono index for 'new' and 'old' (${who})`, async () => {
			await listThreadRefsForPost(db, SLUG, {
				sort: "new", limit: 26, viewer_id: viewer,
				cursor: { created_at: 1_002, id: "R100" },
			});
			let plan = lastPlan(sqlite);
			expect(plan).toContain("USING INDEX comments_root_chrono_idx (post_slug=? AND (created_at,id)<(?,?))");
			expect(plan).not.toContain("TEMP B-TREE");

			await listThreadRefsForPost(db, SLUG, {
				sort: "old", limit: 26, viewer_id: viewer,
				cursor: { created_at: 1_002, id: "R100" },
			});
			plan = lastPlan(sqlite);
			expect(plan).toContain("USING INDEX comments_root_chrono_idx (post_slug=? AND (created_at,id)>(?,?))");
			expect(plan).not.toContain("TEMP B-TREE");
		});

		it(`seeks the score index for 'top', not just names it (${who})`, async () => {
			await listThreadRefsForPost(db, SLUG, {
				sort: "top", limit: 26, viewer_id: viewer,
				cursor: { score: 2, id: "R100" },
			});
			const plan = lastPlan(sqlite);
			// The `<expr><?` fragment is the seek. A bare tuple predicate also
			// names this index but plans as `(post_slug=?)` — a full scan.
			expect(plan).toContain("USING INDEX comments_root_score_idx (post_slug=? AND <expr><?)");
			expect(plan).not.toContain("TEMP B-TREE");
		});
	}

	it("never returns the approved pinned root on any page of any sort", async () => {
		sqlite.prepare("UPDATE comments SET pinned_at = 5 WHERE id = 'R007'").run();
		for (const sort of ["new", "old", "top"] as const) {
			const ids = await pageAll(sort, null);
			expect(ids).toHaveLength(199);
			expect(ids).not.toContain("R007");
			const reference = (
				await listThreadRefsForPost(db, SLUG, { sort, limit: 1000, viewer_id: null })
			).map((r) => r.id);
			expect(ids).toEqual(reference);
		}
	});
});

describe("IP-retention sweep uses the 0030 partial indexes (real SQLite)", () => {
	it("seeks both subqueries instead of scanning", async () => {
		const sqlite = new DatabaseSync(":memory:");
		applyMigrations(sqlite, migrationFiles());
		captured.length = 0;
		const db = makeD1(sqlite);
		await sweepExpiredIpHashes(db, 30, 1_700_000_000_000);
		expect(captured).toHaveLength(2);
		const plan = (i: number): string =>
			(sqlite
				.prepare(`EXPLAIN QUERY PLAN ${captured[i]!.sql}`)
				.all(...(captured[i]!.binds as never[])) as { detail: string }[])
				.map((r) => r.detail)
				.join("\n");
		expect(plan(0)).toContain("USING INDEX comments_ip_retention_idx (<expr><?)");
		expect(plan(1)).toContain("USING INDEX reports_ip_retention_idx (created_at<?)");
	});
});
