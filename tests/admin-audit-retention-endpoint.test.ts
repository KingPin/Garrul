/**
 * POST /admin/api/ops/audit-retention — the manual drain for the audit-log
 * prune, so an operator who just set a window doesn't wait out the backlog one
 * cron tick at a time.
 *
 * What's worth pinning at the route level (the sweep itself is covered in
 * audit-retention.test.ts):
 *
 *   - It refuses when the resolved window is off or below the floor, rather than
 *     inventing a window of its own.
 *   - It is admin-only and origin-gated, like every other state-changing route.
 *   - It audits itself. This is the one action that can delete its own evidence,
 *     so the record of it running has to survive — and it does, because the new
 *     row is written now and is far newer than any cutoff it could delete.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../src/routes/admin";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { MIN_AUDIT_RETENTION_DAYS } from "../src/db/audit-retention";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const DAY = 86_400_000;
const NOW = Date.now();

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";

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

const makeKv = () => {
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

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

let sqlite: DatabaseSync;
let baseEnv: Record<string, unknown>;

const addAudit = (id: string, createdAt: number) =>
	sqlite
		.prepare(
			`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id,
			                        reason, meta, created_at)
			 VALUES (?, ?, 'ban', 'user', 'someone', NULL, '{}', ?)`,
		)
		.run(id, ADMIN_ID, createdAt);

const rows = (): { id: string; action: string }[] =>
	sqlite
		.prepare("SELECT id, action FROM audit_log ORDER BY created_at, id")
		.all() as { id: string; action: string }[];

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const seedUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'github', ?, ?, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "1", "Op", 1, "admin", NOW - 500 * DAY);
	seedUser.run(MOD_ID, "2", "Mod", 0, "mod", NOW - 500 * DAY);

	baseEnv = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	};
});

afterEach(() => uninstallMockCaches());

const sweep = (
	opts: { sid?: string; days?: string; origin?: string } = {},
) => {
	const { sid = ADMIN_SID, days, origin = "http://localhost" } = opts;
	const env = days === undefined
		? baseEnv
		: { ...baseEnv, AUDIT_LOG_RETENTION_DAYS: days };
	return new Hono<{ Bindings: Bindings }>()
		.route("/admin", admin)
		.request(
			"/admin/api/ops/audit-retention",
			{
				method: "POST",
				headers: { cookie: `__Host-garrul_sess=${sid}`, origin },
				body: "{}",
			},
			env,
			execCtx,
		);
};

describe("POST /admin/api/ops/audit-retention", () => {
	it("refuses when retention is off, without touching anything", async () => {
		addAudit("a-old", NOW - 400 * DAY);

		const res = await sweep();

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "retention_disabled",
			retention_days: 0,
			min_days: MIN_AUDIT_RETENTION_DAYS,
		});
		expect(rows()).toHaveLength(1);
	});

	// The endpoint must not pick a window of its own when the configured one is
	// unusable — that would turn a typo into a purge.
	it("refuses a window below the floor", async () => {
		addAudit("a-old", NOW - 400 * DAY);

		const res = await sweep({ days: "7" });

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "retention_disabled" });
		expect(rows()).toHaveLength(1);
	});

	it("prunes past the window and reports what it did", async () => {
		addAudit("a-old", NOW - 400 * DAY);
		addAudit("a-older", NOW - 500 * DAY);
		addAudit("a-recent", NOW - 2 * DAY);

		const res = await sweep({ days: "30" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, deleted: 2, more: false });
		// The recent row survives, and the sweep's own audit row joins it.
		expect(rows().map((r) => r.action)).toEqual(["ban", "audit_retention.sweep"]);
	});

	it("audits the sweep with the window and the row count", async () => {
		addAudit("a-old", NOW - 400 * DAY);

		await sweep({ days: "30" });

		const audit = sqlite
			.prepare(
				"SELECT admin_id, action, target_kind, meta FROM audit_log WHERE action = 'audit_retention.sweep'",
			)
			.get() as {
			admin_id: string;
			action: string;
			target_kind: string;
			meta: string;
		};
		expect(audit).toMatchObject({
			admin_id: ADMIN_ID,
			target_kind: "system",
		});
		expect(JSON.parse(audit.meta)).toEqual({ retention_days: 30, deleted: 1 });
	});

	// No row means nothing happened; an audit entry for a no-op is noise that
	// makes the log harder to read.
	it("writes no audit row when there was nothing to prune", async () => {
		addAudit("a-recent", NOW - 2 * DAY);

		const res = await sweep({ days: "30" });

		expect(await res.json()).toEqual({ ok: true, deleted: 0, more: false });
		expect(rows().map((r) => r.id)).toEqual(["a-recent"]);
	});

	it("rejects a mod", async () => {
		addAudit("a-old", NOW - 400 * DAY);

		const res = await sweep({ sid: MOD_SID, days: "30" });

		expect(res.status).toBe(403);
		expect(rows()).toHaveLength(1);
	});

	it("rejects a cross-origin request", async () => {
		addAudit("a-old", NOW - 400 * DAY);

		const res = await sweep({ days: "30", origin: "https://evil.example" });

		expect(res.status).toBe(403);
		expect(rows()).toHaveLength(1);
	});
});
