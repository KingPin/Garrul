/**
 * Per-post comment close/open — admin route (POST /admin/api/posts/close).
 *
 * Exercises the operator freeze toggle against REAL SQLite (every migration
 * applied) so upsertPost → setPostClosed → audit runs end-to-end:
 *
 *   - a mod can close a thread (posts.closed = 1) and an audit row is written
 *     with action "post.close";
 *   - reopening flips it back and audits "post.open";
 *   - a thread with no comments yet can still be pre-closed (post row created);
 *   - auth + input guards: no session → 401, bad slug / body → 400.
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

// node:sqlite → D1 adapter (same shape as thread-closure-api.test.ts).
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
		// Seed the version-check cache so the admin middleware never fetches.
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
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, ?, ?, ?, 1, 'admin', ?)`,
		)
		.run(ADMIN_ID, "github", "1", "Op", 1_700_000_000_000);
	env = {
		DB: fresh.db,
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const close = (
	body: unknown,
	opts: { cookie?: boolean; origin?: string | null } = {},
) => {
	const { cookie = true, origin = "http://localhost" } = opts;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cookie) headers.cookie = `garrul_sess=${SID}`;
	if (origin) headers.origin = origin;
	return app().request(
		"/admin/api/posts/close",
		{ method: "POST", headers, body: JSON.stringify(body) },
		env as unknown as Record<string, unknown>,
		execCtx,
	);
};

const postClosed = (slug: string): number | null => {
	const row = sqlite
		.prepare("SELECT closed FROM posts WHERE slug = ?")
		.get(slug) as { closed: number } | undefined;
	return row ? row.closed : null;
};

const auditActions = (): string[] =>
	(
		sqlite.prepare("SELECT action FROM audit_log ORDER BY created_at").all() as {
			action: string;
		}[]
	).map((r) => r.action);

describe("POST /admin/api/posts/close", () => {
	it("closes a thread, sets posts.closed, and audits post.close", async () => {
		const res = await close({ slug: "hello-world", closed: true });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { closed: boolean; slug: string };
		expect(json.closed).toBe(true);
		expect(postClosed("hello-world")).toBe(1);
		expect(auditActions()).toContain("post.close");
	});

	it("reopens a thread and audits post.open", async () => {
		await close({ slug: "hello-world", closed: true });
		const res = await close({ slug: "hello-world", closed: false });
		expect(res.status).toBe(200);
		expect(postClosed("hello-world")).toBe(0);
		expect(auditActions()).toContain("post.open");
	});

	it("pre-closes a thread that has no comments yet (creates the post row)", async () => {
		expect(postClosed("brand-new")).toBeNull();
		const res = await close({ slug: "brand-new", closed: true });
		expect(res.status).toBe(200);
		expect(postClosed("brand-new")).toBe(1);
	});

	it("rejects an unauthenticated request", async () => {
		const res = await close({ slug: "hello-world", closed: true }, { cookie: false });
		expect(res.status).toBe(401);
	});

	it("rejects a cross-origin request (CSRF)", async () => {
		const res = await close(
			{ slug: "hello-world", closed: true },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
	});

	it("rejects a malformed slug", async () => {
		const res = await close({ slug: "bad slug!", closed: true });
		expect(res.status).toBe(400);
	});

	it("rejects a non-boolean closed value", async () => {
		const res = await close({ slug: "hello-world", closed: "yes" });
		expect(res.status).toBe(400);
	});
});
