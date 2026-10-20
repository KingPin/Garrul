/**
 * bustTreeCache() — edge-cache invalidation + resilience.
 *
 * The helper resolves the current page size and drops the slug's first-page
 * entries (every sort) from the current colo's edge cache. It is best-effort:
 * neither a settings-read failure nor a cache-delete failure may propagate,
 * because every comment mutation (post / edit / delete / reaction) awaits it on
 * the user-visible path.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bustTreeCache, feedCacheKey, treeCacheKey } from "../src/lib/tree-cache";
import { COMMENT_SORTS } from "../src/db/queries";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

afterEach(() => uninstallMockCaches());

// Stand-in for a mutation's c.req.url; only its origin is used for the key, so
// bustTreeCache and the treeCacheKey assertions line up on the same origin.
const REQ_URL = "http://localhost/";

// Settings come from D1 rows (the loader reads nothing from KV). The stub
// returns `comments_per_page` so `pageSize` is live. The settings memo is
// module-level; the setup file busts it before each test.
const env = (pageSize = 25): Bindings =>
	({
		TREE_CACHE: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				all: async () => ({
					results: [{ key: "comments_per_page", value: String(pageSize) }],
				}),
			}),
		},
	}) as unknown as Bindings;

describe("bustTreeCache", () => {
	// Driven off COMMENT_SORTS rather than a hand-written list of sorts, so a
	// sort added without a matching drop fails here instead of quietly serving a
	// stale first page for a TTL after every mutation.
	it("drops every sort variant for the slug at the current page size", async () => {
		const cache = installMockCaches();
		for (const sort of COMMENT_SORTS) {
			cache.store.set(treeCacheKey(REQ_URL, "hello", sort, 25).url, new Response("{}"));
		}
		// A different page size is left for the TTL — the bust only knows the
		// current size (best-effort).
		cache.store.set(treeCacheKey(REQ_URL, "hello", "new", 10).url, new Response("{}"));

		await bustTreeCache(env(25), REQ_URL, "hello");

		for (const sort of COMMENT_SORTS) {
			expect(cache.store.has(treeCacheKey(REQ_URL, "hello", sort, 25).url)).toBe(false);
		}
		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "new", 10).url)).toBe(true);
	});

	it("drops the slug's feed too, and only that slug's", async () => {
		const cache = installMockCaches();
		cache.store.set(feedCacheKey(REQ_URL, "hello").url, new Response("<feed/>"));
		cache.store.set(feedCacheKey(REQ_URL, "other").url, new Response("<feed/>"));
		await bustTreeCache(env(25), REQ_URL, "hello");
		expect(cache.store.has(feedCacheKey(REQ_URL, "hello").url)).toBe(false);
		expect(cache.store.has(feedCacheKey(REQ_URL, "other").url)).toBe(true);
	});

	it("keys each sort separately so one sort's page never serves another's", () => {
		const urls = COMMENT_SORTS.map((s) => treeCacheKey(REQ_URL, "hello", s, 25).url);
		expect(new Set(urls).size).toBe(COMMENT_SORTS.length);
	});

	it("does not touch other slugs' cache entries", async () => {
		const cache = installMockCaches();
		cache.store.set(treeCacheKey(REQ_URL, "hello", "new", 25).url, new Response("{}"));
		cache.store.set(treeCacheKey(REQ_URL, "other", "new", 25).url, new Response("{}"));

		await bustTreeCache(env(25), REQ_URL, "hello");

		expect(cache.store.has(treeCacheKey(REQ_URL, "other", "new", 25).url)).toBe(true);
		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "new", 25).url)).toBe(false);
	});

	it("swallows a cache delete failure (best-effort) and still resolves", async () => {
		installMockCaches();
		(globalThis as { caches?: unknown }).caches = {
			default: {
				match: async () => undefined,
				put: async () => {},
				delete: async () => {
					throw new Error("colo down");
				},
			},
		};
		await expect(bustTreeCache(env(25), REQ_URL, "hello")).resolves.toBeUndefined();
	});

	it("resolves quietly when the edge cache is unavailable", async () => {
		uninstallMockCaches();
		await expect(bustTreeCache(env(25), REQ_URL, "hello")).resolves.toBeUndefined();
	});

	it("skips the drop when the page size can't be resolved", async () => {
		const cache = installMockCaches();
		cache.store.set(treeCacheKey(REQ_URL, "hello", "new", 25).url, new Response("{}"));
		const badEnv = {
			TREE_CACHE: {
				get: async () => {
					throw new Error("kv down");
				},
				put: async () => {},
			},
			DB: {
				prepare: () => ({
					bind() {
						return this;
					},
					all: async () => {
						throw new Error("d1 down");
					},
				}),
			},
		} as unknown as Bindings;

		await expect(bustTreeCache(badEnv, REQ_URL, "hello")).resolves.toBeUndefined();
		// Page size unknown → nothing dropped.
		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "new", 25).url)).toBe(true);
	});
});
