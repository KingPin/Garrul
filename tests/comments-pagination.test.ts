/**
 * GET /api/v1/comments pagination tests.
 *
 * Covers:
 *
 *   1. `comments_per_page` (DB > env > default 25) drives the top-level slice —
 *      the default, an env override, a DB-row override, and the hostile-value
 *      clamp.
 *   2. `sort=new` walks pages via the ULID `before` cursor (id < cursor), and
 *      `sort=old` walks the same cursor the other way (id > cursor) — the pair
 *      has to flip order and cursor direction together or it skips threads.
 *   3. `sort=top` paginates too (composite score:id cursor), so a small page
 *      size can't hide top-voted threads past the first page.
 *   4. The first-page edge-cache key varies with the page size, so a size
 *      change can't serve a stale-sized slice.
 *   5. Pagination happens IN SQL: the thread-refs query carries a LIMIT and the
 *      subtree query only touches the page's threads. This suite used to run
 *      against a D1 double that routed by SQL substring and returned every
 *      seeded row regardless of LIMIT, cursor or ORDER BY — which is exactly
 *      why an unbounded read path passed its own pagination tests.
 *   6. Cursor pages ARE cached (they used to be a guaranteed cache bypass on an
 *      unbounded query), under a cursor-stamped key — but an *empty* cursor page
 *      is not, so a random-ULID loop can't mint unlimited cache entries.
 *
 * Runs against REAL SQLite (all migrations applied) so LIMIT, the cursor
 * predicates and the recursive-CTE subtree fetch are genuinely exercised, plus
 * a mock `caches.default` for the first-page edge cache. Every `.all()` is
 * recorded so the tests can assert what SQL actually asked for.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import {
	getUserVotesOnComments,
	listReactionsForComments,
	listUserReactionsOnComments,
} from "../src/db/queries";
import { treeCacheKey } from "../src/lib/tree-cache";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

// Hono's app.request("/...") serves on http://localhost, so the route builds
// its cache key on that origin; assertions must use the same origin.
const REQ_URL = "http://localhost/";

const SLUG = "hello";
const USER = "01HU000000000000000000";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Deterministic, order-preserving 26-char ULID-shaped id: higher n sorts
// lexicographically higher (and matches the handler's ULID_RE). Left-padded
// with '0' (the lowest alphabet char) so ordering by id === ordering by n.
const mkUlid = (n: number): string => {
	let s = "";
	let v = n;
	if (v === 0) s = "0";
	while (v > 0) {
		s = CROCKFORD[v % 32] + s;
		v = Math.floor(v / 32);
	}
	return s.padStart(26, "0");
};

/** Every `.all()` the handler issued, with its binds and the row count back. */
type Recorded = { sql: string; binds: unknown[]; rows: number };
let queries: Recorded[];

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
				const results = stmt.all(...(bound as never[]));
				queries.push({ sql, binds: bound, rows: results.length });
				return { results };
			},
		};
	},
	// D1's real `batch` issues every statement over one round trip; this stub
	// only needs to preserve per-statement recording so the pagination/batching
	// assertions above still see one `queries` entry per chunk.
	async batch(stmts: { all: () => Promise<{ results: unknown[] }> }[]) {
		return Promise.all(stmts.map((s) => s.all()));
	},
});

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

let mockCache: MockCache;
let sqlite: DatabaseSync;

