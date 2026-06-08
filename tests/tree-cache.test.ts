/**
 * bustTreeCache() — edge-cache invalidation + resilience.
 *
 * The helper resolves the current page size and drops the slug's first-page
 * entries (both sorts) from the current colo's edge cache. It is best-effort:
 * neither a settings-read failure nor a cache-delete failure may propagate,
 * because every comment mutation (post / edit / delete / reaction) awaits it on
 * the user-visible path.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bustTreeCache, treeCacheKey } from "../src/lib/tree-cache";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

afterEach(() => uninstallMockCaches());

// Stand-in for a mutation's c.req.url; only its origin is used for the key, so
// bustTreeCache and the treeCacheKey assertions line up on the same origin.
const REQ_URL = "http://localhost/";

// Settings KV double: loadNumbers() reads `settings:numbers` first; returning a
// warm value keeps the bust path off D1. DB is a stub for the fallback path.
const env = (pageSize = 25): Bindings =>
	({
		TREE_CACHE: {
			get: async (k: string) =>
				k === "settings:numbers"
					? {
							comments_per_page: pageSize,
							replies_per_thread: 3,
							auto_collapse_depth: 3,
						}
					: null,
			put: async () => {},
			delete: async () => {},
		},
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				all: async () => ({ results: [] }),
			}),
		},
	}) as unknown as Bindings;

describe("bustTreeCache", () => {
	it("drops both sort variants for the slug at the current page size", async () => {
		const cache = installMockCaches();
		cache.store.set(treeCacheKey(REQ_URL, "hello", "new", 25).url, new Response("{}"));
		cache.store.set(treeCacheKey(REQ_URL, "hello", "top", 25).url, new Response("{}"));
		// A different page size is left for the TTL — the bust only knows the
		// current size (best-effort).
		cache.store.set(treeCacheKey(REQ_URL, "hello", "new", 10).url, new Response("{}"));

		await bustTreeCache(env(25), REQ_URL, "hello");

		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "new", 25).url)).toBe(false);
		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "top", 25).url)).toBe(false);
		expect(cache.store.has(treeCacheKey(REQ_URL, "hello", "new", 10).url)).toBe(true);
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
