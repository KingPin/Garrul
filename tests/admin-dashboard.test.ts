/**
 * Admin dashboard (GET /admin) against REAL SQLite (every migration applied).
 *
 * The page fans out to seven aggregate queries plus the resolved settings in
 * one Promise.all, so a single render proves every query parses against the
 * real schema and that its counts reach the page. The route is a moderation
 * surface: a mod session renders it.
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

const MOD_SID = "b".repeat(64);
const MOD_ID = "01HMOD00000000000000000MOD";
const SLUG = "hello";

const makeKv = (entries: Array<[string, string]>) => {
	const store = new Map(entries);
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

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

let env: Bindings;

beforeEach(() => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const now = Date.now();
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'github', '2', 'Mod', 0, 'mod', ?)`,
		)
		.run(MOD_ID, now);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?,?,?,?)")
		.run(SLUG, "Hello", null, now);
	const addComment = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md,
		                       body_html, renderer_version, status, ip_hash,
		                       user_agent, created_at, depth)
		 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, ?, 'iphash', 'ua', ?, 1)`,
	);
	addComment.run("c-approved", SLUG, MOD_ID, "approved", now - 1000);
	addComment.run("c-pending", SLUG, MOD_ID, "pending", now - 2000);
	addComment.run("c-spam", SLUG, MOD_ID, "spam", now - 3000);

	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv([
			["meta:latest-release", JSON.stringify({ kind: "null", fetchedAt: Date.now() })],
			["meta:recent-releases", JSON.stringify({ kind: "null", fetchedAt: Date.now() })],
		]),
		SESSIONS: makeKv([
			[
				`sess:${MOD_SID}`,
				JSON.stringify({
					user_id: MOD_ID,
					issued_at: 1_700_000_000_000,
					expires_at: 4_102_444_800_000,
				}),
			],
		]),
	} as unknown as Bindings;
});

describe("GET /admin (dashboard)", () => {
	it("renders the overview counts for a mod session", async () => {
		const res = await new Hono<{ Bindings: Bindings }>()
			.route("/admin", admin)
			.request(
				"/admin",
				{ headers: { cookie: `__Host-garrul_sess=${MOD_SID}` } },
				env as unknown as Record<string, unknown>,
				execCtx,
			);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain(
			'<div class="v">3</div><div class="l">total comments</div>',
		);
		expect(html).toContain(
			'<div class="stat warn"><div class="v">1</div><div class="l">pending</div>',
		);
		expect(html).toContain(
			'<div class="stat bad"><div class="v">1</div><div class="l">spam</div>',
		);
		expect(html).toContain("Review 1 pending comment(s)");
	});
});