beforeEach(() => {
	mockCache = installMockCaches();
	queries = [];
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(USER, "anon", null, "anon", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Hello", null, 1);
});
afterEach(() => uninstallMockCaches());

const INSERT_COMMENT = `INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
	                       renderer_version, status, created_at, depth, score_up, score_down)
	 VALUES (?, ?, ?, ?, ?, ?, 1, 'approved', ?, ?, ?, 0)`;

/**
 * `n` top-level threads, oldest first (created_at and id both ascending with
 * index). `scores[i]` sets net up-votes for the top-sort tests; unset → 0.
 */
const seedThreads = (n: number, scores: number[] = []) => {
	const stmt = sqlite.prepare(INSERT_COMMENT);
	for (let i = 0; i < n; i++) {
		stmt.run(
			mkUlid(i + 1),
			SLUG,
			null,
			USER,
			`c${i}`,
			`<p>c${i}</p>`,
			1000 + i,
			1,
			scores[i] ?? 0,
		);
	}
};

/** One top-level thread with an explicit id index and created_at. */
const seedThreadAt = (idIndex: number, createdAt: number) => {
	sqlite
		.prepare(INSERT_COMMENT)
		.run(mkUlid(idIndex), SLUG, null, USER, `c${idIndex}`, `<p>c${idIndex}</p>`, createdAt, 1, 0);
};

/** `perThread` replies under each of the first `threadCount` threads. */
const seedReplies = (threadCount: number, perThread: number) => {
	const stmt = sqlite.prepare(INSERT_COMMENT);
	let n = 100_000;
	for (let t = 0; t < threadCount; t++) {
		for (let r = 0; r < perThread; r++) {
			stmt.run(
				mkUlid(n++),
				SLUG,
				mkUlid(t + 1),
				USER,
				"r",
				"<p>r</p>",
				2000 + n,
				2,
				0,
			);
		}
	}
};

const seedReaction = (commentId: string, userId: string, kind = "heart") => {
	sqlite
		.prepare("INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES (?, ?, ?, 1)")
		.run(commentId, userId, kind);
};

const setSetting = (key: string, value: string) => {
	sqlite
		.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
		.run(key, value, 1);
};

const mkEnv = (envVars: Record<string, string> = {}) =>
	({
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: { get: async () => null },
		...envVars,
	}) as unknown as Bindings;

type ListResp = {
	threads: {
		id: string;
		score_up: number;
		score_down: number;
		reactions: { kind: string; count: number; mine: boolean }[];
		my_vote: -1 | 0 | 1;
		replies: unknown[];
	}[];
	next_cursor: string | null;
	sort: string;
};

const get = async (env: Bindings, query: string): Promise<ListResp> => {
	const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
	const res = await app.request(
		`/?${query}`,
		{},
		env as unknown as Record<string, unknown>,
	);
	expect(res.status).toBe(200);
	return (await res.json()) as ListResp;
};

/** The thread-refs query: top-level ids only, in the sort's own order. */
const refsQuery = () =>
	queries.find((q) => q.sql.includes("parent_id IS NULL") && q.sql.includes("LIMIT"));

/** The recursive-CTE subtree fetch for the page's threads. */
const subtreeQuery = () => queries.find((q) => q.sql.includes("WITH RECURSIVE thread"));

describe("GET /comments — default page size", () => {
	it("returns 25 threads + a cursor when there are more", async () => {
		seedThreads(30);
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.threads).toHaveLength(25);
		expect(page.next_cursor).not.toBeNull();
	});

	it("returns everything with a null cursor when under the page size", async () => {
		seedThreads(5);
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.threads).toHaveLength(5);
		expect(page.next_cursor).toBeNull();
	});
});

describe("GET /comments — configurable page size", () => {
	it("honors a DB-row comments_per_page override", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.threads).toHaveLength(10);
		expect(page.next_cursor).not.toBeNull();
	});

	it("honors a COMMENTS_PER_PAGE env override", async () => {
		seedThreads(30);
		const page = await get(mkEnv({ COMMENTS_PER_PAGE: "5" }), `slug=${SLUG}`);
		expect(page.threads).toHaveLength(5);
	});

	it("clamps a hostile DB value so the slice can't explode", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "1000000");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		// Clamp max is 200; only 30 rows exist, so all 30 come back, no cursor.
		expect(page.threads).toHaveLength(30);
		expect(page.next_cursor).toBeNull();
		// And the clamp reaches SQL, not just the response shape.
		expect(refsQuery()!.binds.at(-1)).toBe(201);
	});
});

describe("GET /comments — pagination is pushed into SQL", () => {
	it("asks SQL for one page of threads, not every thread on the slug", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		await get(mkEnv(), `slug=${SLUG}`);

		const refs = refsQuery()!;
		// pageSize + 1: the extra row only answers "is there another page?".
		expect(refs.binds.at(-1)).toBe(11);
		expect(refs.rows).toBe(11);
	});

	it("fetches only the page's subtrees, not the whole slug", async () => {
		// 30 threads × 2 replies = 90 comments on the slug.
		seedThreads(30);
		seedReplies(30, 2);
		setSetting("comments_per_page", "10");
		const page = await get(mkEnv(), `slug=${SLUG}`);

		expect(page.threads).toHaveLength(10);
		// 10 threads + their 20 replies. The pre-fix read path returned all 90.
		expect(subtreeQuery()!.rows).toBe(30);
		expect(page.threads.every((t) => t.replies.length === 2)).toBe(true);
	});

	it("never selects body_md, ip_hash or user_agent", async () => {
		seedThreads(3);
		await get(mkEnv(), `slug=${SLUG}`);
		const sql = subtreeQuery()!.sql;
		expect(sql).not.toMatch(/body_md/);
		expect(sql).not.toMatch(/ip_hash/);
		expect(sql).not.toMatch(/user_agent/);
	});
});

