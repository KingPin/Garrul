/**
 * `cacheable = !session` on the comment-tree GET — the invariant that keeps a
 * per-viewer response out of the shared edge cache.
 *
 * A signed-in viewer's payload is not the anonymous one: it carries `my_vote`
 * and `mine` flags, and it includes that viewer's own `pending` comments so a
 * moderated post visibly landed. The Cache API is keyed by URL alone, so if a
 * signed-in response were ever stored, the very next anonymous reader on that
 * colo would be served someone else's vote state and unapproved comments.
 *
 * The existing tree tests all stub SESSIONS to return null, so every one of
 * them takes the anonymous branch and none of them could catch a regression
 * here. These pin both halves: the write is skipped, and — the half that
 * actually leaks — the *read* is skipped too, so a signed-in viewer is never
 * handed the anonymous body from the cache.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { treeCacheKey } from "../src/lib/tree-cache";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

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

const SID = "a".repeat(64);
const USER = "01HU00000000000000VIEWER";
const SLUG = "cached";
const PAGE_SIZE = 25;
const REQ_URL = `http://localhost/?slug=${SLUG}`;

/** The key the route computes for an anonymous first page of this slug. */
const keyUrl = (): string =>
	treeCacheKey(REQ_URL, SLUG, "new", PAGE_SIZE, null).url;

let sqlite: DatabaseSync;
let cache: MockCache;
let env: Bindings;

beforeEach(() => {
	cache = installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(USER, "github", "1", "Viewer", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Cached", null, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', ?, 1)`,
		)
		.run("01HC00000000000000000001", SLUG, USER, 1_700_000_000_000);

	env = {
		DB: makeD1(sqlite),
		// Warm settings so page size is a known 25 and the key is predictable.
		TREE_CACHE: {
			get: async (k: string) =>
				k === "settings:numbers"
					? {
							comments_per_page: PAGE_SIZE,
							replies_per_thread: 3,
							auto_collapse_depth: 3,
						}
					: null,
			put: async () => {},
			delete: async () => {},
		},
		SESSIONS: {
			async get(key: string) {
				return key === `sess:${SID}`
					? JSON.stringify({ user_id: USER, expires_at: 4_102_444_800_000 })
					: null;
			},
			async put() {},
			async delete() {},
		},
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const get = (sid?: string) =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", comments)
		.request(
			REQ_URL,
			{ headers: sid ? { cookie: `garrul_sess=${sid}` } : {} },
			env as unknown as Record<string, unknown>,
			execCtx,
		);

describe("comment tree — edge cache is anonymous-only", () => {
	it("stores the anonymous response", async () => {
		expect((await get()).status).toBe(200);
		// Baseline: without this the two negative assertions below would pass
		// against a route that simply never caches anything.
		expect(cache.store.has(keyUrl())).toBe(true);
	});

	it("does not store a signed-in response", async () => {
		expect((await get(SID)).status).toBe(200);
		expect(cache.store.has(keyUrl())).toBe(false);
	});

	it("does not serve a signed-in viewer from the cache", async () => {
		// Seed the key with a sentinel an anonymous request would be handed back
		// verbatim. A signed-in request must go to D1 instead — otherwise the
		// per-viewer flags silently become whatever the last anonymous page said.
		cache.store.set(
			keyUrl(),
			new Response(JSON.stringify({ threads: [], sentinel: true })),
		);

		const anon = await get();
		expect((await anon.json()) as Record<string, unknown>).toHaveProperty(
			"sentinel",
			true,
		);

		const authed = await get(SID);
		const body = (await authed.json()) as Record<string, unknown>;
		expect(body).not.toHaveProperty("sentinel");
		expect((body.threads as unknown[]).length).toBe(1);
	});
});
