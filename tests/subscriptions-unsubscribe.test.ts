/**
 * Unsubscribe is POST-confirmed.
 *
 * The link in a digest email is a GET, and mail clients, link scanners and
 * corporate security gateways prefetch every URL in a message. A GET that wrote
 * therefore unsubscribed people who never clicked, silently: the row gets an
 * `unsubscribed_at` stamp and their next reply notification simply never
 * arrives. `confirmSubscription` has carried a note about exactly this hazard
 * since it shipped — unsubscribe never got the same treatment.
 *
 * So the GET now only renders a confirmation form, and the POST does the write.
 * The origin gate is exercised here too: the POST is same-origin-checked rather
 * than carved out, so a cross-site forgery attempt is rejected even though the
 * token is the real capability.
 *
 * Real SQLite with every migration applied — the assertions are all about
 * whether a column got written.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscriptions } from "../src/routes/api.subscriptions";
import { corsAndCsrf } from "../src/lib/cors";
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

const SLUG = "notify-me";
const EMAIL = "reader@example.com";
const TOKEN = "u".repeat(64);
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
		.run(SLUG, "Notify me", null, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		)
		.run(SUB_ID, SLUG, EMAIL, TOKEN, 1_700_000_000_000, 1_700_000_000_000);
	env = {
		DB: makeD1(sqlite),
		// Deliberately NOT the Worker's own origin: an operator lists the sites
		// that embed the widget, never the comment host itself.
		ALLOWED_ORIGINS: HOST_SITE,
		ENV: "production",
	} as unknown as Bindings;
});

/** Mounted exactly as index.ts does, so `c.req.path` matches the gate's regex. */
const app = () => {
	const a = new Hono<{ Bindings: Bindings }>();
	a.use("/api/*", corsAndCsrf());
	a.route("/api/v1/subscribe", subscriptions);
	return a;
};

const url = (token = TOKEN) =>
	`${SELF}/api/v1/subscribe/unsubscribe/${token}`;

const request = (init: RequestInit, token = TOKEN) =>
	app().request(
		url(token),
		init,
		env as unknown as Record<string, unknown>,
	);

const get = (token = TOKEN) => request({ method: "GET" }, token);

const submit = (origin: string | null = SELF, token = TOKEN) =>
	request(
		{
			method: "POST",
			headers: origin ? { origin } : {},
		},
		token,
	);

const unsubscribedAt = (): number | null =>
	(
		sqlite
			.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(SUB_ID) as { unsubscribed_at: number | null }
	).unsubscribed_at;

describe("GET /subscribe/unsubscribe/:token", () => {
	it("offers a form and writes nothing", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('<form method="post"');
		expect(html).toContain("Yes, unsubscribe me");
		// The whole point: a prefetch must leave the subscription alone.
		expect(unsubscribedAt()).toBeNull();
	});

	it("says so and writes nothing when already unsubscribed", async () => {
		await submit();
		const stamped = unsubscribedAt();
		expect(stamped).not.toBeNull();

		const res = await get();
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("already unsubscribed");
		// Not re-stamped — the original timestamp is the record of when it happened.
		expect(unsubscribedAt()).toBe(stamped);
	});

	it("reports an unknown token without confirming whether it ever existed", async () => {
		const res = await get("z".repeat(64));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Link expired or already used.");
	});

	it("escapes the post title in the confirmation page", async () => {
		sqlite
			.prepare("UPDATE posts SET title = ? WHERE slug = ?")
			.run('<img src=x onerror=alert(1)>', SLUG);
		const html = await (await get()).text();
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});

describe("POST /subscribe/unsubscribe/:token", () => {
	it("unsubscribes when submitted from the Worker's own origin", async () => {
		const res = await submit(SELF);
		expect(res.status).toBe(200);
		// The apostrophe arrives as an entity: the page copy is now a translated
		// template, and templates are escaped before the title is spliced in.
		expect(await res.text()).toContain(
			"unsubscribed from comment notifications",
		);
		expect(unsubscribedAt()).not.toBeNull();
	});

	it("403s a cross-site POST even with a valid token", async () => {
		// The same-origin requirement is a real check, not a carve-out: the token
		// is the capability, but a forged submission from another page isn't the
		// recipient asking.
		const res = await submit("https://evil.example");
		expect(res.status).toBe(403);
		expect(unsubscribedAt()).toBeNull();
	});

	it("403s a POST with no Origin header at all", async () => {
		const res = await submit(null);
		expect(res.status).toBe(403);
		expect(unsubscribedAt()).toBeNull();
	});

	it("does not extend the allowance to the confirm path", async () => {
		// SELF_ORIGIN_POST_PATHS lists one path. A POST to a sibling email-link
		// route must still fall through to the ALLOWED_ORIGINS gate.
		const res = await app().request(
			`${SELF}/api/v1/subscribe/confirm/${TOKEN}`,
			{ method: "POST", headers: { origin: SELF } },
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBe(403);
	});

	it("does not extend the allowance to a sub-path of the unsubscribe route", async () => {
		const res = await app().request(
			`${SELF}/api/v1/subscribe/unsubscribe/${TOKEN}/extra`,
			{ method: "POST", headers: { origin: SELF } },
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBe(403);
	});
});

describe("POST /subscribe/unsubscribe/:token/one-click (RFC 8058)", () => {
	const oneClick = (
		init: RequestInit = { method: "POST" },
		token = TOKEN,
	) =>
		app().request(
			`${url(token)}/one-click`,
			init,
			env as unknown as Record<string, unknown>,
		);

	it("unsubscribes on a POST with no Origin header", async () => {
		// The whole point. Gmail posts this from its own servers, so there is
		// no Origin to send — and the human POST above 403s exactly this shape.
		const res = await oneClick();
		expect(res.status).toBe(200);
		expect(unsubscribedAt()).not.toBeNull();
	});

	it("answers text/plain and discloses nothing about the subscriber", async () => {
		// The response goes to a third party's fetcher, not to the reader.
		const res = await oneClick();
		expect(res.headers.get("content-type")).toMatch(/text\/plain/);
		const body = await res.text();
		expect(body).not.toContain(EMAIL);
		expect(body).not.toContain(SLUG);
		expect(body).not.toContain("Notify me");
	});

	it("is idempotent — a provider retry does not re-stamp the row", async () => {
		await oneClick();
		const stamped = unsubscribedAt();
		expect(stamped).not.toBeNull();

		const res = await oneClick();
		expect(res.status).toBe(200);
		// The first timestamp is the record of when it happened.
		expect(unsubscribedAt()).toBe(stamped);
	});

	it("answers 200 for an unknown token without writing", async () => {
		// A non-2xx reads to the mail client as "unsubscribe failed" and counts
		// against sender reputation, for a reader who cannot act on it.
		const res = await oneClick({ method: "POST" }, "z".repeat(64));
		expect(res.status).toBe(200);
		expect(unsubscribedAt()).toBeNull();
	});

	it("a GET does not write — prefetchers cannot reach it", async () => {
		// Same hazard the GET/POST split above exists for. The route is
		// POST-only, and the no-Origin CORS relaxation is POST-only too, so a
		// prefetch is rejected before any handler runs.
		const res = await oneClick({ method: "GET" });
		expect(res.status).not.toBe(200);
		expect(unsubscribedAt()).toBeNull();
	});

	it("403s a cross-site POST that does carry an Origin", async () => {
		const res = await oneClick({
			method: "POST",
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
		expect(unsubscribedAt()).toBeNull();
	});
});