describe("GET /comments — sort=new cursor walks pages", () => {
	it("second page returns the remainder and a null cursor", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}`);
		expect(first.threads).toHaveLength(10);
		// new-sort is newest-first: page 1 starts at the highest id (c29).
		expect(first.threads[0]!.id).toBe(mkUlid(30));

		const second = await get(env, `slug=${SLUG}&before=${first.next_cursor}`);
		expect(second.threads).toHaveLength(10);
		const third = await get(env, `slug=${SLUG}&before=${second.next_cursor}`);
		expect(third.threads).toHaveLength(10);
		expect(third.next_cursor).toBeNull();

		// No overlap across pages, and they descend.
		const ids = [...first.threads, ...second.threads, ...third.threads].map(
			(t) => t.id,
		);
		expect(new Set(ids).size).toBe(30);
		expect(ids[0]).toBe(mkUlid(30));
		expect(ids[29]).toBe(mkUlid(1));
	});

	it("treats a malformed cursor as the first page", async () => {
		seedThreads(5);
		const page = await get(mkEnv(), `slug=${SLUG}&before=not-a-ulid`);
		expect(page.threads).toHaveLength(5);
		expect(page.threads[0]!.id).toBe(mkUlid(5));
	});
});

describe("GET /comments — sort=old cursor walks pages", () => {
	it("walks oldest-first and terminates, with no thread skipped or repeated", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=old`);
		expect(first.threads).toHaveLength(10);
		// old-sort is oldest-first: the mirror image of sort=new, so page 1
		// starts at the lowest id rather than the highest.
		expect(first.threads[0]!.id).toBe(mkUlid(1));

		const second = await get(env, `slug=${SLUG}&sort=old&before=${first.next_cursor}`);
		const third = await get(env, `slug=${SLUG}&sort=old&before=${second.next_cursor}`);
		expect(second.threads).toHaveLength(10);
		expect(third.threads).toHaveLength(10);
		expect(third.next_cursor).toBeNull();

		// The property that a half-flipped sort (ASC order, DESC cursor) breaks:
		// every thread appears exactly once, ascending.
		const ids = [...first.threads, ...second.threads, ...third.threads].map(
			(t) => t.id,
		);
		expect(new Set(ids).size).toBe(30);
		expect(ids[0]).toBe(mkUlid(1));
		expect(ids[29]).toBe(mkUlid(30));
	});

	it("treats a malformed cursor as the first page", async () => {
		seedThreads(5);
		const page = await get(mkEnv(), `slug=${SLUG}&sort=old&before=not-a-ulid`);
		expect(page.threads).toHaveLength(5);
		expect(page.threads[0]!.id).toBe(mkUlid(1));
	});

	it("keys its own cache entry, so it cannot serve sort=new's page", async () => {
		seedThreads(5);
		const env = mkEnv();
		const newest = await get(env, `slug=${SLUG}&sort=new`);
		const oldest = await get(env, `slug=${SLUG}&sort=old`);
		expect(newest.threads[0]!.id).toBe(mkUlid(5));
		expect(oldest.threads[0]!.id).toBe(mkUlid(1));
	});

	// An unknown sort resolves the same way an absent one does — to the
	// operator's default, not to a hardcoded `new`. `default_sort` is set to
	// `old` here on purpose: without it this test passes under either rule,
	// which is how it went on asserting a `new` fallback the route had stopped
	// making.
	it("treats an unknown sort as unspecified, so the operator's default wins", async () => {
		seedThreads(5);
		setSetting("default_sort", "old");
		const page = await get(mkEnv(), `slug=${SLUG}&sort=sideways`);
		expect(page.threads[0]!.id).toBe(mkUlid(1));
		expect(page.sort).toBe("old");
	});
});

