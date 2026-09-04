/**
 * Double-opt-in confirm is POST-confirmed.
 *
 * The emailed link is a GET, and mail clients, link scanners and corporate
 * security gateways follow every URL in a message. A GET that wrote
 * `confirmed_at` therefore confirmed subscriptions the recipient never asked
 * for — the exact thing double-opt-in exists to prevent. The GET now renders a
 * form and the same-origin POST does the write, mirroring unsubscribe.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../src/index";
import { corsAndCsrf } from "../src/lib/cors";
import { subscriptions } from "../src/routes/api.subscriptions";

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

const SLUG = "notify-me";
const TITLE = 'Notify <b>me</b> & "friends"';
const EMAIL = "reader@example.com";
const TOKEN = "u".repeat(64);
const CONFIRM = "c".repeat(64);
const SUB_ID = "01HSUB0000000000000000";
const SELF = "https://comments.example.com";
const HOST_SITE = "https://blog.example.com";

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, TITLE, null, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at, created_at, locale)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
		)
		.run(SUB_ID, SLUG, EMAIL, TOKEN, CONFIRM, 1_700_000_000_000, "de");
	env = {
		DB: makeD1(sqlite),
		// The host site, not the Worker's own origin — see cors.ts.
		ALLOWED_ORIGINS: HOST_SITE,
		ENV: "production",
	} as unknown as Bindings;
});
afterEach(() => sqlite.close());

/** Mounted exactly as index.ts does, so `c.req.path` matches the gate's regex. */
const app = () => {
	const a = new Hono<{ Bindings: Bindings }>();
	a.use("/api/*", corsAndCsrf());
	a.route("/api/v1/subscribe", subscriptions);
	return a;
};

const request = (init: RequestInit, token = CONFIRM) =>
	app().request(
		`${SELF}/api/v1/subscribe/confirm/${token}`,
		init,
		env as unknown as Record<string, unknown>,
	);

const get = (token = CONFIRM) => request({ method: "GET" }, token);

const submit = (origin: string | null = SELF, token = CONFIRM) =>
	request({ method: "POST", headers: origin ? { origin } : {} }, token);

const confirmedAt = (): number | null =>
	(
		sqlite
			.prepare("SELECT confirmed_at FROM subscriptions WHERE id = ?")
			.get(SUB_ID) as { confirmed_at: number | null }
	).confirmed_at;

describe("GET /subscribe/confirm/:token", () => {
	it("offers a form and writes nothing — a prefetch cannot confirm", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('<form method="post">');
		expect(html).toContain('<html lang="de"');
		expect(confirmedAt()).toBeNull();
	});

	it("escapes the post title in the form page", async () => {
		const html = await (await get()).text();
		expect(html).not.toContain("<b>me</b>");
		expect(html).toContain("&lt;b&gt;me&lt;/b&gt;");
	});

	it("lands on the success page without a form when already confirmed", async () => {
		await submit();
		const before = confirmedAt();
		const res = await get();
		const html = await res.text();
		expect(html).not.toContain("<form");
		expect(confirmedAt()).toBe(before);
	});

	it("reports an unknown token without saying whether it ever existed", async () => {
		const res = await get("x".repeat(64));
		expect(res.status).toBe(200);
		expect(await res.text()).not.toContain("<form");
		expect(confirmedAt()).toBeNull();
	});
});

describe("POST /subscribe/confirm/:token", () => {
	it("confirms when submitted from the Worker's own origin", async () => {
		const res = await submit(SELF);
		expect(res.status).toBe(200);
		expect(confirmedAt()).not.toBeNull();
		expect(await res.text()).not.toContain("<form");
	});

	it("is idempotent — a second submit keeps the first timestamp", async () => {
		await submit();
		const first = confirmedAt();
		await submit();
		expect(confirmedAt()).toBe(first);
	});

	it("403s a cross-site POST even with a valid token", async () => {
		// The token is the capability, but a browser-driven forgery still has
		// to carry its own Origin, and that is what the gate rejects.
		const res = await submit("https://evil.example");
		expect(res.status).toBe(403);
		expect(confirmedAt()).toBeNull();
	});

	it("403s a POST with no Origin header at all", async () => {
		const res = await submit(null);
		expect(res.status).toBe(403);
		expect(confirmedAt()).toBeNull();
	});

	it("does not extend the allowance to a sub-path", async () => {
		const res = await app().request(
			`${SELF}/api/v1/subscribe/confirm/${CONFIRM}/extra`,
			{ method: "POST", headers: { origin: SELF } },
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBe(403);
		expect(confirmedAt()).toBeNull();
	});

	it("writes nothing for an unknown token", async () => {
		const res = await submit(SELF, "x".repeat(64));
		expect(res.status).toBe(200);
		expect(confirmedAt()).toBeNull();
	});
});
