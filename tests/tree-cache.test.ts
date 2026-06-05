/**
 * bustTreeCache() invalidation + resilience.
 *
 * The helper prefix-lists every first-page cache variant for a slug and
 * deletes them. It is best-effort: a transient KV failure (list or an
 * individual delete) must never propagate, because every comment mutation
 * (post / edit / delete / reaction) awaits it on the user-visible path.
 */
import { describe, it, expect } from "vitest";
import { bustTreeCache } from "../src/lib/tree-cache";

type KvOpts = { failDeleteFor?: Set<string>; failList?: boolean };

const makeKv = (keys: string[], opts: KvOpts = {}) => {
	const store = new Set(keys);
	const deleted: string[] = [];
	return {
		store,
		deleted,
		async list({ prefix }: { prefix: string }) {
			if (opts.failList) throw new Error("KV list down");
			return {
				keys: [...store]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
		async delete(name: string) {
			if (opts.failDeleteFor?.has(name)) throw new Error("KV delete down");
			deleted.push(name);
			store.delete(name);
		},
	};
};

const env = (kv: ReturnType<typeof makeKv>) =>
	({ TREE_CACHE: kv } as unknown as Parameters<typeof bustTreeCache>[0]);

describe("bustTreeCache", () => {
	it("deletes every first-page variant for the slug (all sorts + sizes)", async () => {
		const kv = makeKv([
			"tree:hello:first:new:n25",
			"tree:hello:first:top:n25",
			"tree:hello:first:new:n10",
			"tree:hello:first", // legacy pre-split key
		]);
		await bustTreeCache(env(kv), "hello");
		expect(kv.deleted.sort()).toEqual([
			"tree:hello:first",
			"tree:hello:first:new:n10",
			"tree:hello:first:new:n25",
			"tree:hello:first:top:n25",
		]);
	});

	it("does not touch other slugs' cache entries", async () => {
		const kv = makeKv([
			"tree:hello:first:new:n25",
			"tree:other:first:new:n25",
		]);
		await bustTreeCache(env(kv), "hello");
		expect(kv.store.has("tree:other:first:new:n25")).toBe(true);
		expect(kv.store.has("tree:hello:first:new:n25")).toBe(false);
	});

	it("swallows an individual delete failure (best-effort) and still resolves", async () => {
		const kv = makeKv(
			["tree:hello:first:new:n25", "tree:hello:first:top:n25"],
			{ failDeleteFor: new Set(["tree:hello:first:new:n25"]) },
		);
		// Must not reject even though one delete throws.
		await expect(bustTreeCache(env(kv), "hello")).resolves.toBeUndefined();
		// The non-failing key was still deleted.
		expect(kv.deleted).toContain("tree:hello:first:top:n25");
	});

	it("resolves quietly when the list call itself fails", async () => {
		const kv = makeKv(["tree:hello:first:new:n25"], { failList: true });
		await expect(bustTreeCache(env(kv), "hello")).resolves.toBeUndefined();
		expect(kv.deleted).toHaveLength(0);
	});
});
