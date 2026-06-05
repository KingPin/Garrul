/**
 * Feature-flag resolution tests (src/lib/settings.ts).
 *
 * The contract under test is the precedence chain:
 *
 *     DB row  >  env var  >  hardcoded default
 *
 * plus the KV cache behavior that fronts it (GET /api/v1/config is hit on
 * every widget mount, so loadFlags() must avoid a D1 read when warm and bust
 * cleanly on save).
 *
 * No Miniflare: a hand-rolled `settings` D1 stub + an in-memory KV stub, in
 * the same style as votes.test.ts.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
	loadFlags,
	bustFlagsCache,
	FLAG_KEYS,
	type FlagKey,
} from "../src/lib/settings";
import { reactions } from "../src/routes/api.reactions";
import { comments } from "../src/routes/api.comments";
import type { Bindings } from "../src/index";

// In-memory KV double for TREE_CACHE. Tracks delete calls so a test can prove
// bustFlagsCache() actually drops the resolved object.
const makeKv = () => {
	const store = new Map<string, string>();
	let deletes = 0;
	return {
		store,
		deletes: () => deletes,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			deletes++;
			store.delete(key);
		},
	};
};

// D1 double exposing only what getAllSettings() needs: prepare().all() over
// `SELECT key, value FROM settings`. Counts reads so cache-hit tests can prove
// the DB was never touched.
const makeDb = (rows: Record<string, string>) => {
	let reads = 0;
	return {
		reads: () => reads,
		prepare(_sql: string) {
			return {
				async all() {
					reads++;
					return {
						results: Object.entries(rows).map(([key, value]) => ({
							key,
							value,
						})),
					};
				},
			};
		},
	};
};

const mkEnv = (
	dbRows: Record<string, string> = {},
	envVars: Record<string, string> = {},
) => {
	const kv = makeKv();
	const db = makeDb(dbRows);
	const env = {
		DB: db,
		TREE_CACHE: kv,
		...envVars,
	} as unknown as Bindings;
	return { env, kv, db };
};

describe("loadFlags — defaults", () => {
	it("returns built-in defaults when no DB rows and no env vars", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		expect(flags).toEqual({
			comments_enabled: true,
			reactions_enabled: true,
			votes_enabled: true,
			downvotes_enabled: true,
			page_reactions_enabled: false,
			page_votes_enabled: false,
		});
	});

	it("page-level features default OFF", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		expect(flags.page_reactions_enabled).toBe(false);
		expect(flags.page_votes_enabled).toBe(false);
	});

	it("resolves a value for every canonical flag key", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		for (const key of FLAG_KEYS) {
			expect(typeof flags[key as FlagKey]).toBe("boolean");
		}
	});
});

describe("loadFlags — env var over default", () => {
	it("env var disables a default-on flag", async () => {
		const { env } = mkEnv({}, { COMMENTS_ENABLED: "0" });
		const flags = await loadFlags(env);
		expect(flags.comments_enabled).toBe(false);
	});

	it("env var enables a default-off page flag", async () => {
		const { env } = mkEnv({}, { PAGE_VOTES_ENABLED: "true" });
		const flags = await loadFlags(env);
		expect(flags.page_votes_enabled).toBe(true);
	});

	it("honors legacy env names for votes/downvotes", async () => {
		const { env } = mkEnv(
			{},
			{ VOTING_ENABLED: "false", DOWNVOTES_ENABLED: "off" },
		);
		const flags = await loadFlags(env);
		expect(flags.votes_enabled).toBe(false);
		expect(flags.downvotes_enabled).toBe(false);
	});

	it("treats various falsy spellings as off", async () => {
		for (const raw of ["0", "false", "no", "off", "FALSE", " Off "]) {
			const { env } = mkEnv({}, { REACTIONS_ENABLED: raw });
			const flags = await loadFlags(env);
			expect(flags.reactions_enabled, `raw=${JSON.stringify(raw)}`).toBe(false);
		}
	});

	it("treats a non-empty non-falsy value as on", async () => {
		const { env } = mkEnv({}, { PAGE_REACTIONS_ENABLED: "1" });
		const flags = await loadFlags(env);
		expect(flags.page_reactions_enabled).toBe(true);
	});
});

describe("loadFlags — DB row over env var", () => {
	it("DB row beats a conflicting env var (DB on, env off)", async () => {
		const { env } = mkEnv(
			{ comments_enabled: "true" },
			{ COMMENTS_ENABLED: "0" },
		);
		const flags = await loadFlags(env);
		expect(flags.comments_enabled).toBe(true);
	});

	it("DB row beats a conflicting env var (DB off, env on)", async () => {
		const { env } = mkEnv(
			{ page_votes_enabled: "false" },
			{ PAGE_VOTES_ENABLED: "true" },
		);
		const flags = await loadFlags(env);
		expect(flags.page_votes_enabled).toBe(false);
	});

	it("falls back to the default when a stored row is junk", async () => {
		const { env } = mkEnv({ comments_enabled: "" });
		const flags = await loadFlags(env);
		// "" is treated as "no opinion" → default (true) applies.
		expect(flags.comments_enabled).toBe(true);
	});

	it("a row for one flag does not disturb the others", async () => {
		const { env } = mkEnv({ votes_enabled: "false" });
		const flags = await loadFlags(env);
		expect(flags.votes_enabled).toBe(false);
		expect(flags.comments_enabled).toBe(true);
		expect(flags.reactions_enabled).toBe(true);
	});
});

describe("loadFlags — KV cache", () => {
	it("populates the cache on a cold read", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(kv.store.has("settings:flags")).toBe(true);
	});

	it("serves a warm cache without touching D1", async () => {
		const { env, db } = mkEnv({ comments_enabled: "false" });
		const first = await loadFlags(env);
		expect(db.reads()).toBe(1);
		const second = await loadFlags(env);
		expect(db.reads()).toBe(1); // no further D1 read
		expect(second).toEqual(first);
	});

	it("a warm cache masks a changed DB row until busted", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		const before = await loadFlags(env);
		expect(before.comments_enabled).toBe(false);

		// Simulate an admin save writing a new value straight to the stub's
		// backing rows — without busting, the cache still wins.
		kv.store.set(
			"settings:flags",
			JSON.stringify({ ...before }), // unchanged cache entry
		);
		const stillCached = await loadFlags(env);
		expect(stillCached.comments_enabled).toBe(false);
	});
});

describe("bustFlagsCache", () => {
	it("deletes the cached resolved object", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(kv.store.has("settings:flags")).toBe(true);
		await bustFlagsCache(env);
		expect(kv.store.has("settings:flags")).toBe(false);
		expect(kv.deletes()).toBe(1);
	});

	it("forces a fresh D1 read on the next load", async () => {
		const { env, db } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(db.reads()).toBe(1);
		await bustFlagsCache(env);
		await loadFlags(env);
		expect(db.reads()).toBe(2);
	});
});

// -- route-level flag gating -------------------------------------------------
//
// The gate is the first thing each POST handler runs. With a pre-warmed cache
// disabling the flag, the handler returns 403 before touching D1 — so these
// don't need the full comment/user/ghost stub chain. We pre-seed the KV cache
// so loadFlags() resolves straight from it.

const mkGatedEnv = (cachedFlags: Partial<Record<FlagKey, boolean>>) => {
	const kv = makeKv();
	kv.store.set("settings:flags", JSON.stringify(cachedFlags));
	return {
		TREE_CACHE: kv,
		// DB present but should never be queried on the 403 path.
		DB: makeDb({}),
		IP_HASH_SECRET: "x".repeat(32),
		ANALYTICS: { writeDataPoint: () => {} },
		SESSIONS: { get: async () => null },
		RATE_LIMITS: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
	} as unknown as Bindings;
};

const postJson = (app: Hono, env: Bindings, body: unknown) =>
	app.request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
	);

describe("route gating — reactions", () => {
	it("403s reactions_disabled when reactions_enabled is off", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", reactions);
		const env = mkGatedEnv({ reactions_enabled: false });
		const res = await postJson(app, env, {
			comment_id: "01HC000000000000000000ABCD",
			kind: "like",
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"reactions_disabled",
		);
	});

	it("passes the gate (not 403-disabled) when reactions_enabled is on", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", reactions);
		const env = mkGatedEnv({ reactions_enabled: true });
		const res = await postJson(app, env, {}); // bad body → 400, not 403
		expect(res.status).not.toBe(403);
	});
});

describe("route gating — comments", () => {
	it("403s comments_disabled when comments_enabled is off", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
		const env = mkGatedEnv({ comments_enabled: false });
		const res = await postJson(app, env, { slug: "x", body: "hi" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"comments_disabled",
		);
	});
});