/**
 * An absent `?sort=` means "whatever the operator configured", not a hardcoded
 * `new`. The widget depends on this: on the bootstrap path it cannot know the
 * setting before the response carrying it arrives, so the server has to apply
 * the default and echo back what it used.
 */
describe("GET /comments — default_sort", () => {
	it("serves the operator's default when the request names no sort", async () => {
		seedThreads(5);
		setSetting("default_sort", "old");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.threads[0]!.id).toBe(mkUlid(1));
		expect(page.sort).toBe("old");
	});

	it("reads the default from the env var when no DB row overrides it", async () => {
		seedThreads(5);
		const page = await get(mkEnv({ DEFAULT_SORT: "old" }), `slug=${SLUG}`);
		expect(page.threads[0]!.id).toBe(mkUlid(1));
	});

	it("lets an explicit ?sort= win over the operator default", async () => {
		seedThreads(5);
		setSetting("default_sort", "old");
		const page = await get(mkEnv(), `slug=${SLUG}&sort=new`);
		expect(page.threads[0]!.id).toBe(mkUlid(5));
		expect(page.sort).toBe("new");
	});

	it("stays on 'new' for an install that never set it", async () => {
		seedThreads(5);
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.sort).toBe("new");
		expect(page.threads[0]!.id).toBe(mkUlid(5));
	});

	it("falls back to 'new' when the default is 'top' but voting is off", async () => {
		// Scores descend with index, so a real `top` page would start at c1 —
		// which is what makes this assertion able to tell the two apart.
		seedThreads(5, [9, 7, 5, 3, 1]);
		setSetting("default_sort", "top");
		setSetting("votes_enabled", "false");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.sort).toBe("new");
		expect(page.threads[0]!.id).toBe(mkUlid(5));
	});

	it("honors a 'top' default once voting is on, so the setting was kept not rewritten", async () => {
		seedThreads(5, [9, 7, 5, 3, 1]);
		setSetting("default_sort", "top");
		setSetting("votes_enabled", "true");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.sort).toBe("top");
		expect(page.threads[0]!.id).toBe(mkUlid(1));
	});

	it("does not coerce an explicit ?sort=top when voting is off", async () => {
		seedThreads(5, [9, 7, 5, 3, 1]);
		setSetting("votes_enabled", "false");
		const page = await get(mkEnv(), `slug=${SLUG}&sort=top`);
		expect(page.sort).toBe("top");
		expect(page.threads[0]!.id).toBe(mkUlid(1));
	});

	it("ignores an unknown stored default rather than serving nothing", async () => {
		seedThreads(5);
		setSetting("default_sort", "chronological");
		const page = await get(mkEnv(), `slug=${SLUG}`);
		expect(page.sort).toBe("new");
	});
});

