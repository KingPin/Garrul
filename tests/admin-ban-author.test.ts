/**
 * One-click "Ban author" — admin route (POST /admin/api/users/:id).
 *
 * The ban mechanism itself is pre-existing; this covers the one-click affordance's
 * contract against REAL SQLite (every migration applied):
 *
 *   - an admin can ban a comment's author and the originating comment id is
 *     recorded in the audit row's meta (from_comment) for traceability;
 *   - a ban without from_comment still works and omits it from meta;
 *   - the action is admin-only — a mod session is rejected with 403;
 *   - banning a non-existent user returns 404 (surfaces stale UI / typos).
 *
 * The same-origin CSRF check in the admin middleware is satisfied with an Origin
 * header matching the request URL.
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

const makeSessions = () => ({
	async get(key: string) {
		if (key === `sess:${ADMIN_SID}`)
			return JSON.stringify({ user_id: ADMIN_ID, expires_at: 4_102_444_800_000 });
		if (key === `sess:${MOD_SID}`)
			return JSON.stringify({ user_id: MOD_ID, expires_at: 4_102_444_800_000 });
		return null;
	},
	async put() {},
	async delete() {},
});

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
	seedUser.run(TARGET_ID, "anon", null, "Spammer", 0, "user", 1_700_000_000_000);
	env = {
		DB: fresh.db,
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const ban = (
	body: unknown,
	opts: { sid?: string | null; origin?: string | null } = {},
) => {
	const { sid = ADMIN_SID, origin = "http://localhost" } = opts;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (sid) headers.cookie = `garrul_sess=${sid}`;
	if (origin) headers.origin = origin;
	return app().request(
		`/admin/api/users/${TARGET_ID}`,
		{ method: "POST", headers, body: JSON.stringify(body) },
		env as unknown as Record<string, unknown>,
		execCtx,
	);
};

const lastBanAudit = (): { action: string; meta: string | null } | undefined =>
	sqlite
		.prepare(
			"SELECT action, meta FROM audit_log WHERE target_kind = 'user' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { action: string; meta: string | null } | undefined;

const isBanned = (id: string): number =>
	(sqlite.prepare("SELECT is_banned FROM users WHERE id = ?").get(id) as {
		is_banned: number;
	}).is_banned;

describe("POST /admin/api/users/:id (one-click ban author)", () => {
	it("bans the author and records from_comment in the audit meta", async () => {
		const res = await ban({ banned: true, from_comment: "01HCOMMENT00000000000000CM" });
		expect(res.status).toBe(200);
		expect(isBanned(TARGET_ID)).toBe(1);
		const audit = lastBanAudit();
		expect(audit?.action).toBe("ban");
		const meta = JSON.parse(audit?.meta ?? "{}");
		expect(meta.from_comment).toBe("01HCOMMENT00000000000000CM");
		expect(meta.target_name).toBe("Spammer");
	});

	it("bans without from_comment and omits it from meta", async () => {
		const res = await ban({ banned: true });
		expect(res.status).toBe(200);
		const meta = JSON.parse(lastBanAudit()?.meta ?? "{}");
		expect(meta.from_comment).toBeUndefined();
		expect(meta.target_name).toBe("Spammer");
	});

	it("rejects a mod (admin-only)", async () => {
		const res = await ban({ banned: true, from_comment: "01HCOMMENT00000000000000CM" }, {
			sid: MOD_SID,
		});
		expect(res.status).toBe(403);
		expect(isBanned(TARGET_ID)).toBe(0);
	});

	it("rejects a cross-origin request (CSRF)", async () => {
		const res = await ban(
			{ banned: true, from_comment: "01HCOMMENT00000000000000CM" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		expect(isBanned(TARGET_ID)).toBe(0);
	});

	it("returns 404 for a non-existent target", async () => {
		const res = await app().request(
			"/admin/api/users/01HGHOST0000000000000GHOST",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `garrul_sess=${ADMIN_SID}`,
					origin: "http://localhost",
				},
				body: JSON.stringify({ banned: true }),
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
		expect(res.status).toBe(404);
	});
});
