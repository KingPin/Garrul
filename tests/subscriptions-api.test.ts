/**
 * POST /api/v1/subscribe — response shape (M6).
 *
 * The response used to mirror the stored `confirmed_at`, so a `"confirmed"`
 * answer told an unauthenticated caller that the address is already subscribed
 * to this post. That path also sends no mail, which made it a *silent* probe:
 * the victim never saw anything. It also returned `subscription_id`, a ULID, so
 * the reply leaked roughly when they had subscribed.
 *
 * Real SQLite + the mock Cache API (the rate limiter's backend) + a fetch stub
 * standing in for Resend, so "was an email sent" is observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscriptions } from "../src/routes/api.subscriptions";
import { confirmSubscription, upsertSubscription } from "../src/db/queries";
import { makeKv } from "./helpers/kv";
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

const SLUG = "oracle";
const EMAIL = "victim@example.com";

let sqlite: DatabaseSync;
let env: Bindings;
let sent: string[];

beforeEach(() => {
	installMockCaches();
	sent = [];
	vi.stubGlobal("fetch", async (url: string) => {
		sent.push(String(url));
		return new Response("{}", { status: 200 });
	});

	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Oracle", null, 1_700_000_000_000);

	env = {
		DB: makeD1(sqlite),
		// The route resolves the confirmation-email caps through loadNumbers.
		TREE_CACHE: makeKv(),
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		PUBLIC_BASE_URL: "https://comments.example",
		EMAIL_FROM: "no-reply@example.com",
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
	} as unknown as Bindings;
});

afterEach(() => {
	uninstallMockCaches();
	vi.unstubAllGlobals();
});

// The subscribe bucket is 1 request per 10s per IP hash, so back-to-back cases
// have to arrive from different addresses or the second one is a 429.
const subscribe = (body: unknown, ip = "203.0.113.1") =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", subscriptions)
		.request(
			"/",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": ip,
				},
				body: JSON.stringify(body),
			},
			env as unknown as Record<string, unknown>,
		);

type Payload = {
	ok?: boolean;
	status?: string;
	subscription_id?: string;
	message?: string;
};

describe("POST /subscribe — response is not a subscription oracle", () => {
	it("answers pending for a brand-new address", async () => {
		const res = await subscribe({ post_slug: SLUG, email: EMAIL });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Payload;
		expect(body.status).toBe("pending");
		expect(body.subscription_id).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	it("answers pending for an already-confirmed address, byte for byte", async () => {
		const sub = await upsertSubscription(
			env.DB,
			SLUG,
			EMAIL,
			"tok",
			"confirm-tok",
			false,
		);
		await confirmSubscription(env.DB, sub.id);
		sent = [];

		const res = await subscribe({ post_slug: SLUG, email: EMAIL });
		const body = (await res.json()) as Payload;
		expect(body.status).toBe("pending");
		expect(body.subscription_id).toBeUndefined();
		// No mail on this branch — which is exactly why the reply must not
		// distinguish it. The probe stays silent either way.
		expect(sent).toHaveLength(0);
	});

	it("returns the same payload for a fresh and an existing address", async () => {
		const first = await (
			await subscribe({ post_slug: SLUG, email: EMAIL }, "203.0.113.1")
		).text();
		const second = await (
			await subscribe({ post_slug: SLUG, email: EMAIL }, "203.0.113.2")
		).text();
		expect(second).toBe(first);
	});
});

describe("POST /subscribe — post_slug is held to the read side's alphabet", () => {
	// The slug is stored verbatim, becomes the mail-subject fallback when the
	// post has no title, and is rendered on the confirm/unsubscribe pages. A
	// length cap alone let CR, LF and angle brackets through.
	it.each([
		["a CR/LF pair", "oracle\r\nBcc: x@y.z"],
		["angle brackets", "<img src=x onerror=alert(1)>"],
		["a space", "two words"],
		["a query string", "oracle?x=1"],
		["over 200 chars", "a".repeat(201)],
		["empty", ""],
	])("400s a slug with %s and writes nothing", async (_label, post_slug) => {
		const res = await subscribe({ post_slug, email: EMAIL });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"Invalid post identifier.",
		);
		const rows = sqlite
			.prepare("SELECT COUNT(*) AS n FROM subscriptions")
			.get() as { n: number };
		expect(rows.n).toBe(0);
		expect(sent).toEqual([]);
	});

	it("still accepts the full slug alphabet", async () => {
		const res = await subscribe({ post_slug: "blog/2026/Hello_World-1.html", email: EMAIL });
		expect(res.status).toBe(200);
		const row = sqlite
			.prepare("SELECT post_slug FROM subscriptions WHERE email = ?")
			.get(EMAIL) as { post_slug: string };
		expect(row.post_slug).toBe("blog/2026/Hello_World-1.html");
	});
});
