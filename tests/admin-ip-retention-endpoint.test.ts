/**
 * POST /admin/api/ops/ip-retention — the on-demand sweep behind the Operator
 * card's "Sweep now" button.
 *
 * Exercised through the real Hono route against real SQLite, because the two
 * things worth pinning here are contracts between components rather than logic
 * inside one:
 *
 *   - The response body shape the Operator card's Alpine loop reads
 *     (`comments`, `reports`, `more`). The card self-recurses while `more` is
 *     true, so a renamed field is an infinite spinner, not a type error.
 *   - The window comes from the resolved setting, never from the request. An
 *     endpoint that accepted a caller-supplied day count would route around
 *     the Settings dial and its floor.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../src/routes/admin";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const DAY = 86_400_000;
const NOW = Date.now();

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";
const SLUG = "hello";

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
let env: Bindings;

const addComment = (id: string, ageDays: number) =>
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md,
			                       body_html, renderer_version, status, ip_hash,
			                       user_agent, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', 'iphash',
			         'ua', ?, 1)`,
		)
		.run(id, SLUG, MOD_ID, NOW - ageDays * DAY);

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const seedUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
		                    is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "github", "1", "Op", 1, "admin", NOW - 400 * DAY);
	seedUser.run(MOD_ID, "github", "2", "Mod", 0, "mod", NOW - 400 * DAY);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?,?,?,?)")
		.run(SLUG, "Hello", null, NOW - 400 * DAY);

	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const sweep = (opts: { sid?: string } = {}) => {
	const { sid = ADMIN_SID } = opts;
	return new Hono<{ Bindings: Bindings }>()
		.route("/admin", admin)
		.request(
			"/admin/api/ops/ip-retention",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `__Host-garrul_sess=${sid}`,
					origin: "http://localhost",
				},
				body: "{}",
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
};

const hashCount = (): number =>
	(
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM comments WHERE ip_hash IS NOT NULL")
			.get() as { n: number }
	).n;

const lastAudit = () =>
	sqlite
		.prepare(
			"SELECT action, meta FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.get() as { action: string; meta: string | null } | undefined;

describe("POST /admin/api/ops/ip-retention", () => {
	it("400s and changes nothing while retention is off", async () => {
		addComment("c-old", 400);

		const res = await sweep();

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "retention_disabled" });
		expect(hashCount()).toBe(1);
	});

	// The floor is the sweep's, not the setting's — a stored 1 is a legal
	// setting value that must still refuse.
	it("400s for a window below the floor", async () => {
		env.IP_HASH_RETENTION_DAYS = "1";
		addComment("c-old", 400);

		const res = await sweep();

		expect(res.status).toBe(400);
		expect(hashCount()).toBe(1);
	});

	it("sweeps on the resolved window and returns the shape the card reads", async () => {
		env.IP_HASH_RETENTION_DAYS = "30";
		addComment("c-old", 400);
		addComment("c-new", 2);

		const res = await sweep();

		expect(res.status).toBe(200);
		// Field names are the Operator card's Alpine contract: it accumulates
		// `comments` / `reports` and self-recurses while `more` is true.
		expect(await res.json()).toEqual({
			ok: true,
			comments: 1,
			reports: 0,
			more: false,
		});
		expect(hashCount()).toBe(1);
	});

	// Unrecoverable data, so "who drained the hashes" has to be answerable.
	it("audits a sweep that cleared rows", async () => {
		env.IP_HASH_RETENTION_DAYS = "30";
		addComment("c-old", 400);

		await sweep();

		const audit = lastAudit();
		expect(audit?.action).toBe("ip_retention.sweep");
		expect(JSON.parse(audit?.meta ?? "{}")).toMatchObject({
			retention_days: 30,
			comments: 1,
		});
	});

	it("writes no audit row when the sweep cleared nothing", async () => {
		env.IP_HASH_RETENTION_DAYS = "30";
		addComment("c-new", 2);

		const res = await sweep();

		expect(res.status).toBe(200);
		expect(lastAudit()).toBeUndefined();
	});

	// Admin-only, matching the other /api/ops endpoints: a mod can moderate
	// comments but not irreversibly erase the evidence behind them.
	it("rejects a mod", async () => {
		env.IP_HASH_RETENTION_DAYS = "30";
		addComment("c-old", 400);

		const res = await sweep({ sid: MOD_SID });

		expect(res.status).toBe(403);
		expect(hashCount()).toBe(1);
	});

	it("rejects a cross-origin POST", async () => {
		env.IP_HASH_RETENTION_DAYS = "30";
		addComment("c-old", 400);

		const res = await new Hono<{ Bindings: Bindings }>()
			.route("/admin", admin)
			.request(
				"/admin/api/ops/ip-retention",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						cookie: `__Host-garrul_sess=${ADMIN_SID}`,
						origin: "https://evil.example.com",
					},
					body: "{}",
				},
				env as unknown as Record<string, unknown>,
				execCtx,
			);

		expect(res.status).toBe(403);
		expect(hashCount()).toBe(1);
	});
});
