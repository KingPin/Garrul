/**
 * PATCH /admin/api/webhooks/:id — write-only signing secret, plus the
 * no-store header the admin middleware now sets on every response.
 *
 * The edit form no longer renders the stored secret back to the browser, so
 * the request body has to carry three distinct states and the route has to
 * keep them distinct all the way to the UPDATE:
 *
 *   absent  → leave the stored secret alone   (no `secret = ?` in the SQL)
 *   null    → remove signing
 *   string  → rotate (validated for length)
 *
 * Collapsing absent into null is the interesting bug: it would silently unsign
 * an endpoint every time an admin edited its URL, and the receiver would start
 * accepting unsigned deliveries without anyone touching the signing field.
 *
 * Same hand-rolled D1/KV stub style as admin-settings.test.ts — no Miniflare.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { admin } from "../src/routes/admin";
import type { Bindings } from "../src/index";

const SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const HOOK_ID = "01HWEBHOOK00000000000000AB";
const STORED_SECRET = "whsec_stored_0123456789";

const makeDb = (storedSecret: string | null = STORED_SECRET) => {
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
			if (sql.includes("FROM webhook_endpoints WHERE id")) {
				return {
					id: HOOK_ID,
					url: "https://example.org/hook",
					secret: storedSecret,
					events: null,
					adapter: "generic",
					enabled: 1,
					fail_count: 0,
					disabled_at: null,
					created_at: 1_700_000_000_000,
					updated_at: 1_700_000_000_000,
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

const mkEnv = (storedSecret?: string | null) => {
	const { db, runs } = makeDb(storedSecret);
	// Back-off entries so the version-check middleware never fetches GitHub.
	const cache = new Map<string, string>([
		["meta:latest-release", JSON.stringify({ kind: "null", fetchedAt: 1 })],
		["meta:recent-releases", JSON.stringify({ kind: "null", fetchedAt: 1 })],
	]);
	const env = {
		DB: db,
		TREE_CACHE: {
			async get(key: string, type?: "json") {
				const raw = cache.get(key);
				if (raw == null) return null;
				return type === "json" ? JSON.parse(raw) : raw;
			},
			async put(key: string, value: string) {
				cache.set(key, value);
			},
			async delete(key: string) {
				cache.delete(key);
			},
		},
		SESSIONS: {
			async get(key: string) {
				return key === `sess:${SID}`
					? JSON.stringify({ user_id: ADMIN_ID, expires_at: 4_102_444_800_000 })
					: null;
			},
			async put() {},
			async delete() {},
		},
	} as unknown as Bindings;
	return { env, runs };
};

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

const patchHook = (env: Bindings, body: unknown) => {
	const app = new Hono<{ Bindings: Bindings }>().route("/admin", admin);
	return app.request(
		`/admin/api/webhooks/${HOOK_ID}`,
		{
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				cookie: `__Host-garrul_sess=${SID}`,
				origin: "http://localhost",
			},
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
		execCtx as unknown as ExecutionContext,
	);
};

const hookUpdate = (runs: { sql: string; binds: unknown[] }[]) =>
	runs.find((r) => r.sql.includes("UPDATE webhook_endpoints"));

const auditMeta = (runs: { sql: string; binds: unknown[] }[]) => {
	const row = runs.find((r) => r.sql.includes("INSERT INTO audit_log"));
	const raw = row?.binds.find(
		(b) => typeof b === "string" && b.startsWith("{"),
	) as string | undefined;
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

const BASE = { url: "https://example.org/hook2", adapter: "generic", enabled: true };

describe("PATCH /admin/api/webhooks/:id — secret is write-only", () => {
	it("leaves the stored secret alone when the field is absent", async () => {
		const { env, runs } = mkEnv();
		const res = await patchHook(env, BASE);
		expect(res.status).toBe(200);
		const upd = hookUpdate(runs);
		expect(upd).toBeDefined();
		// The whole point: no secret column in the SET clause at all.
		expect(upd?.sql).not.toContain("secret = ?");
		expect(upd?.sql).toContain("url = ?");
		expect(auditMeta(runs)).toMatchObject({
			has_secret: true,
			secret_rotated: false,
		});
	});

	it("removes signing on an explicit null", async () => {
		const { env, runs } = mkEnv();
		const res = await patchHook(env, { ...BASE, secret: null });
		expect(res.status).toBe(200);
		const upd = hookUpdate(runs);
		expect(upd?.sql).toContain("secret = ?");
		expect(upd?.binds).toContain(null);
		expect(auditMeta(runs)).toMatchObject({
			has_secret: false,
			secret_rotated: true,
		});
	});

	it("rotates to a new secret when one is supplied", async () => {
		const { env, runs } = mkEnv();
		const next = "whsec_rotated_9876543210";
		const res = await patchHook(env, { ...BASE, secret: next });
		expect(res.status).toBe(200);
		const upd = hookUpdate(runs);
		expect(upd?.sql).toContain("secret = ?");
		expect(upd?.binds).toContain(next);
		expect(auditMeta(runs)).toMatchObject({
			has_secret: true,
			secret_rotated: true,
		});
		// The secret itself must never reach the audit log.
		expect(JSON.stringify(auditMeta(runs))).not.toContain(next);
	});

	it("treats an empty string like an absent field, not like null", async () => {
		// A blank input on the edit form must not unsign the endpoint.
		const { env, runs } = mkEnv();
		const res = await patchHook(env, { ...BASE, secret: "" });
		expect(res.status).toBe(200);
		expect(hookUpdate(runs)?.sql).not.toContain("secret = ?");
	});

	it("rejects a too-short rotation without writing anything", async () => {
		const { env, runs } = mkEnv();
		const res = await patchHook(env, { ...BASE, secret: "short" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "secret_too_short" });
		expect(hookUpdate(runs)).toBeUndefined();
	});

	it("reports has_secret false when none was stored and none supplied", async () => {
		const { env, runs } = mkEnv(null);
		const res = await patchHook(env, BASE);
		expect(res.status).toBe(200);
		expect(auditMeta(runs)).toMatchObject({
			has_secret: false,
			secret_rotated: false,
		});
	});
});

describe("admin responses are not cacheable", () => {
	it("sets no-store on every admin route", async () => {
		const { env } = mkEnv();
		const res = await patchHook(env, BASE);
		expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
	});
});
