/**
 * Harness for admin-route tests against REAL SQLite (every migration applied).
 *
 * Seeds one admin and one mod, each with a live session, and returns a
 * `request` helper that sends a same-origin request (the admin CSRF check
 * wants an Origin matching the request URL on POST/PATCH/DELETE).
 */
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../../src/routes/admin";
import type { Bindings } from "../../src/index";

const MIGRATIONS_DIR = join(__dirname, "../../src/db/migrations");

export const ADMIN_ID = "01HADMIN0000000000000000AB";
export const MOD_ID = "01HMOD00000000000000000MOD";
export const ADMIN_SID = "a".repeat(64);
export const MOD_SID = "b".repeat(64);

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
	async batch(stmts: Array<{ run(): Promise<unknown> }>) {
		const out = [];
		for (const s of stmts) out.push(await s.run());
		return out;
	},
});

export const makeKv = (entries: Array<[string, string]> = []) => {
	const store = new Map(entries);
	return {
		store,
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

const session = (userId: string) =>
	JSON.stringify({
		user_id: userId,
		issued_at: 1_700_000_000_000,
		expires_at: 4_102_444_800_000,
	});

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

export const adminHarness = (extraEnv: Record<string, unknown> = {}) => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const addUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'github', ?, ?, ?, ?, ?)`,
	);
	addUser.run(ADMIN_ID, "1", "Op", 1, "admin", Date.now());
	addUser.run(MOD_ID, "2", "Mod", 0, "mod", Date.now());

	// A fresh version-check entry, so no request reaches api.github.com.
	const env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv([
			["meta:latest-release", JSON.stringify({ kind: "null", fetchedAt: Date.now() })],
			["meta:recent-releases", JSON.stringify({ kind: "null", fetchedAt: Date.now() })],
		]),
		SESSIONS: makeKv([
			[`sess:${ADMIN_SID}`, session(ADMIN_ID)],
			[`sess:${MOD_SID}`, session(MOD_ID)],
		]),
		...extraEnv,
	} as unknown as Bindings;

	const app = new Hono<{ Bindings: Bindings }>().route("/admin", admin);

	const request = (
		path: string,
		opts: { method?: string; body?: unknown; sid?: string | undefined } = {},
	) => {
		const { method = "GET", body, sid = ADMIN_SID } = opts;
		const headers: Record<string, string> = {
			cookie: `__Host-garrul_sess=${sid}`,
			origin: "http://localhost",
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		return app.request(
			path,
			{
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
	};

	return { sqlite, env, request };
};
