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
import { makeD1, makeKv } from "./helpers/admin-sqlite";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

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
	pending = [];
});
afterEach(() => uninstallMockCaches());

let pending: Promise<unknown>[];
const execCtx = {
	waitUntil(p: Promise<unknown>) {
		pending.push(p);
	},
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
	sqlite.prepare("SELECT id, status FROM comments ORDER BY rowid").all() as Array<{ id: string; status: string }>;

const verdicts = () =>
	sqlite.prepare("SELECT source, verdict, raw FROM spam_verdicts").all() as Array<{
		source: string;
		verdict: string;
		raw: string;
	}>;

// Clef-flash answers with P(spam) for the "spam" question.
const clef = (p: number) => ({ answers: { spam: { type: "noul", noul: p } } });
const aiSaying = (p: number) => ({
	SPAM_PROVIDER: "workers-ai",
	AI: { run: async () => clef(p) },
});

describe("POST /comments — anti-spam on create", () => {
	it("holds a comment the Workers AI classifier calls spam, recording its verdict", async () => {
		const res = await post({ body: "cheap pills here" }, aiSaying(0.97));
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["pending"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "spam"]]);
	});

	it("publishes a comment the classifier calls ham", async () => {
		const res = await post({ body: "nice write-up" }, aiSaying(0.03));
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["approved"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "ham"]]);
	});

	it("applies the SPAM_AI_THRESHOLD cut-off to the classifier score", async () => {
		// 0.6 is ham under the default of 70, so a pending row proves the env
		// value reached the classifier.
		const res = await post(
			{ body: "borderline" },
			{ ...aiSaying(0.6), SPAM_AI_THRESHOLD: "50" },
		);
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["pending"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "spam"]]);
	});

	it("lets a stored spam_ai_threshold override SPAM_AI_THRESHOLD", async () => {
		sqlite
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("spam_ai_threshold", "90", 1_700_000_000_000);
		const res = await post(
			{ body: "borderline" },
			{ ...aiSaying(0.6), SPAM_AI_THRESHOLD: "50" },
		);
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["approved"]);
		expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([["workers-ai", "ham"]]);
	});

	it("calls the Clef model a stored spam_ai_model names", async () => {
		sqlite
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("spam_ai_model", "clef", 1_700_000_000_000);
		const models: string[] = [];
		const res = await post(
			{ body: "nice write-up" },
			{
				SPAM_PROVIDER: "workers-ai",
				AI: {
					run: async (id: string) => {
						models.push(id);
						return clef(0.1);
					},
				},
			},
		);
		expect(res.status).toBe(201);
		expect(models).toEqual(["@cf/cloudflare/clef"]);
	});

	it("holds a first comment when moderate-on-first is on, and skips the classifier", async () => {
		let aiCalls = 0;
		const res = await post(
			{ body: "hello there" },
			{
				SPAM_FIRST_COMMENT_MODERATE: "true",
				SPAM_PROVIDER: "workers-ai",
				AI: { run: async () => { aiCalls++; return clef(0.03); } },
			},
		);
		expect(res.status).toBe(201);
		expect(stored().map((c) => c.status)).toEqual(["pending"]);
		const [heuristics] = verdicts();
		expect(heuristics?.source).toBe("heuristics");
		expect(JSON.parse(String(heuristics?.raw))).toMatchObject({ first_comment: { is_first: true } });
		expect(aiCalls).toBe(0);
	});

	it("keeps holding an author until one of their comments is approved", async () => {
		const extra = { SPAM_FIRST_COMMENT_MODERATE: "true" };
		await post({ body: "first" }, extra);
		await post({ body: "second, while the first still waits" }, extra);
		expect(stored().map((c) => c.status)).toEqual(["pending", "pending"]);

		sqlite.prepare("UPDATE comments SET status = 'spam' WHERE id = ?").run(stored()[0]!.id);
		await post({ body: "third, after a rejection" }, extra);
		expect(stored().map((c) => c.status)).toEqual(["spam", "pending", "pending"]);

		sqlite.prepare("UPDATE comments SET status = 'approved' WHERE id = ?").run(stored()[1]!.id);
		// Fresh caches: the fourth post would otherwise trip the per-user rate limit.
		uninstallMockCaches();
		installMockCaches();
		await post({ body: "fourth, after an approval" }, extra);
		expect(stored().map((c) => c.status)).toEqual(["spam", "approved", "pending", "approved"]);
	});

	it("refuses a filled honeypot and an oversized body without writing", async () => {
		expect((await post({ body: "hi", website: "https://bot.example" })).status).toBe(400);
		expect((await post({ body: "x".repeat(100_000) })).status).toBe(400);
		expect(stored()).toEqual([]);
	});

	it("records a decisions-provider verdict under its own source", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(clef(0.95)))) as typeof fetch;
		try {
			const res = await post(
				{ body: "cheap pills here" },
				{
					SPAM_PROVIDER: "decisions",
					SPAM_DECISIONS_API_KEY: "k",
					SPAM_DECISIONS_MODEL: "vendor/decider",
				},
			);
			expect(res.status).toBe(201);
			expect(stored().map((c) => c.status)).toEqual(["pending"]);
			expect(verdicts().map((v) => [v.source, v.verdict])).toEqual([
				["decisions", "spam"],
			]);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("asks the model a stored spam_decisions_model names, over the env value", async () => {
		sqlite
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
			.run("spam_decisions_model", "vendor/other", 1_700_000_000_000);
		const original = globalThis.fetch;
		const models: unknown[] = [];
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			if (String(url).includes("/decisions")) {
				models.push(JSON.parse(String(init.body)).model);
			}
			return new Response(JSON.stringify(clef(0.1)));
		}) as typeof fetch;
		try {
			const res = await post(
				{ body: "nice write-up" },
				{
					SPAM_PROVIDER: "decisions",
					SPAM_DECISIONS_API_KEY: "k",
					SPAM_DECISIONS_MODEL: "vendor/decider",
				},
			);
			expect(res.status).toBe(201);
			expect(models).toEqual(["vendor/other"]);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("POST /comments — who hears about a new comment", () => {
	const subscribe = (id: string, email: string, confirmed: number | null) =>
		sqlite
			.prepare(
				`INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirmed_at)
				 VALUES (?, ?, ?, ?, 1, ?)`,
			)
			.run(id, SLUG, email, `tok-${id}`, confirmed);

	it("queues confirmed subscribers of an approved comment, never the author", async () => {
		sqlite.prepare("UPDATE users SET email = 'me@example.com' WHERE id = ?").run(USER);
		subscribe("s-other", "other@example.com", 1);
		subscribe("s-self", "me@example.com", 1);
		subscribe("s-unconfirmed", "later@example.com", null);
		const res = await post({ body: "hello subscribers" });
		expect(res.status).toBe(201);
		await Promise.all(pending);
		const queued = sqlite.prepare("SELECT subscription_id FROM notifications").all();
		expect(queued).toEqual([{ subscription_id: "s-other" }]);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM moderator_notifications").get()).toEqual({ n: 0 });
	});

	it("tells moderators, not subscribers, about a held comment when moderator email is on", async () => {
		subscribe("s-other", "other@example.com", 1);
		const res = await post(
			{ body: "cheap pills here" },
			{ ...aiSaying(0.97), MODERATOR_EMAIL_ENABLED: "true" },
		);
		expect(res.status).toBe(201);
		await Promise.all(pending);
		expect(sqlite.prepare("SELECT reason FROM moderator_notifications").all()).toEqual([
			{ reason: "pending" },
		]);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
	});

	it("writes no moderator row for a held comment when moderator email is off", async () => {
		await post({ body: "cheap pills here" }, aiSaying(0.97));
		await Promise.all(pending);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM moderator_notifications").get()).toEqual({ n: 0 });
	});
});
