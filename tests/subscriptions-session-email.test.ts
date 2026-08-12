/**
 * POST /api/v1/subscribe — the address may come from the session.
 *
 * The widget renders an email field only for anonymous visitors; a signed-in
 * reader gets the "notify me" checkbox alone, on the stated assumption that
 * the server already knows where to write. It did not: the handler required
 * `email` in the body, so ticking the box did nothing at all for every OAuth
 * reader, and the provider-verified auto-confirm fast path — which exists
 * precisely for them — was unreachable from the widget.
 *
 * What has to hold now:
 *   - signed-in + no `email` → subscribes the session address
 *   - github/google → auto-confirmed, no confirmation mail
 *   - a provider that doesn't vouch for the inbox → still double-opt-in
 *   - anonymous + no `email` → still a 400; the session is the only source
 *   - banned → 403 before anything is written
 *
 * Real SQLite + the mock Cache API + a fetch stub for Resend, so "was mail
 * sent" is observable — same harness as subscriptions-api.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscriptions } from "../src/routes/api.subscriptions";
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

// Session IDs are validated against /^[0-9a-f]{64}$/ before KV is touched, so
// a readable label here would be rejected as malformed and read as anonymous —
// which is exactly the bug under test, silently passing.
const sid = (n: string) => n.repeat(64).slice(0, 64);

const GH_ID = "u-github";
const GH_SID = sid("a");
const GH_EMAIL = "reader@example.com";

const TW_ID = "u-twitter";
const TW_SID = sid("b");
const TW_EMAIL = "birdsite@example.com";

const BANNED_ID = "u-banned";
const BANNED_SID = sid("c");

const NO_EMAIL_ID = "u-noemail";
const NO_EMAIL_SID = sid("d");

let sqlite: DatabaseSync;
let env: Bindings;
let sent: string[];

beforeEach(async () => {
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

	const seed = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, is_admin, is_banned, created_at)
		 VALUES (?, ?, ?, ?, ?, 0, ?, 1700000000000)`,
	);
	seed.run(GH_ID, "github", "1", "Reader", GH_EMAIL, 0);
	// X/Twitter's OAuth 2.0 returns no email, so an address attached to that
	// account was typed by hand somewhere — the provider never vouched for it.
	seed.run(TW_ID, "twitter", "2", "Birdsite", TW_EMAIL, 0);
	seed.run(BANNED_ID, "github", "3", "Spammer", "spam@example.com", 1);
	// A provider that returned no address at all: nothing to fall back to.
	seed.run(NO_EMAIL_ID, "github", "4", "Ghost", null, 0);

	const sessions = makeKv();
	const far = 4_102_444_800_000;
	for (const [sid, uid] of [
		[GH_SID, GH_ID],
		[TW_SID, TW_ID],
		[BANNED_SID, BANNED_ID],
		[NO_EMAIL_SID, NO_EMAIL_ID],
	]) {
		await sessions.put(
			`sess:${sid}`,
			JSON.stringify({ user_id: uid, issued_at: 1, expires_at: far }),
		);
	}

	env = {
		DB: makeD1(sqlite),
		SESSIONS: sessions,
		TREE_CACHE: makeKv(),
		// "dev" also selects the unprefixed cookie name the requests below send.
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

// The subscribe bucket is 1 request per 10s per IP hash, so each case needs
// its own address or the second one is a 429.
const subscribe = (body: unknown, opts: { sid?: string; ip?: string } = {}) =>
	new Hono<{ Bindings: Bindings }>().route("/", subscriptions).request(
		"/",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": opts.ip ?? "203.0.113.1",
				...(opts.sid ? { cookie: `garrul_sess=${opts.sid}` } : {}),
			},
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
	);

const rowFor = (email: string) =>
	sqlite
		.prepare("SELECT email, confirmed_at FROM subscriptions WHERE post_slug = ? AND email = ?")
		.get(SLUG, email) as { email: string; confirmed_at: number | null } | undefined;

describe("POST /subscribe — signed-in callers may omit the address", () => {
	it("subscribes the session address when the body has none", async () => {
		const res = await subscribe({ post_slug: SLUG }, { sid: GH_SID });
		expect(res.status).toBe(200);
		expect(rowFor(GH_EMAIL)?.email).toBe(GH_EMAIL);
	});

	it("auto-confirms a provider-verified address, and sends no mail", async () => {
		await subscribe({ post_slug: SLUG }, { sid: GH_SID });
		expect(rowFor(GH_EMAIL)?.confirmed_at).not.toBeNull();
		// The whole point of the fast path: the provider already proved inbox
		// control, so no confirmation email goes out and no send budget is spent.
		expect(sent).toHaveLength(0);
	});

	it("keeps double-opt-in for a provider that never vouched for the inbox", async () => {
		await subscribe({ post_slug: SLUG }, { sid: TW_SID });
		expect(rowFor(TW_EMAIL)?.confirmed_at).toBeNull();
		expect(sent).toHaveLength(1);
	});

	it("still rejects an anonymous caller that sends no address", async () => {
		const res = await subscribe({ post_slug: SLUG });
		expect(res.status).toBe(400);
		expect((await res.json()) as { error: string }).toEqual({
			error: "invalid_email",
		});
	});

	it("rejects a signed-in caller whose provider returned no address", async () => {
		const res = await subscribe({ post_slug: SLUG }, { sid: NO_EMAIL_SID });
		expect(res.status).toBe(400);
	});

	it("refuses a banned user before writing anything", async () => {
		const res = await subscribe({ post_slug: SLUG }, { sid: BANNED_SID });
		expect(res.status).toBe(403);
		expect(rowFor("spam@example.com")).toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	it("still honours an explicit address from a signed-in caller", async () => {
		// Subscribing an alias you control is legitimate; it just doesn't get
		// the fast path, because the provider vouched for the other one.
		const alias = "alias@example.com";
		await subscribe({ post_slug: SLUG, email: alias }, { sid: GH_SID });
		expect(rowFor(alias)?.confirmed_at).toBeNull();
		expect(rowFor(GH_EMAIL)).toBeUndefined();
	});
});
