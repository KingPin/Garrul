/**
 * /api/v1/counts tests — the default comment-count shape stays backward
 * compatible, and the opt-in ?include=votes,reactions extras appear only
 * when both requested AND the matching page-level flag is enabled.
 *
 * In-memory D1 matches on the SQL each query helper issues; a stateful KV
 * double backs both the counts cache and the resolved-flags cache so the
 * flag gate and cache-key behavior are exercised for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { TestApp, } from "./helpers/app";
import { counts } from "../src/routes/api.counts";
import { corsAndCsrf } from "../src/lib/cors";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";

// The counts response cache lives in the edge Cache API now; the KV double
// below still backs the settings:flags cache that the include gate reads.
let mockCache: MockCache;
beforeEach(() => {
	mockCache = installMockCaches();
});
afterEach(() => uninstallMockCaches());

type Comment = { post_slug: string; status: string };
type Vote = { post_slug: string; value: number };
type Reaction = { post_slug: string; kind: string };

const makeDb = (seed: {
	comments?: Comment[];
	votes?: Vote[];
	reactions?: Reaction[];
	settings?: Record<string, string>;
}) => {
	const comments = seed.comments ?? [];
	const votes = seed.votes ?? [];
	const reactions = seed.reactions ?? [];
	const settings = seed.settings ?? {};

	const stmt = (sql: string) => {
		let binds: unknown[] = [];
		const api = {
			bind(...args: unknown[]) {
				binds = args;
				return api;
			},
			async all<T>() {
				if (sql.includes("FROM settings")) {
					return {
						results: Object.entries(settings).map(([key, value]) => ({
							key,
							value,
						})),
					} as { results: T[] };
				}
				const slugs = binds as string[];
				const want = new Set(slugs);
				if (sql.includes("FROM comments")) {
					const bySlug = new Map<string, number>();
					for (const cm of comments) {
						if (cm.status === "approved" && want.has(cm.post_slug))
							bySlug.set(cm.post_slug, (bySlug.get(cm.post_slug) ?? 0) + 1);
					}
					return {
						results: [...bySlug].map(([post_slug, count]) => ({
							post_slug,
							count,
						})),
					} as { results: T[] };
				}
				if (sql.includes("FROM page_votes")) {
					const up = new Map<string, number>();
					const down = new Map<string, number>();
					for (const v of votes) {
						if (!want.has(v.post_slug)) continue;
						if (v.value === 1) up.set(v.post_slug, (up.get(v.post_slug) ?? 0) + 1);
						if (v.value === -1)
							down.set(v.post_slug, (down.get(v.post_slug) ?? 0) + 1);
					}
					const all = new Set([...up.keys(), ...down.keys()]);
					return {
						results: [...all].map((post_slug) => ({
							post_slug,
							score_up: up.get(post_slug) ?? 0,
							score_down: down.get(post_slug) ?? 0,
						})),
					} as { results: T[] };
				}
				if (sql.includes("FROM page_reactions")) {
					const byKey = new Map<string, number>();
					for (const r of reactions) {
						if (!want.has(r.post_slug)) continue;
						const k = `${r.post_slug}\u0000${r.kind}`;
						byKey.set(k, (byKey.get(k) ?? 0) + 1);
					}
					return {
						results: [...byKey].map(([k, count]) => {
							const [post_slug, kind] = k.split("\u0000");
							return { post_slug, kind, count };
						}),
					} as { results: T[] };
				}
				return { results: [] as T[] };
			},
		};
		return api;
	};
	return { prepare: (sql: string) => stmt(sql) };
};

// Stateful KV: backs both the counts cache and settings:flags cache.
const makeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string, _t?: unknown) => {
			const v = store.get(k);
			return v == null ? null : JSON.parse(v);
		},
		put: async (k: string, v: string) => {
			store.set(k, v);
		},
		delete: async (k: string) => {
			store.delete(k);
		},
	};
};

const mkApp = (seed: Parameters<typeof makeDb>[0]) => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/", counts);
	const kv = makeKv();
	const env = {
		DB: makeDb(seed),
		TREE_CACHE: kv,
	};
	return { app, env, kv };
};

const get = (app: TestApp, env: Record<string, unknown>, path: string) =>
	app.request(path, {}, env);

describe("counts — default shape (backward compatible)", () => {
	it("returns only comment counts and omits zero-comment slugs", async () => {
		const { app, env } = mkApp({
			comments: [
				{ post_slug: "a", status: "approved" },
				{ post_slug: "a", status: "approved" },
				{ post_slug: "b", status: "pending" },
			],
		});
		const res = await get(app, env, "/?slugs=a,b,c");
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ counts: { a: 2 } });
		expect(body).not.toHaveProperty("votes");
		expect(body).not.toHaveProperty("reactions");
	});

	it("returns empty counts for a missing slugs param", async () => {
		const { app, env } = mkApp({});
		const res = await get(app, env, "/");
		expect(await res.json()).toEqual({ counts: {} });
	});
});

describe("counts — include=votes,reactions when flags enabled", () => {
	const seed = {
		comments: [{ post_slug: "a", status: "approved" }],
		votes: [
			{ post_slug: "a", value: 1 },
			{ post_slug: "a", value: 1 },
			{ post_slug: "a", value: -1 },
		],
		reactions: [
			{ post_slug: "a", kind: "like" },
			{ post_slug: "a", kind: "like" },
			{ post_slug: "a", kind: "love" },
		],
		settings: {
			page_votes_enabled: "true",
			page_reactions_enabled: "true",
		},
	};

	it("adds votes tally and reaction totals", async () => {
		const { app, env } = mkApp(seed);
		const res = await get(app, env, "/?slugs=a&include=votes,reactions");
		const body = (await res.json()) as {
			counts: Record<string, number>;
			votes: Record<string, { score_up: number; score_down: number }>;
			reactions: Record<string, Record<string, number>>;
		};
		expect(body.counts).toEqual({ a: 1 });
		expect(body.votes.a).toEqual({ score_up: 2, score_down: 1 });
		expect(body.reactions.a).toEqual({ like: 2, love: 1 });
	});
});

describe("counts — flag gating", () => {
	it("omits extras when the page flags are disabled, even if requested", async () => {
		const { app, env } = mkApp({
			comments: [{ post_slug: "a", status: "approved" }],
			votes: [{ post_slug: "a", value: 1 }],
			reactions: [{ post_slug: "a", kind: "like" }],
			// no settings rows → page_* default OFF
		});
		const res = await get(app, env, "/?slugs=a&include=votes,reactions");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ counts: { a: 1 } });
	});

	it("includes votes but not reactions when only votes is enabled", async () => {
		const { app, env } = mkApp({
			comments: [{ post_slug: "a", status: "approved" }],
			votes: [{ post_slug: "a", value: 1 }],
			reactions: [{ post_slug: "a", kind: "like" }],
			settings: { page_votes_enabled: "true" },
		});
		const res = await get(app, env, "/?slugs=a&include=votes,reactions");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("votes");
		expect(body).not.toHaveProperty("reactions");
	});
});

describe("counts — CORS headers through the real middleware", () => {
	// counts is fetched cross-origin straight from the host page (the badge
	// script), so the GET response itself must carry Access-Control-Allow-Origin
	// — on BOTH the cache-miss (cacheJson) and cache-hit (matchCache) paths,
	// which return raw Responses that bypass Hono's prepared headers.
	const mkCorsApp = () => {
		const app = new Hono<{ Bindings: Record<string, unknown> }>();
		app.use("*", corsAndCsrf());
		app.route("/api/v1/counts", counts);
		const env = {
			DB: makeDb({ comments: [{ post_slug: "a", status: "approved" }] }),
			TREE_CACHE: makeKv(),
			ALLOWED_ORIGINS: "https://blog.example.com, https://other.example.com",
		};
		return { app, env };
	};
	const getFrom = (app: TestApp, env: Record<string, unknown>, origin: string) =>
		app.request("/api/v1/counts?slugs=a", { headers: { origin } }, env);

	it("cache miss: GET response carries Access-Control-Allow-Origin", async () => {
		const { app, env } = mkCorsApp();
		const res = await getFrom(app, env, "https://blog.example.com");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://blog.example.com",
		);
		expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
		expect(res.headers.get("Vary")).toBe("Origin");
	});

	it("cache hit: echoes the CURRENT requester's origin, not the warmer's", async () => {
		const { app, env } = mkCorsApp();
		await getFrom(app, env, "https://blog.example.com"); // warm
		const res = await getFrom(app, env, "https://other.example.com");
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://other.example.com",
		);
	});

	it("stored edge-cache copy carries no CORS headers (added per-request)", async () => {
		const { app, env } = mkCorsApp();
		await getFrom(app, env, "https://blog.example.com");
		const stored = [...mockCache.store.values()];
		expect(stored.length).toBe(1);
		expect(stored[0]!.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});

describe("counts — cache key varies by include set", () => {
	it("does not serve a plain-call cache entry to an extras call", async () => {
		const { app, env } = mkApp({
			comments: [{ post_slug: "a", status: "approved" }],
			votes: [{ post_slug: "a", value: 1 }],
			settings: { page_votes_enabled: "true" },
		});
		// Warm the plain entry.
		await get(app, env, "/?slugs=a");
		// Extras call must compute fresh (different key) and include votes.
		const res = await get(app, env, "/?slugs=a&include=votes");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("votes");
		// Two distinct edge-cache entries now exist (plain + votes).
		expect(
			[...mockCache.store.keys()].filter((k) => k.includes("/counts?")).length,
		).toBe(2);
	});

	it("serves a warm edge-cache hit without recomputing", async () => {
		const { app, env } = mkApp({
			comments: [{ post_slug: "a", status: "approved" }],
		});
		const first = await get(app, env, "/?slugs=a");
		expect(((await first.json()) as { counts: Record<string, number> }).counts).toEqual({ a: 1 });
		// One cached entry; a second identical call returns the cached Response
		// (cache-control header present means it came back through the cache).
		expect([...mockCache.store.keys()].filter((k) => k.includes("/counts?")).length).toBe(1);
		const second = await get(app, env, "/?slugs=a");
		expect(second.headers.get("cache-control")).toBe("public, max-age=60");
		expect(((await second.json()) as { counts: Record<string, number> }).counts).toEqual({ a: 1 });
	});
});