describe("GET /comments — sort=top paginates (no hidden threads)", () => {
	it("returns a page-sized slice ordered by score, with a cursor", async () => {
		// 10 comments, ascending score 0..9 by index. Top sort should surface
		// the 2 highest-scoring (c9=9, c8=8) on the first page of size 2.
		seedThreads(
			10,
			Array.from({ length: 10 }, (_, i) => i),
		);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=top`);
		expect(first.threads).toHaveLength(2);
		expect(first.threads.map((t) => t.score_up)).toEqual([9, 8]);
		expect(first.next_cursor).toBe(`8:${mkUlid(9)}`);

		// Walking the composite score:id cursor reaches the lower-scored
		// threads that a single unpaginated page of size 2 would have hidden.
		const second = await get(env, `slug=${SLUG}&sort=top&before=${first.next_cursor}`);
		expect(second.threads.map((t) => t.score_up)).toEqual([7, 6]);
	});

	it("walks every thread across pages with no overlap", async () => {
		seedThreads(
			10,
			Array.from({ length: 10 }, (_, i) => i),
		);
		setSetting("comments_per_page", "3");
		const env = mkEnv();
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 10; i++) {
			const q = cursor
				? `slug=${SLUG}&sort=top&before=${cursor}`
				: `slug=${SLUG}&sort=top`;
			const page: ListResp = await get(env, q);
			seen.push(...page.threads.map((t) => t.id));
			cursor = page.next_cursor;
			if (!cursor) break;
		}
		expect(new Set(seen).size).toBe(10);
	});

	it("breaks score ties on id so a tied page can't repeat a thread", async () => {
		// All ties: without the id tie-break the cursor would re-select rows it
		// already returned and the walk would never terminate.
		seedThreads(6, Array.from({ length: 6 }, () => 4));
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 5; i++) {
			const q = cursor
				? `slug=${SLUG}&sort=top&before=${cursor}`
				: `slug=${SLUG}&sort=top`;
			const page: ListResp = await get(env, q);
			seen.push(...page.threads.map((t) => t.id));
			cursor = page.next_cursor;
			if (!cursor) break;
		}
		expect(seen).toHaveLength(6);
		expect(new Set(seen).size).toBe(6);
	});
});

describe("GET /comments — cache key varies with page size", () => {
	it("caches the first page under a size-stamped edge-cache key", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		await get(mkEnv(), `slug=${SLUG}`);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 10).url)).toBe(true);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 25).url)).toBe(false);
	});

	it("a different size resolves to a different cache slot", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		await get(mkEnv(), `slug=${SLUG}`);

		sqlite.prepare("DELETE FROM settings WHERE key = 'comments_per_page'").run();
		await get(mkEnv(), `slug=${SLUG}`);

		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 10).url)).toBe(true);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 25).url)).toBe(true);
	});
});

describe("GET /comments — edge-cache hit/bypass", () => {
	// app.request with no ExecutionContext makes the write-through inline (see
	// tryWaitUntil), so the entry is present immediately after the first call.
	it("serves a warm first page from the edge cache (not the DB)", async () => {
		seedThreads(5);
		const env = mkEnv();
		const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
		const first = await app.request(
			`/?slug=${SLUG}`,
			{},
			env as unknown as Record<string, unknown>,
		);
		expect(first.status).toBe(200);
		expect(((await first.json()) as ListResp).threads).toHaveLength(5);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 25).url)).toBe(true);

		// Empty the table; a true cache hit still returns the original 5 threads.
		sqlite.prepare("DELETE FROM comments").run();
		const second = await app.request(
			`/?slug=${SLUG}`,
			{},
			env as unknown as Record<string, unknown>,
		);
		expect(((await second.json()) as ListResp).threads).toHaveLength(5);
		// The anonymous first page must NOT be browser-cacheable (personalization
		// safety: it would otherwise be reused for the same user after sign-in).
		expect(second.headers.get("cache-control")).toBeNull();
	});

	it("caches a cursor page under a cursor-stamped key", async () => {
		// This inverts the old expectation. Cursor pages used to bypass the cache
		// entirely, and because the cursor was only shape-checked, ANY well-formed
		// ULID in `?before=` was a guaranteed cache miss in front of an unbounded
		// query — an unauthenticated read amplifier.
		seedThreads(30);
		setSetting("comments_per_page", "10");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}`);
		const cursor = first.next_cursor!;
		await get(env, `slug=${SLUG}&before=${cursor}`);

		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 10).url)).toBe(true);
		expect(
			mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 10, cursor).url),
		).toBe(true);
		expect(mockCache.store.size).toBe(2);
	});

	it("serves a warm cursor page from the cache", async () => {
		seedThreads(30);
		setSetting("comments_per_page", "10");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}`);
		const cursor = first.next_cursor!;
		const warm = await get(env, `slug=${SLUG}&before=${cursor}`);

		sqlite.prepare("DELETE FROM comments").run();
		const hit = await get(env, `slug=${SLUG}&before=${cursor}`);
		expect(hit.threads.map((t) => t.id)).toEqual(warm.threads.map((t) => t.id));
	});

	it("does not cache an empty cursor page", async () => {
		// A cursor is never validated against the data — any well-formed ULID
		// decodes fine and simply matches nothing. Caching those would let one
		// client mint unlimited distinct entries from a random-ULID loop.
		seedThreads(5);
		const env = mkEnv();
		await get(env, `slug=${SLUG}&before=${mkUlid(1)}`); // oldest id → no rows
		expect(mockCache.store.size).toBe(0);

		// Sanity: the same request shape with real rows behind it IS cached, and
		// the legacy bare-ULID spelling lands under the canonical composite key.
		await get(env, `slug=${SLUG}&before=${mkUlid(3)}`);
		expect(
			mockCache.store.has(
				treeCacheKey(REQ_URL, SLUG, "new", 25, `1002.${mkUlid(3)}`).url,
			),
		).toBe(true);
	});

	it("normalizes a top cursor before it reaches the cache key", async () => {
		// `08:<ulid>` and `8:<ulid>` are the same position; only the canonical
		// re-encoding is keyed, so cosmetic variants can't mint extra entries.
		seedThreads(
			10,
			Array.from({ length: 10 }, (_, i) => i),
		);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		await get(env, `slug=${SLUG}&sort=top&before=8:${mkUlid(9)}`);
		await get(env, `slug=${SLUG}&sort=top&before=08:${mkUlid(9)}`);
		expect(mockCache.store.size).toBe(1);
		expect(
			mockCache.store.has(
				treeCacheKey(REQ_URL, SLUG, "top", 2, `8:${mkUlid(9)}`).url,
			),
		).toBe(true);
	});
});

describe("chronological cursor format (created_at.ulid)", () => {
	const CHRONO = /^-?\d{1,13}\.[0-9A-HJKMNP-TV-Z]{26}$/;

	// Page size is the `comments_per_page` setting (no query param), so every
	// test here sets it to 2 before building the env, the way the existing
	// cursor tests set it to 10.
	it("emits <created_at>.<ulid> for new and old", async () => {
		seedThreads(5);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		expect(first.next_cursor).toMatch(CHRONO);
		// Page 1 of `new` ends on thread index 4 (created_at 1003).
		expect(first.next_cursor).toBe(`1003.${mkUlid(4)}`);
		const old = await get(env, `slug=${SLUG}&sort=old`);
		expect(old.next_cursor).toBe(`1001.${mkUlid(2)}`);
	});

	it("pages misaligned rows by created_at with no skip or repeat", async () => {
		// ids ascend 1..6, timestamps shuffled: the shape an import produces.
		const stamps = [5, 1, 6, 2, 4, 3];
		stamps.forEach((t, idx) => {
			seedThreadAt(idx + 1, 2000 + t);
		});
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let guard = 0; guard < 10; guard++) {
			const page = await get(
				env,
				`slug=${SLUG}&sort=new${cursor ? `&before=${cursor}` : ""}`,
			);
			seen.push(...page.threads.map((t) => t.id));
			cursor = page.next_cursor;
			if (!cursor) break;
		}
		// created_at 6,5,4,3,2,1 → id indexes 3,1,5,6,4,2
		expect(seen).toEqual([3, 1, 5, 6, 4, 2].map(mkUlid));
	});

	it("accepts a legacy bare-ULID cursor and caches it under the composite key", async () => {
		seedThreads(5);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const viaLegacy = await get(env, `slug=${SLUG}&sort=new&before=${mkUlid(4)}`);
		const viaComposite = await get(mkEnv(), `slug=${SLUG}&sort=new&before=1003.${mkUlid(4)}`);
		expect(viaLegacy.threads.map((t) => t.id)).toEqual(viaComposite.threads.map((t) => t.id));
		expect(viaLegacy.threads.map((t) => t.id)).toEqual([mkUlid(3), mkUlid(2)]);
		expect(
			mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2, `1003.${mkUlid(4)}`).url),
		).toBe(true);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2, mkUlid(4)).url)).toBe(
			false,
		);
	});

	it("treats a legacy cursor that names no thread as the first page, one cache key", async () => {
		seedThreads(3);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		mockCache.store.clear();
		const probe = await get(env, `slug=${SLUG}&sort=new&before=${mkUlid(999)}`);
		expect(probe.threads.map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
		expect(mockCache.store.size).toBe(1);
		expect(mockCache.store.has(treeCacheKey(REQ_URL, SLUG, "new", 2).url)).toBe(true);
	});

	it("rejects a malformed composite cursor as no cursor", async () => {
		seedThreads(3);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=new`);
		const bad = await get(env, `slug=${SLUG}&sort=new&before=abc.${mkUlid(2)}`);
		expect(bad.threads.map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
	});

	it("leaves the top cursor format unchanged", async () => {
		seedThreads(4, [3, 1, 2, 0]);
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		const page = await get(env, `slug=${SLUG}&sort=top`);
		expect(page.next_cursor).toBe(`2:${mkUlid(3)}`);
	});

	it("accepts a negative created_at (pre-1970, import-only) in the before cursor", async () => {
		seedThreadAt(1, -7200000);
		seedThreadAt(2, -3600000);
		seedThreadAt(3, 0);
		setSetting("comments_per_page", "1");
		const env = mkEnv();
		const first = await get(env, `slug=${SLUG}&sort=old`);
		expect(first.threads.map((t) => t.id)).toEqual([mkUlid(1)]);
		expect(first.next_cursor).toBe(`-7200000.${mkUlid(1)}`);
		const second = await get(
			env,
			`slug=${SLUG}&sort=old&before=-7200000.${mkUlid(1)}`,
		);
		// A regex that rejects the sign would silently fall back to page 1.
		expect(second.threads.map((t) => t.id)).toEqual([mkUlid(2)]);
	});
});

