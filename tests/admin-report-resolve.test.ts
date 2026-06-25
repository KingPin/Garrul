/**
 * Report resolution lifecycle — admin route + queue filter.
 *
 * The reader-side report insert is covered in report-api.test.ts; this covers
 * the *moderator* half end-to-end against REAL SQLite (every migration applied):
 *
 *   - POST /admin/api/comments/:id/reports/resolve flips every OPEN report on a
 *     comment to 'resolved', returns the affected count, and audits
 *     report.resolve with resolved_count in the meta;
 *   - resolving drops the comment out of the "reported" queue filter
 *     (adminListComments({ reported: true })) and zeroes the badge count;
 *   - a fresh report from a DIFFERENT reporter re-opens the reported view
 *     (a re-report from the same ip_hash stays deduped — the row persists as
 *     'resolved' and ON CONFLICT DO NOTHING keeps it that way, by design);
 *   - auth + CSRF guards: no session → 401, cross-origin → 403, unknown id → 404.
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
import {
	insertComment,
	adminListComments,
	countOpenReportsByComment,
} from "../src/db/queries";
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

const SID = "a".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const AUTHOR_ID = "01HAUTHOR000000000000000AB";

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
		if (key !== `sess:${SID}`) return null;
		return JSON.stringify({ user_id: ADMIN_ID, expires_at: 4_102_444_800_000 });
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
let db: any;
let env: Bindings;

const seedReport = (commentId: string, ipHash: string): void => {
	sqlite
		.prepare(
			`INSERT INTO reports
			   (id, comment_id, reporter_user_id, reporter_ip_hash, reason, status, created_at)
			 VALUES (?, ?, NULL, ?, NULL, 'open', ?)`,
		)
		.run(`rep_${ipHash}`, commentId, ipHash, 1_700_000_000_000);
};

const seedComment = async (): Promise<string> => {
	const c = await insertComment(db, {
		post_slug: "hello",
		parent_id: null,
		user_id: AUTHOR_ID,
		body_md: "a comment",
		body_html: "<p>a comment</p>",
		renderer_version: 1,
		status: "approved",
		ip_hash: null,
		user_agent: null,
	});
	return c.id;
};

const reportedIds = async (): Promise<string[]> =>
	(await adminListComments(db, { reported: true }, 50, null, null)).map(
		(r) => r.id,
	);

const reportStatuses = (commentId: string): string[] =>
	(
		sqlite
			.prepare("SELECT status FROM reports WHERE comment_id = ? ORDER BY id")
			.all(commentId) as { status: string }[]
	).map((r) => r.status);

const lastResolveAudit = ():
	| { action: string; meta: string | null }
	| undefined =>
	sqlite
		.prepare(
			"SELECT action, meta FROM audit_log WHERE action = 'report.resolve' ORDER BY created_at DESC LIMIT 1",
		)
		.get() as { action: string; meta: string | null } | undefined;

beforeEach(() => {
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	db = fresh.db;
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'github', '1', 'Op', 1, 'admin', ?)`,
		)
		.run(ADMIN_ID, 1_700_000_000_000);
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, 'anon', NULL, 'Author', ?)",
		)
		.run(AUTHOR_ID, 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, created_at) VALUES ('hello', ?)")
		.run(1_700_000_000_000);
	env = {
		DB: db,
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const resolve = (
	id: string,
	opts: { cookie?: boolean; origin?: string | null } = {},
) => {
	const { cookie = true, origin = "http://localhost" } = opts;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cookie) headers.cookie = `garrul_sess=${SID}`;
	if (origin) headers.origin = origin;
	return app().request(
		`/admin/api/comments/${id}/reports/resolve`,
		{ method: "POST", headers, body: "{}" },
		env as unknown as Record<string, unknown>,
		execCtx,
	);
};

describe("POST /admin/api/comments/:id/reports/resolve", () => {
	it("resolves open reports, drops the comment from the reported filter, audits report.resolve", async () => {
		const id = await seedComment();
		seedReport(id, "ip-a");
		seedReport(id, "ip-b");

		// Pre-condition: surfaced in the reported queue with two open reports.
		expect(await reportedIds()).toContain(id);
		expect((await countOpenReportsByComment(db, [id]))[id]).toBe(2);

		const res = await resolve(id);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id, resolved: 2 });

		// Post-condition: rows flipped, dropped from the queue, badge zeroed.
		expect(reportStatuses(id)).toEqual(["resolved", "resolved"]);
		expect(await reportedIds()).not.toContain(id);
		expect((await countOpenReportsByComment(db, [id]))[id]).toBeUndefined();

		const audit = lastResolveAudit();
		expect(audit?.action).toBe("report.resolve");
		const meta = JSON.parse(audit?.meta ?? "{}");
		expect(meta.resolved_count).toBe(2);
		expect(meta.post_slug).toBe("hello");
	});

	it("re-appears in the reported view when a different reporter flags it again", async () => {
		const id = await seedComment();
		seedReport(id, "ip-a");
		await resolve(id);
		expect(await reportedIds()).not.toContain(id);

		// A new reporter (distinct ip_hash) opens a fresh report.
		seedReport(id, "ip-c");
		expect(await reportedIds()).toContain(id);
		expect((await countOpenReportsByComment(db, [id]))[id]).toBe(1);
	});

	it("is a no-op (resolved: 0) when the comment has no open reports", async () => {
		const id = await seedComment();
		const res = await resolve(id);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id, resolved: 0 });
	});

	it("rejects an unauthenticated request", async () => {
		const id = await seedComment();
		seedReport(id, "ip-a");
		const res = await resolve(id, { cookie: false });
		expect(res.status).toBe(401);
		expect(reportStatuses(id)).toEqual(["open"]);
	});

	it("rejects a cross-origin request (CSRF)", async () => {
		const id = await seedComment();
		seedReport(id, "ip-a");
		const res = await resolve(id, { origin: "https://evil.example" });
		expect(res.status).toBe(403);
		expect(reportStatuses(id)).toEqual(["open"]);
	});

	it("returns 404 for a non-existent comment", async () => {
		const res = await resolve("01HNOPE0000000000000000000");
		expect(res.status).toBe(404);
	});
});
