/**
 * POST /api/v1/comments — the create-path anti-spam decisions on real SQLite.
 *
 * Drives the parts of evaluateSpam the edit suite can't reach: the Workers AI
 * classifier (a stubbed AI binding, no network), moderate-on-first-comment,
 * and the cheap rejections (honeypot, oversized body) that must refuse before
 * any row is written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
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
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

const SID = "a".repeat(64);
const USER = "01HU000000000000000000";
const ADMIN_SID = "c".repeat(64);
const ADMIN = "01HU0000000000000000AD";
const SLUG = "edited";

const makeSessions = () => ({
	async get(key: string) {
		const userId =
			key === `sess:${SID}` ? USER : key === `sess:${ADMIN_SID}` ? ADMIN : null;
		if (!userId) return null;
		return JSON.stringify({ user_id: userId, expires_at: 4_102_444_800_000 });
	},
	async put() {},
	async delete() {},
});

let sqlite: DatabaseSync;
let env: Bindings;

const baseEnv = (): Record<string, unknown> => ({
	DB: makeD1(sqlite),
	TREE_CACHE: makeKv(),
	SESSIONS: makeSessions(),
	ANALYTICS: { writeDataPoint() {} },
	ENV: "dev",
	EDIT_WINDOW_MINUTES: "15",
	IP_HASH_SECRET: "test-secret",
	// Link heuristic off, so each test turns on exactly the check it drives.
	SPAM_LINK_THRESHOLD: "-1",
});

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const user = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	user.run(USER, "anon", null, "Tester", 0, "user", 1_700_000_000_000);
	user.run(ADMIN, "github", "9", "Op", 1, "admin", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Edited", "https://blog.example/edited", 1_700_000_000_000);
	env = baseEnv() as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const post = (body: Record<string, unknown>, extraEnv: Record<string, unknown> = {}) =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", comments)
		.request(
			"/",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `garrul_sess=${SID}`,
				},
				body: JSON.stringify({ slug: SLUG, ...body }),
			},
			{ ...(env as unknown as Record<string, unknown>), ...extraEnv },
			execCtx,
		);

const stored = () =>
	sqlite.prepare("SELECT id, status FROM comments").all() as Array<{ id: string; status: string }>;

const verdicts = () =>
	sqlite.prepare("SELECT source, verdict, raw FROM spam_verdicts").all() as Array<{
		source: string;
		verdict: string;
		raw: string;
	}>;

const aiSaying = (answer: string) => ({
	SPAM_PROVIDER: "workers-ai",
	AI: { run: async () => ({ response: answer }) },
});

describe("POST /comments — anti-spam on create", () => {
	it("holds a comment the Workers AI classifier calls spam, recording its verdict", async () => {
		const res = await post({ body: "cheap pills here" }, aiSaying("SPAM"));
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["pending"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "spam"]]);
	});

	it("publishes a comment the classifier calls ham", async () => {
		const res = await post({ body: "nice write-up" }, aiSaying("HAM"));
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["approved"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "ham"]]);
	});

	it("holds a first comment when moderate-on-first is on, and skips the classifier", async () => {
		let aiCalls = 0;
		const res = await post(
			{ body: "hello there" },
			{
				SPAM_FIRST_COMMENT_MODERATE: "true",
				SPAM_PROVIDER: "workers-ai",
				AI: { run: async () => { aiCalls++; return { response: "HAM" }; } },
			},
		);
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["pending"]);
		const [heuristics] = verdicts();
		expect(heuristics?.source).toBe("heuristics");
		expect(JSON.parse(String(heuristics?.raw))).toMatchObject({ first_comment: { is_first: true } });
		expect(aiCalls).toBe(0);
	});

	it("refuses a filled honeypot and an oversized body without writing", async () => {
		expect((await post({ body: "hi", website: "https://bot.example" })).status).toBe(400);
		expect((await post({ body: "x".repeat(100_000) })).status).toBe(400);
		expect(stored()).toEqual([]);
	});
});