describe("engagement queries are scoped to the page", () => {
	const reactionsQueries = () =>
		queries.filter((q) => /FROM reactions r/.test(q.sql) && /IN \(/.test(q.sql));

	it("loads reactions only for the comments on the page", async () => {
		// Page size comes from the `comments_per_page` setting (there is no
		// query param). With 2 per page, new-sort page 1 = threads 4,3; page 2 = 2,1.
		seedThreads(4);
		seedReaction(mkUlid(4), USER, "heart");
		seedReaction(mkUlid(1), USER, "heart");
		seedReaction(mkUlid(2), USER, "laugh");
		setSetting("comments_per_page", "2");
		const env = mkEnv();
		queries.length = 0;
		const page = await get(env, `slug=${SLUG}&sort=new`);

		expect(page.threads.map((t) => t.id)).toEqual([mkUlid(4), mkUlid(3)]);
		expect(page.threads[0]?.reactions).toEqual([{ kind: "heart", count: 1, mine: false }]);
		expect(page.threads[1]?.reactions).toEqual([]);

		const rq = reactionsQueries();
		expect(rq.length).toBe(1);
		// Binds are exactly the page's comment ids; nothing from page 2.
		expect([...rq[0]!.binds].sort()).toEqual([mkUlid(3), mkUlid(4)].sort());
		// `Recorded.rows` is the row COUNT the stub saw. Only thread 4's heart
		// matches the page ids, so exactly one row comes back.
		expect(rq[0]!.rows).toBe(1);
	});

	it("includes replies on the page in the id set", async () => {
		seedThreads(1);
		seedReplies(1, 1); // one reply under thread 1, id mkUlid(100_000)
		const replyId = mkUlid(100_000);
		seedReaction(replyId, USER, "heart");
		const env = mkEnv();
		queries.length = 0;
		await get(env, `slug=${SLUG}&sort=new`);
		const rq = reactionsQueries();
		expect(rq.length).toBe(1);
		expect(rq[0]!.binds).toContain(replyId);
	});

	it("issues no engagement query for an empty page", async () => {
		const env = mkEnv();
		queries.length = 0;
		const page = await get(env, `slug=${SLUG}&sort=new`);
		expect(page.threads).toEqual([]);
		expect(reactionsQueries().length).toBe(0);
	});
});

describe("engagement query batching", () => {
	const ids = Array.from({ length: 200 }, (_, i) => mkUlid(i + 1));

	it("splits 200 ids into batches of 90, 90, 20 for all three queries", async () => {
		seedThreads(0);
		const env = mkEnv();
		queries.length = 0;
		const db = env.DB;
		await listReactionsForComments(db, ids);
		await listUserReactionsOnComments(db, ids, USER);
		await getUserVotesOnComments(db, ids, USER);
		const sizes = queries.map((q) => q.binds.length);
		// reactions: ids only; user reactions and votes: ids + user_id
		expect(sizes).toEqual([90, 90, 20, 91, 91, 21, 91, 91, 21]);
	});

	it("returns empty results and runs no query for an empty id list", async () => {
		const env = mkEnv();
		queries.length = 0;
		expect(await listReactionsForComments(env.DB, [])).toEqual([]);
		expect(await listUserReactionsOnComments(env.DB, [], USER)).toEqual(new Set());
		expect(await getUserVotesOnComments(env.DB, [], USER)).toEqual(new Map());
		expect(queries.length).toBe(0);
	});
});
