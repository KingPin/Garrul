/**
 * GET /api/v1/comments pagination tests.
 *
 * Covers the configurable page-size behavior added alongside the collapsible-
 * replies work:
 *
 *   1. `comments_per_page` (DB > env > default 25) drives the server-side
 *      top-level slice — the default, an env override, and a DB-row override.
 *   2. `sort=new` walks pages via the ULID `before` cursor (id < cursor).
 *   3. `sort=top` now PAGINATES too (composite score:id cursor), so a small
 *      page size no longer hides top-voted threads past the first page.
 *   4. The first-page edge-cache key varies with the page size, so a size
 *      change can't serve a stale-sized slice.
 *
 * No Miniflare: a hand-rolled D1 stub routes by SQL substring (same style as
 * votes.test.ts), an in-memory KV double for TREE_CACHE/SESSIONS (settings +
 * session reads), and a mock `caches.default` for the first-page edge cache.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { comments } from "../src/routes/api.comments";
import { treeCacheKey } from "../src/lib/tree-cache";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

let mockCache: MockCache;
beforeEach(() => {
	mockCache = installMockCaches();
});
afterEach(() => uninstallMockCaches());

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

type CommentRow = {
	id: string;
	post_slug: string;
	parent_id: string | null;
	user_id: string;
	body_md: string;
	body_html: string;
	renderer_version: number;
	status: string;
	edited_at: number | null;
	deleted_at: number | null;
	ip_hash: string | null;
	user_agent: string | null;
	created_at: number;
	score_up: number;
	score_down: number;
};

// Build N top-level comments, oldest first (created_at and id both ascending
// with index). `scores[i]` optionally sets the net up-votes for the top-sort
// tests; unset → 0.
const makeComments = (n: number, scores: number[] = []): CommentRow[] =>
	Array.from({ length: n }, (_, i) => ({
		id: mkUlid(i + 1),
		post_slug: "hello",
		parent_id: null,
		user_id: "01HU000000000000000000",
		body_md: `c${i}`,
		body_html: `<p>c${i}</p>`,
		renderer_version: 1,
		status: "approved",
		edited_at: null,
		deleted_at: null,
		ip_hash: null,
		user_agent: null,
		created_at: 1000 + i,
		score_up: scores[i] ?? 0,
		score_down: 0,
	}));

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

// D1 double routing by SQL substring. `settings` carries the numeric overrides
// for loadNumbers(); the rest feed the GET list handler.
const makeDb = (rows: CommentRow[], settings: Record<string, string> = {}) => {
	const all = async (sql: string) => {
		if (sql.includes("key, value FROM settings")) {
			return {
				results: Object.entries(settings).map(([key, value]) => ({
					key,
					value,
				})),
			};
		}
		if (sql.includes("FROM comments") && sql.includes("status NOT IN")) {
			return { results: rows };
		}
		if (sql.includes("FROM users WHERE id IN")) {
			return {
				results: [
					{
						id: "01HU000000000000000000",
						provider: "anon",
						provider_id: null,
						name: "anon",
						email: null,
						avatar_url: null,
						is_admin: 0,
						is_banned: 0,
						role: "user",
						created_at: 1_700_000_000_000,
					},
				],
			};
		}
		if (sql.includes("FROM reactions")) {
			return { results: [] };
		}
		return { results: [] };
	};
	const first = async (sql: string) => {
		if (sql.includes("FROM posts WHERE slug")) {
			return { slug: "hello", title: "Hello", url: null, created_at: 1 };
		}
		return null;
	};
	const chain = (sql: string) => ({
		bind() {
			return this;
		},
		all: () => all(sql),
		first: () => first(sql),
	});
	return { prepare: (sql: string) => chain(sql) };
};

const mkEnv = (rows: CommentRow[], settings: Record<string, string> = {}, envVars: Record<string, string> = {}) => {
	const kv = makeKv();
	const env = {
		DB: makeDb(rows, settings),
		TREE_CACHE: kv,
		SESSIONS: { get: async () => null },
		...envVars,
	} as unknown as Bindings;
	return { env, kv };
};

type ListResp = {
	threads: { id: string; score_up: number; score_down: number }[];
	next_cursor: string | null;
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

describe("GET /comments — default page size", () => {
	it("returns 25 threads + a cursor when there are more", async () => {
		const { env } = mkEnv(makeComments(30));
		const page = await get(env, "slug=hello");
		expect(page.threads).toHaveLength(25);
		expect(page.next_cursor).not.toBeNull();
	});

	it("returns everything with a null cursor when under the page size", async () => {
		const { env } = mkEnv(makeComments(5));
		const page = await get(env, "slug=hello");
		expect(page.threads).toHaveLength(5);
		expect(page.next_cursor).toBeNull();
	});
});

describe("GET /comments — configurable page size", () => {
	it("honors a DB-row comments_per_page override", async () => {
		const { env } = mkEnv(makeComments(30), { comments_per_page: "10" });
		const page = await get(env, "slug=hello");
		expect(page.threads).toHaveLength(10);
		expect(page.next_cursor).not.toBeNull();
	});

	it("honors a COMMENTS_PER_PAGE env override", async () => {
		const { env } = mkEnv(makeComments(30), {}, { COMMENTS_PER_PAGE: "5" });
		const page = await get(env, "slug=hello");
		expect(page.threads).toHaveLength(5);
	});

	it("clamps a hostile DB value so the slice can't explode", async () => {
		const { env } = mkEnv(makeComments(30), { comments_per_page: "1000000" });
		const page = await get(env, "slug=hello");
		// Clamp max is 200; only 30 rows exist, so all 30 come back, no cursor.
		expect(page.threads).toHaveLength(30);
		expect(page.next_cursor).toBeNull();
	});
});

describe("GET /comments — sort=new cursor walks pages", () => {
	it("second page returns the remainder and a null cursor", async () => {
		const { env } = mkEnv(makeComments(30), { comments_per_page: "10" });
		const first = await get(env, "slug=hello");
		expect(first.threads).toHaveLength(10);
		// new-sort is newest-first: page 1 starts at the highest id (c29).
		expect(first.threads[0]!.id).toBe(mkUlid(30));

		const second = await get(env, `slug=hello&before=${first.next_cursor}`);
		expect(second.threads).toHaveLength(10);
		const third = await get(env, `slug=hello&before=${second.next_cursor}`);
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
});

describe("GET /comments — sort=top paginates (no hidden threads)", () => {
	it("returns a page-sized slice ordered by score, with a cursor", async () => {
		// 10 comments, ascending score 0..9 by index. Top sort should surface
		// the 2 highest-scoring (c9=9, c8=8) on the first page of size 2.
		const scores = Array.from({ length: 10 }, (_, i) => i);
		const { env } = mkEnv(makeComments(10, scores), {
			comments_per_page: "2",
		});
		const first = await get(env, "slug=hello&sort=top");
		expect(first.threads).toHaveLength(2);
		expect(first.threads.map((t) => t.score_up)).toEqual([9, 8]);
		expect(first.next_cursor).not.toBeNull();

		// Walking the composite score:id cursor reaches the lower-scored
		// threads that a single unpaginated page of size 2 would have hidden.
		const second = await get(env, `slug=hello&sort=top&before=${first.next_cursor}`);
		expect(second.threads.map((t) => t.score_up)).toEqual([7, 6]);
	});

	it("walks every thread across pages with no overlap", async () => {
		const scores = Array.from({ length: 10 }, (_, i) => i);
		const { env } = mkEnv(makeComments(10, scores), {
			comments_per_page: "3",
		});
		const seen: string[] = [];
		let cursor: string | null = null;
		for (let i = 0; i < 10; i++) {
			const q = cursor ? `slug=hello&sort=top&before=${cursor}` : "slug=hello&sort=top";
			const page: ListResp = await get(env, q);
			seen.push(...page.threads.map((t) => t.id));
			cursor = page.next_cursor;
			if (!cursor) break;
		}
		expect(new Set(seen).size).toBe(10);
	});
});

describe("GET /comments — cache key varies with page size", () => {
	it("caches the first page under a size-stamped edge-cache key", async () => {
		const { env } = mkEnv(makeComments(30), { comments_per_page: "10" });
		await get(env, "slug=hello");
		expect(mockCache.store.has(treeCacheKey("hello", "new", 10).url)).toBe(true);
		expect(mockCache.store.has(treeCacheKey("hello", "new", 25).url)).toBe(false);
	});

	it("a different size resolves to a different cache slot", async () => {
		const { env: env10 } = mkEnv(makeComments(30), {
			comments_per_page: "10",
		});
		await get(env10, "slug=hello");

		const { env: env25 } = mkEnv(makeComments(30));
		await get(env25, "slug=hello");

		expect(mockCache.store.has(treeCacheKey("hello", "new", 10).url)).toBe(true);
		expect(mockCache.store.has(treeCacheKey("hello", "new", 25).url)).toBe(true);
	});
});

describe("GET /comments — edge-cache hit/bypass", () => {
	// app.request with no ExecutionContext makes the write-through inline (see
	// tryWaitUntil), so the entry is present immediately after the first call.
	it("serves a warm first page from the edge cache (not the DB)", async () => {
		const rows = makeComments(5);
		const { env } = mkEnv(rows);
		const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
		const first = await app.request("/?slug=hello", {}, env as unknown as Record<string, unknown>);
		expect(first.status).toBe(200);
		expect(((await first.json()) as ListResp).threads).toHaveLength(5);
		expect(mockCache.store.has(treeCacheKey("hello", "new", 25).url)).toBe(true);

		// Empty the DB; a true cache hit still returns the original 5 threads.
		rows.length = 0;
		const second = await app.request("/?slug=hello", {}, env as unknown as Record<string, unknown>);
		expect(((await second.json()) as ListResp).threads).toHaveLength(5);
		// The anonymous first page must NOT be browser-cacheable (personalization
		// safety: it would otherwise be reused for the same user after sign-in).
		expect(second.headers.get("cache-control")).toBeNull();
	});

	it("does not cache a cursor (non-first) page", async () => {
		const { env } = mkEnv(makeComments(30), { comments_per_page: "10" });
		const first = await get(env, "slug=hello");
		// Second page request carries a cursor → must bypass the cache entirely.
		await get(env, `slug=hello&before=${first.next_cursor}`);
		expect([...mockCache.store.keys()].length).toBe(1); // only the first page
	});
});
