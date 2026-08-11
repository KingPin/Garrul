/**
 * In-memory KV stub, for tests whose route reads resolved settings.
 *
 * `loadSettings` reads and writes one `TREE_CACHE` entry, and it reaches the
 * binding directly — `env.TREE_CACHE.get(...)` on an unbound namespace throws a
 * TypeError synchronously, which its `.catch()` never sees. So any test driving a
 * route that resolves a flag or a number needs this bound, or the route 500s for
 * a reason that has nothing to do with what the test is checking.
 *
 * Several older suites hand-roll this same three-method object. New ones should
 * import it from here; the existing copies are left alone rather than churned.
 *
 * Deliberately not a full KVNamespace: `get`, `put` and `delete` are the whole
 * surface src/lib/settings.ts uses, and `expirationTtl` is ignored because no
 * test advances far enough for a TTL to matter.
 */
export const makeKv = () => {
	const store = new Map<string, string>();
	return {
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
	};
};
