/**
 * Telegram operator bot.
 *
 * Two layers:
 *   1. renderTelegramBody — the outbound notification body (shape, HTML
 *      escaping, event-tailored inline keyboard). Stub DB, no worker.
 *   2. The inbound /telegram/webhook route, against REAL SQLite (every
 *      migration applied) with the Bot API fetch mocked:
 *        - rejects a missing / wrong secret token (403), accepts the right one;
 *        - a callback runs the moderation action and writes an audit row ONLY
 *          when the linked user has the required role (mod to moderate, admin
 *          to ban) — rejected otherwise, no audit row, no status change;
 *        - /start <code> redeems a KV link token and writes telegram_links;
 *        - a slash command returns read-only data and mutates nothing.
 *
 * fireWebhook is mocked so moderation doesn't reach the delivery pipeline; the
 * Bot API client's global fetch is mocked so no network is touched.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/webhook", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/webhook")>()),
	fireWebhook: vi.fn(),
}));

import { encodeCallback } from "../src/lib/telegram";
import type { WebhookPayload } from "../src/lib/webhook";
import { renderTelegramBody } from "../src/lib/webhook-adapters";

// --------------------------------------------------------------------------
// Part 1: renderTelegramBody — stub DB (mirrors webhook-adapters.test.ts).
// --------------------------------------------------------------------------

type Row = Record<string, unknown> | null;

const makeStubDb = (rows: { comments: Row; users: Row; posts: Row }) => {
	let lastSql = "";
	const stub = {
		prepare(sql: string) {
			lastSql = sql;
			return {
				bind() {
					return this;
				},
				async first() {
					if (lastSql.includes("FROM comments")) return rows.comments;
					if (lastSql.includes("FROM users")) return rows.users;
					if (lastSql.includes("FROM posts")) return rows.posts;
					return null;
				},
				async all() {
					return { results: [] };
				},
				async run() {
					return {};
				},
			};
		},
	};
	return stub as unknown as Parameters<typeof renderTelegramBody>[0];
};

const payload = (over: Partial<WebhookPayload> = {}): WebhookPayload => ({
	event: "comment.posted",
	comment_id: "01HC000000000000000000",
	post_slug: "hello-world",
	user_id: "01HU000000000000000000",
	ts: 1700000000000,
	...over,
});

const stubRows = {
	comments: {
		id: "01HC000000000000000000",
		post_slug: "hello-world",
		body_md: "Hello *world*",
		body_html: "<p>hello</p>",
		renderer_version: 1,
		status: "approved",
		edited_at: null,
		deleted_at: null,
		ip_hash: null,
		user_agent: null,
		created_at: 1_700_000_000_000,
		parent_id: null,
		user_id: "01HU000000000000000000",
	},
	users: {
		id: "01HU000000000000000000",
		name: "Alice",
		avatar_url: null,
		provider: "github",
		email: null,
		is_admin: 0,
		is_banned: 0,
		role: "user",
		created_at: 0,
		updated_at: 0,
	},
	posts: {
		slug: "hello-world",
		title: "Hello, world!",
		url: null,
		created_at: 0,
	},
};

describe("renderTelegramBody", () => {
	it("returns a sendMessage body with HTML parse_mode and an inline keyboard", async () => {
		const out = await renderTelegramBody(makeStubDb(stubRows), payload(), {
			chatId: "12345",
		});
		const body = JSON.parse(out);
		expect(body.parse_mode).toBe("HTML");
		expect(body.chat_id).toBe("12345");
		expect(typeof body.text).toBe("string");
		expect(body.text).toContain("Alice");
		expect(Array.isArray(body.reply_markup.inline_keyboard)).toBe(true);
		// Default keyboard offers Approve + Spam, Delete + Ban.
		const labels = body.reply_markup.inline_keyboard
			.flat()
			.map((b: { text: string }) => b.text);
		expect(labels.some((l: string) => l.includes("Approve"))).toBe(true);
		expect(labels.some((l: string) => l.includes("Ban"))).toBe(true);
	});

	it("HTML-escapes &, <, > in the snippet (no raw markup reaches Telegram)", async () => {
		const rows = {
			...stubRows,
			comments: { ...stubRows.comments, body_md: "<script>alert(1)&" },
		};
		const body = JSON.parse(
			await renderTelegramBody(makeStubDb(rows), payload()),
		);
		expect(body.text).toContain("&lt;script&gt;");
		expect(body.text).toContain("&amp;");
		expect(body.text).not.toContain("<script>");
	});

	it("tailors the keyboard to the event (spam → Not spam, reported → Resolve)", async () => {
		const labelsFor = async (event: WebhookPayload["event"]) => {
			const body = JSON.parse(
				await renderTelegramBody(makeStubDb(stubRows), payload({ event })),
			);
			return body.reply_markup.inline_keyboard
				.flat()
				.map((b: { text: string }) => b.text) as string[];
		};
		const spam = await labelsFor("comment.spam");
		expect(spam.some((l) => l.includes("Not spam"))).toBe(true);
		expect(spam.some((l) => l.includes("Approve"))).toBe(false);

		const reported = await labelsFor("comment.reported");
		expect(reported.some((l) => l.includes("Resolve"))).toBe(true);
	});

	it("omits chat_id when not supplied (dispatcher always adds it)", async () => {
		const body = JSON.parse(
			await renderTelegramBody(makeStubDb(stubRows), payload()),
		);
		expect(body.chat_id).toBeUndefined();
	});
});

// --------------------------------------------------------------------------
// Part 2: inbound route — real SQLite + mocked Bot API fetch.
// --------------------------------------------------------------------------

import { insertComment } from "../src/db/queries";
import type { Bindings } from "../src/index";
import { issueTelegramLinkToken, telegram } from "../src/routes/telegram";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const makeD1 = (db: DatabaseSync): any => {
	const mk = (sql: string) => {
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
	};
	return {
		prepare: mk,
		// upsertTelegramLink uses db.batch([...]) for an atomic delete+insert.
		async batch(stmts: { run: () => Promise<unknown> }[]) {
			const out: unknown[] = [];
			for (const s of stmts) out.push(await s.run());
			return out;
		},
	};
};

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return { sqlite, db: makeD1(sqlite) };
};

// Map-backed KV: link tokens are issued/redeemed against this. Ignores TTL.
const mapKv = () => {
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

const SECRET = "test-webhook-secret";

let sqlite: DatabaseSync;
let db: any;
let oauthKv: ReturnType<typeof mapKv>;
// Captured Bot API calls: { method, body }.
let tgCalls: { method: string; body: Record<string, unknown> }[];

const mkEnv = (): Bindings =>
	({
		DB: db,
		RATE_LIMITS: openKv(),
		OAUTH_STATE: oauthKv,
		TREE_CACHE: openKv(),
		ANALYTICS: { writeDataPoint() {} },
		IP_HASH_SECRET: "test-secret",
		ENV: "dev",
		PUBLIC_BASE_URL: "https://comments.example.com",
		TELEGRAM_BOT_TOKEN: "123:ABC",
		TELEGRAM_WEBHOOK_SECRET: SECRET,
	}) as unknown as Bindings;

const app = () =>
	new Hono<{ Bindings: Bindings }>().route("/telegram", telegram);

const post = (env: Bindings, update: unknown, secret: string | null) =>
	app().request(
		"/telegram/webhook",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(secret == null
					? {}
					: { "x-telegram-bot-api-secret-token": secret }),
			},
			body: JSON.stringify(update),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const seedUser = (id: string, role: "user" | "mod" | "admin", name = "Mod") => {
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, role, is_admin, created_at) VALUES (?, 'github', ?, ?, ?, ?, ?)",
		)
		.run(id, id, name, role, role === "admin" ? 1 : 0, 1_700_000_000_000);
};

const seedComment = async (status = "pending"): Promise<string> => {
	const c = await insertComment(db, {
		post_slug: "hello",
		parent_id: null,
		user_id: "01HAUTHOR000000000000000AB",
		body_md: "a comment",
		body_html: "<p>a comment</p>",
		renderer_version: 1,
		status,
		ip_hash: null,
		user_agent: null,
	});
	return c.id;
};

const linkOperator = async (tgUserId: string, userId: string) => {
	const { upsertTelegramLink } = await import("../src/db/queries");
	await upsertTelegramLink(db, {
		tg_user_id: tgUserId,
		tg_chat_id: "555",
		user_id: userId,
	});
};

const auditCount = (action: string): number =>
	(
		sqlite
			.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
			.get(action) as { n: number }
	).n;

const commentStatus = (id: string): string =>
	(
		sqlite.prepare("SELECT status FROM comments WHERE id = ?").get(id) as {
			status: string;
		}
	).status;

beforeEach(() => {
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	db = fresh.db;
	oauthKv = mapKv();
	tgCalls = [];
	// FK targets for insertComment.
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, 'anon', NULL, 'Author', ?)",
		)
		.run("01HAUTHOR000000000000000AB", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, created_at) VALUES ('hello', ?)")
		.run(1_700_000_000_000);

	// Mock the Bot API client's global fetch — capture method + body, no network.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { body?: string }) => {
			const method = String(url).split("/").pop() ?? "";
			let body: Record<string, unknown> = {};
			try {
				body = init?.body ? JSON.parse(init.body) : {};
			} catch {
				/* ignore */
			}
			tgCalls.push({ method, body });
			return new Response(JSON.stringify({ ok: true, result: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("POST /telegram/webhook — auth", () => {
	it("rejects a missing secret header with 403", async () => {
		const res = await post(mkEnv(), { update_id: 1 }, null);
		expect(res.status).toBe(403);
	});

	it("rejects a wrong secret with 403", async () => {
		const res = await post(mkEnv(), { update_id: 1 }, "nope");
		expect(res.status).toBe(403);
	});

	it("accepts the correct secret and acks an empty update with 200", async () => {
		const res = await post(mkEnv(), { update_id: 1 }, SECRET);
		expect(res.status).toBe(200);
	});
});

describe("POST /telegram/webhook — callback moderation + role gate", () => {
	const callbackUpdate = (tgUserId: string, data: string) => ({
		update_id: 2,
		callback_query: {
			id: "cbq1",
			from: { id: Number(tgUserId) },
			message: {
				message_id: 10,
				chat: { id: 555 },
				text: "alert",
			},
			data,
		},
	});

	it("applies the action and writes an audit row when the linked user is a mod", async () => {
		seedUser("01HMOD0000000000000000000A", "mod");
		await linkOperator("42", "01HMOD0000000000000000000A");
		const id = await seedComment("pending");

		const res = await post(
			mkEnv(),
			callbackUpdate("42", encodeCallback("approve", id)),
			SECRET,
		);
		expect(res.status).toBe(200);
		expect(commentStatus(id)).toBe("approved");
		expect(auditCount("approve")).toBe(1);
		// Acknowledged the tap.
		expect(tgCalls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
	});

	it("refuses to ban when the linked user is only a mod (no audit, no ban)", async () => {
		seedUser("01HMOD0000000000000000000A", "mod");
		await linkOperator("42", "01HMOD0000000000000000000A");
		const id = await seedComment("approved");

		await post(
			mkEnv(),
			callbackUpdate("42", encodeCallback("ban", id)),
			SECRET,
		);

		const banned = (
			sqlite
				.prepare(
					"SELECT is_banned FROM users WHERE id = '01HAUTHOR000000000000000AB'",
				)
				.get() as { is_banned: number }
		).is_banned;
		expect(banned).toBe(0);
		expect(auditCount("ban")).toBe(0);
	});

	it("allows an admin to ban the comment author", async () => {
		seedUser("01HADMIN00000000000000000A", "admin");
		await linkOperator("99", "01HADMIN00000000000000000A");
		const id = await seedComment("approved");

		await post(
			mkEnv(),
			callbackUpdate("99", encodeCallback("ban", id)),
			SECRET,
		);

		const banned = (
			sqlite
				.prepare(
					"SELECT is_banned FROM users WHERE id = '01HAUTHOR000000000000000AB'",
				)
				.get() as { is_banned: number }
		).is_banned;
		expect(banned).toBe(1);
	});

	it("rejects a callback from an unlinked Telegram user (no action)", async () => {
		const id = await seedComment("pending");
		await post(
			mkEnv(),
			callbackUpdate("7", encodeCallback("approve", id)),
			SECRET,
		);
		expect(commentStatus(id)).toBe("pending");
		expect(auditCount("comment.approve")).toBe(0);
	});
});

describe("POST /telegram/webhook — /start linking", () => {
	const startUpdate = (tgUserId: string, code: string) => ({
		update_id: 3,
		message: {
			message_id: 11,
			chat: { id: 777 },
			from: { id: Number(tgUserId) },
			text: `/start ${code}`,
		},
	});

	it("redeems a valid token and writes a telegram_links row", async () => {
		seedUser("01HMOD0000000000000000000A", "mod");
		const code = await issueTelegramLinkToken(
			oauthKv as unknown as KVNamespace,
			"01HMOD0000000000000000000A",
		);

		const res = await post(mkEnv(), startUpdate("42", code), SECRET);
		expect(res.status).toBe(200);

		const link = sqlite
			.prepare(
				"SELECT user_id, tg_user_id FROM telegram_links WHERE tg_user_id = '42'",
			)
			.get() as { user_id: string; tg_user_id: string } | undefined;
		expect(link?.user_id).toBe("01HMOD0000000000000000000A");
	});

	it("does not link on an invalid / expired code", async () => {
		seedUser("01HMOD0000000000000000000A", "mod");
		await post(mkEnv(), startUpdate("42", "deadbeef".repeat(6)), SECRET);
		const n = (
			sqlite.prepare("SELECT COUNT(*) AS n FROM telegram_links").get() as {
				n: number;
			}
		).n;
		expect(n).toBe(0);
	});
});

describe("POST /telegram/webhook — slash commands are read-only", () => {
	const cmdUpdate = (tgUserId: string, text: string) => ({
		update_id: 4,
		message: {
			message_id: 12,
			chat: { id: 555 },
			from: { id: Number(tgUserId) },
			text,
		},
	});

	it("/queue returns data for a linked mod and mutates nothing", async () => {
		seedUser("01HMOD0000000000000000000A", "mod");
		await linkOperator("42", "01HMOD0000000000000000000A");
		await seedComment("pending");

		const res = await post(mkEnv(), cmdUpdate("42", "/queue"), SECRET);
		expect(res.status).toBe(200);
		// Replied with a sendMessage; no audit rows written by a read command.
		expect(tgCalls.some((c) => c.method === "sendMessage")).toBe(true);
		const audits = (
			sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as {
				n: number;
			}
		).n;
		expect(audits).toBe(0);
	});

	it("a slash command from an unlinked user replies but does not run", async () => {
		const res = await post(mkEnv(), cmdUpdate("7", "/stats"), SECRET);
		expect(res.status).toBe(200);
		// It still answers (the not-linked notice), but writes no audit.
		const audits = (
			sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as {
				n: number;
			}
		).n;
		expect(audits).toBe(0);
	});
});
