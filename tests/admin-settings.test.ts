/**
 * POST /admin/settings write-path tests.
 *
 * The render side (settings page HTML) and the read side (loadFlags /
 * loadNumbers) are covered elsewhere; this exercises the handler that
 * PERSISTS operator overrides — specifically the numeric branch added with
 * configurable pagination:
 *
 *   - numbers are validated, clamped into [min,max], and stored as text;
 *   - a non-numeric value is rejected 400 (`invalid_number:<key>`);
 *   - unknown keys are ignored (whitelist);
 *   - the numbers cache is busted but the flag cache is left alone when only
 *     numbers change (independent cache entries);
 *   - the write is audited;
 *   - "reset" clears both flag AND number keys.
 *
 * No Miniflare: hand-rolled D1 + KV stubs route by SQL substring / key, in
 * the same style as votes.test.ts. The admin gate (session → admin user) and
 * the same-origin CSRF check are satisfied with a seeded session + Origin
 * header.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { admin } from "../src/routes/admin";
import type { Bindings } from "../src/index";

const SID = "testsessionid";
const ADMIN_ID = "01HADMIN0000000000000000AB";

// D1 double: serves the admin user for the auth gate and captures every
// .run() (setSetting INSERTs, deleteSettings DELETE, audit INSERT) so tests
// can assert what was persisted.
const makeDb = () => {
	const runs: { sql: string; binds: unknown[] }[] = [];
	const chain = (sql: string) => ({
		_binds: [] as unknown[],
		bind(...args: unknown[]) {
			this._binds = args;
			return this;
		},
		async first() {
			if (sql.includes("FROM users WHERE id")) {
				return {
					id: ADMIN_ID,
					provider: "github",
					provider_id: "1",
					name: "Op",
					email: "op@example.com",
					avatar_url: null,
					is_admin: 1,
					is_banned: 0,
					role: "admin",
					created_at: 1_700_000_000_000,
				};
			}
			return null;
		},
		async all() {
			return { results: [] };
		},
		async run() {
			runs.push({ sql, binds: this._binds });
			return { meta: { changes: 1 } };
		},
	});
	return { db: { prepare: (sql: string) => chain(sql) }, runs };
};

const makeKv = (seed: Record<string, string> = {}) => {
	const store = new Map<string, string>(Object.entries(seed));
	const deletedKeys: string[] = [];
	return {
		store,
		deletedKeys,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			deletedKeys.push(key);
			store.delete(key);
		},
	};
};

const mkEnv = () => {
	const { db, runs } = makeDb();
	// Seed the version-check cache with a back-off entry so the admin
	// middleware's fire-and-forget refresh never attempts a GitHub fetch.
	const kv = makeKv({
		"meta:latest-release": JSON.stringify({ kind: "null", fetchedAt: 1 }),
		"meta:recent-releases": JSON.stringify({ kind: "null", fetchedAt: 1 }),
	});
	const sessions = {
		async get(key: string) {
			if (key === `sess:${SID}`) {
				return JSON.stringify({
					user_id: ADMIN_ID,
					expires_at: 4_102_444_800_000, // year 2100
				});
			}
			return null;
		},
		async put() {},
		async delete() {},
	};
	const env = {
		DB: db,
		TREE_CACHE: kv,
		SESSIONS: sessions,
	} as unknown as Bindings;
	return { env, kv, runs };
};

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

const postSettings = (
	env: Bindings,
	body: unknown,
	opts: { cookie?: boolean; origin?: string | null } = {},
) => {
	const { cookie = true, origin = "http://localhost" } = opts;
	const app = new Hono<{ Bindings: Bindings }>().route("/admin", admin);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cookie) headers.cookie = `garrul_sess=${SID}`;
	if (origin) headers.origin = origin;
	return app.request(
		"/admin/settings",
		{ method: "POST", headers, body: JSON.stringify(body) },
		env as unknown as Record<string, unknown>,
		execCtx as unknown as ExecutionContext,
	);
};

// settings INSERT binds are (key, value, updated_at).
const settingWrites = (runs: { sql: string; binds: unknown[] }[]) =>
	runs
		.filter((r) => r.sql.includes("INSERT INTO settings"))
		.map((r) => [r.binds[0], r.binds[1]] as [string, string]);

describe("POST /admin/settings — numeric writes", () => {
	it("stores an in-range number as text and busts only the numbers cache", async () => {
		const { env, kv, runs } = mkEnv();
		const res = await postSettings(env, { numbers: { comments_per_page: 10 } });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { numbers: Record<string, number> };
		expect(json.numbers.comments_per_page).toBe(10);

		expect(settingWrites(runs)).toContainEqual(["comments_per_page", "10"]);
		// Independent cache entries: numbers busted, flags untouched.
		expect(kv.deletedKeys).toContain("settings:numbers");
		expect(kv.deletedKeys).not.toContain("settings:flags");
	});

	it("clamps an over-max value before storing", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: 1_000_000 },
		});
		expect(res.status).toBe(200);
		// max is 200.
		expect(settingWrites(runs)).toContainEqual(["comments_per_page", "200"]);
	});

	it("clamps a negative value up to the minimum", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { replies_per_thread: -5 },
		});
		expect(res.status).toBe(200);
		// min is 0.
		expect(settingWrites(runs)).toContainEqual(["replies_per_thread", "0"]);
	});

	it("accepts a numeric string and truncates a decimal", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { auto_collapse_depth: "2", comments_per_page: 12.9 },
		});
		expect(res.status).toBe(200);
		const writes = settingWrites(runs);
		expect(writes).toContainEqual(["auto_collapse_depth", "2"]);
		expect(writes).toContainEqual(["comments_per_page", "12"]);
	});

	it("rejects a non-numeric value with 400 invalid_number:<key>", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: "lots" },
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("invalid_number:comments_per_page");
		// Nothing persisted on the rejected request.
		expect(settingWrites(runs)).toHaveLength(0);
	});

	it("ignores unknown number keys (whitelist)", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: 15, bogus_setting: 99 },
		});
		expect(res.status).toBe(200);
		const writes = settingWrites(runs);
		expect(writes).toContainEqual(["comments_per_page", "15"]);
		expect(writes.some(([k]) => k === "bogus_setting")).toBe(false);
	});

	it("400s when only unknown keys are supplied", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, { numbers: { bogus_setting: 99 } });
		expect(res.status).toBe(400);
		expect(settingWrites(runs)).toHaveLength(0);
	});

	it("audits the settings update", async () => {
		const { env, runs } = mkEnv();
		await postSettings(env, { numbers: { comments_per_page: 10 } });
		const audit = runs.find((r) => r.sql.includes("INSERT INTO audit_log"));
		expect(audit).toBeDefined();
		expect(audit!.binds).toContain("settings.update");
		expect(audit!.binds).toContain(ADMIN_ID);
	});
});

describe("POST /admin/settings — reset", () => {
	it("clears both flag and number keys and busts both caches", async () => {
		const { env, kv, runs } = mkEnv();
		const res = await postSettings(env, { reset: true });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { reset: boolean };
		expect(json.reset).toBe(true);

		const del = runs.find((r) => r.sql.includes("DELETE FROM settings"));
		expect(del).toBeDefined();
		// The delete binds every flag + number key.
		expect(del!.binds).toContain("comments_enabled");
		expect(del!.binds).toContain("comments_per_page");
		expect(del!.binds).toContain("auto_collapse_depth");

		expect(kv.deletedKeys).toContain("settings:flags");
		expect(kv.deletedKeys).toContain("settings:numbers");
	});
});

describe("POST /admin/settings — gate", () => {
	it("401s without a session cookie", async () => {
		const { env } = mkEnv();
		const res = await postSettings(env, { numbers: { comments_per_page: 10 } }, {
			cookie: false,
		});
		expect(res.status).toBe(401);
	});

	it("403s on an Origin mismatch (CSRF)", async () => {
		const { env } = mkEnv();
		const res = await postSettings(
			env,
			{ numbers: { comments_per_page: 10 } },
			{ origin: "https://evil.example.com" },
		);
		expect(res.status).toBe(403);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("origin_mismatch");
	});
});
