/**
 * "Sign out everywhere" — admin route (POST /admin/api/users/:id/revoke-sessions).
 *
 * Against REAL SQLite (every migration applied):
 *
 *   - an admin can revoke another user's sessions: the revocation epoch is
 *     stamped and the action lands in the audit log with an id-only meta;
 *   - targeting yourself is "sign out everywhere else": the stamp still lands
 *     but the response mints a replacement session that postdates it, so the
 *     browser doing the revoking stays signed in;
 *   - the action is admin-only — a mod session is rejected with 403;
 *   - a cross-origin request is rejected (CSRF);
 *   - a non-existent target returns 404 and stamps nothing.
 *
 * The same-origin CSRF check in the admin middleware is satisfied with an
 * Origin header matching the request URL.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../src/routes/admin";
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

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";
const TARGET_ID = "01HTARGET00000000000000TGT";

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return { sqlite, db: makeD1(sqlite) };
};

// Map-backed, unlike the fixed stub in the ban suite: the route under test
// writes the revocation stamp and mints a replacement record, and the
// assertions need to see both.
const makeSessions = () => {
	const store = new Map<string, string>([
		[
			`sess:${ADMIN_SID}`,
			JSON.stringify({
				user_id: ADMIN_ID,
				issued_at: 1_700_000_000_000,
				expires_at: 4_102_444_800_000,
			}),
		],
		[
			`sess:${MOD_SID}`,
			JSON.stringify({
				user_id: MOD_ID,
				issued_at: 1_700_000_000_000,
				expires_at: 4_102_444_800_000,
			}),
		],
	]);
	return {
		store,
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
	};
};

const makeKv = () => {
	const store = new Map<string, string>([
		["meta:latest-release", JSON.stringify({ kind: "null", fetchedAt: 1 })],
		["meta:recent-releases", JSON.stringify({ kind: "null", fetchedAt: 1 })],
	]);
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
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

let sqlite: DatabaseSync;
let sessions: ReturnType<typeof makeSessions>;
let env: Bindings;

beforeEach(() => {
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	const seedUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "github", "1", "Op", 1, "admin", 1_700_000_000_000);
	seedUser.run(MOD_ID, "github", "2", "Mod", 0, "mod", 1_700_000_000_000);
	seedUser.run(TARGET_ID, "anon", null, "Victim", 0, "user", 1_700_000_000_000);
	sessions = makeSessions();
	env = {
		DB: fresh.db,
		TREE_CACHE: makeKv(),
		SESSIONS: sessions,
	} as unknown as Bindings;
});

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const revoke = (
	targetId: string,
	opts: { sid?: string | null; origin?: string | null } = {},
) => {
	const { sid = ADMIN_SID, origin = "http://localhost" } = opts;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (sid) headers.cookie = `__Host-garrul_sess=${sid}`;
	if (origin) headers.origin = origin;
	return app().request(
		`/admin/api/users/${targetId}/revoke-sessions`,
		{ method: "POST", headers, body: "{}" },
		env as unknown as Record<string, unknown>,
		execCtx,
	);
};

const lastAudit = ():
	| { action: string; target_id: string | null; meta: string | null }
	| undefined =>
	sqlite
		.prepare(
			"SELECT action, target_id, meta FROM audit_log ORDER BY created_at DESC LIMIT 1",
		)
		.get() as
		| { action: string; target_id: string | null; meta: string | null }
		| undefined;

describe("POST /admin/api/users/:id/revoke-sessions", () => {
	it("stamps the target's revocation epoch and audits with an id-only meta", async () => {
		const res = await revoke(TARGET_ID);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, self: false });
		expect(sessions.store.has(`sessrev:${TARGET_ID}`)).toBe(true);
		// Another user's revoke never touches the caller's own session.
		expect(sessions.store.has(`sess:${ADMIN_SID}`)).toBe(true);
		expect(sessions.store.has(`sessrev:${ADMIN_ID}`)).toBe(false);
		const audit = lastAudit();
		expect(audit?.action).toBe("user.revoke_sessions");
		expect(audit?.target_id).toBe(TARGET_ID);
		// No names, no session ids — target_id only. See tests/audit-log-pii.test.ts.
		expect(JSON.parse(audit?.meta ?? "{}")).toEqual({});
	});

	it("targeting yourself signs out everywhere else and re-issues this browser", async () => {
		const res = await revoke(ADMIN_ID);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, self: true });

		const stamp = sessions.store.get(`sessrev:${ADMIN_ID}`);
		expect(stamp).toBeDefined();

		// The old record is gone and a replacement postdating the stamp exists.
		expect(sessions.store.has(`sess:${ADMIN_SID}`)).toBe(false);
		const setCookie = res.headers.get("set-cookie") ?? "";
		const newSid = /__Host-garrul_sess=([0-9a-f]{64})/.exec(setCookie)?.[1];
		expect(newSid).toBeDefined();
		const record = JSON.parse(sessions.store.get(`sess:${newSid}`)!) as {
			user_id: string;
			issued_at: number;
		};
		expect(record.user_id).toBe(ADMIN_ID);
		expect(record.issued_at).toBeGreaterThan(Number(stamp));

		const audit = lastAudit();
		expect(audit?.action).toBe("user.revoke_sessions");
		expect(audit?.target_id).toBe(ADMIN_ID);
	});

	it("rejects a mod (admin-only)", async () => {
		const res = await revoke(TARGET_ID, { sid: MOD_SID });
		expect(res.status).toBe(403);
		expect(sessions.store.has(`sessrev:${TARGET_ID}`)).toBe(false);
	});

	it("rejects a cross-origin request (CSRF)", async () => {
		const res = await revoke(TARGET_ID, { origin: "https://evil.example" });
		expect(res.status).toBe(403);
		expect(sessions.store.has(`sessrev:${TARGET_ID}`)).toBe(false);
	});

	it("returns 404 for a non-existent target and stamps nothing", async () => {
		const res = await revoke("01HGHOST0000000000000GHOST");
		expect(res.status).toBe(404);
		expect(
			[...sessions.store.keys()].filter((k) => k.startsWith("sessrev:")),
		).toEqual([]);
		expect(lastAudit()).toBeUndefined();
	});
});
