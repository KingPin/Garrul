/**
 * Reader reporting — API endpoint (POST /api/v1/comments/:id/report).
 *
 * Run against REAL SQLite (node:sqlite, every migration applied) so the
 * insertReport dedup (UNIQUE comment_id, reporter_ip_hash) is exercised for
 * real, plus:
 *
 *   - a fresh report returns { ok: true } and writes one row;
 *   - a duplicate from the same network is a silent no-op (still { ok: true },
 *     no second row, webhook NOT re-fired);
 *   - the per-IP-hash rate-limit blocks rapid repeats with 429;
 *   - reporting a non-existent comment returns { ok: true } (no enumeration);
 *   - a new report fires the comment.reported webhook.
 *
 * fireWebhook is mocked so we can assert it's called exactly when a NEW report
 * lands (and not on a duplicate) without standing up a real delivery pipeline.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

vi.mock("../src/lib/webhook", () => ({ fireWebhook: vi.fn() }));

import { reports } from "../src/routes/api.reports";
import { insertComment } from "../src/db/queries";
import { fireWebhook } from "../src/lib/webhook";
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

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return { sqlite, db: makeD1(sqlite) };
};

// Counting KV: records request stamps, so the rate-limit actually triggers on
// the second rapid call (short bucket default = 1 / 10s).
const countingKv = () => {
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

// Always-empty KV: rate-limit reads see no prior requests, so every call is
// allowed. Used to isolate the DB-level dedup from the rate-limit.
const openKv = () => ({
	async get() {
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
let db: any;

const mkEnv = (rateLimits: unknown): Bindings =>
	({
		DB: db,
		RATE_LIMITS: rateLimits,
		TREE_CACHE: openKv(),
		SESSIONS: { async get() { return null; }, async put() {}, async delete() {} },
		ANALYTICS: { writeDataPoint() {} },
		IP_HASH_SECRET: "test-secret",
		ENV: "dev",
	}) as unknown as Bindings;

const seedComment = async (): Promise<string> => {
	const c = await insertComment(db, {
		post_slug: "hello",
		parent_id: null,
		user_id: "01HAUTHOR000000000000000AB",
		body_md: "a comment",
		body_html: "<p>a comment</p>",
		renderer_version: 1,
		status: "approved",
		ip_hash: null,
		user_agent: null,
	});
	return c.id;
};

const app = () => new Hono<{ Bindings: Bindings }>().route("/", reports);

const report = (env: Bindings, id: string, body: unknown = {}) =>
	app().request(
		`/${id}/report`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const reportRowCount = (commentId: string): number =>
	(
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM reports WHERE comment_id = ?")
			.get(commentId) as { n: number }
	).n;

beforeEach(() => {
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	db = fresh.db;
	// FK targets for insertComment: an author user and the post row.
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, 'anon', NULL, 'Author', ?)",
		)
		.run("01HAUTHOR000000000000000AB", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, created_at) VALUES ('hello', ?)")
		.run(1_700_000_000_000);
	(fireWebhook as Mock).mockClear();
});

describe("POST /api/v1/comments/:id/report", () => {
	it("records a fresh report and fires the comment.reported webhook", async () => {
		const id = await seedComment();
		const res = await report(mkEnv(openKv()), id, { reason: "spam link" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(reportRowCount(id)).toBe(1);
		expect(fireWebhook).toHaveBeenCalledTimes(1);
		expect((fireWebhook as Mock).mock.calls[0][2]).toMatchObject({
			event: "comment.reported",
			comment_id: id,
			post_slug: "hello",
		});
	});

	it("dedupes a second report from the same network (no new row, no webhook)", async () => {
		const id = await seedComment();
		// openKv → rate-limit never blocks, so both calls reach insertReport and
		// the UNIQUE(comment_id, ip_hash) is what makes the second a no-op.
		const env = mkEnv(openKv());
		await report(env, id, { reason: "first" });
		(fireWebhook as Mock).mockClear();
		const res = await report(env, id, { reason: "second" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(reportRowCount(id)).toBe(1);
		expect(fireWebhook).not.toHaveBeenCalled();
	});

	it("rate-limits rapid repeats from the same IP with 429", async () => {
		const id = await seedComment();
		const env = mkEnv(countingKv());
		const first = await report(env, id);
		expect(first.status).toBe(200);
		const second = await report(env, id);
		expect(second.status).toBe(429);
		// The blocked call never reached insertReport.
		expect(reportRowCount(id)).toBe(1);
	});

	it("returns ok for a non-existent comment without inserting (no enumeration)", async () => {
		const res = await report(mkEnv(openKv()), "01HNOPE0000000000000000000");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(fireWebhook).not.toHaveBeenCalled();
	});

	it("caps an over-long reason instead of rejecting", async () => {
		const id = await seedComment();
		const res = await report(mkEnv(openKv()), id, { reason: "x".repeat(5000) });
		expect(res.status).toBe(200);
		const row = sqlite
			.prepare("SELECT reason FROM reports WHERE comment_id = ?")
			.get(id) as { reason: string };
		expect(row.reason.length).toBe(300);
	});
});
