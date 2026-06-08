/**
 * In-memory stand-in for the Cloudflare Cache API (`caches.default`) so route
 * tests can exercise the edge-cache hit/miss/bust paths in the node pool.
 *
 * The cache key is the Request URL (Cache API semantics: keyed by URL + GET).
 * Stored Responses are cloned in and out so a body is never consumed twice.
 */

export type MockCache = {
	store: Map<string, Response>;
	match(req: Request | string): Promise<Response | undefined>;
	put(req: Request | string, res: Response): Promise<void>;
	delete(req: Request | string): Promise<boolean>;
};

const keyOf = (req: Request | string): string =>
	typeof req === "string" ? req : req.url;

export const makeMockCache = (): MockCache => {
	const store = new Map<string, Response>();
	return {
		store,
		async match(req) {
			const r = store.get(keyOf(req));
			return r ? r.clone() : undefined;
		},
		async put(req, res) {
			store.set(keyOf(req), res.clone());
		},
		async delete(req) {
			return store.delete(keyOf(req));
		},
	};
};

/**
 * Install a global `caches` backed by a single default cache and return it for
 * inspection. Pair with uninstallMockCaches() in afterEach so a global doesn't
 * bleed across tests.
 */
export const installMockCaches = (): MockCache => {
	const cache = makeMockCache();
	(globalThis as { caches?: unknown }).caches = {
		default: cache,
		async open() {
			return cache;
		},
	};
	return cache;
};

export const uninstallMockCaches = (): void => {
	delete (globalThis as { caches?: unknown }).caches;
};
