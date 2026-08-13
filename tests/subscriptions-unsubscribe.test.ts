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

/** An extra subscription row, for the account-level list on the landing page. */
const addSub = (
	id: string,
	slug: string,
	email: string,
	opts: { title?: string; cancelled?: boolean } = {},
): void => {
	sqlite
		.prepare("INSERT OR IGNORE INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(slug, opts.title ?? slug, null, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at,
			    created_at, unsubscribed_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
		)
		.run(
			id,
			slug,
			email,
			`tok-${id}`,
			1_700_000_000_000,
			1_700_000_000_000,
			opts.cancelled ? 1_700_000_000_000 : null,
		);
};

const cancelledAt = (id: string): number | null =>
	(
		sqlite
			.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(id) as { unsubscribed_at: number | null }
	).unsubscribed_at;

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

/**
 * The account-level half of the landing page.
 *
 * A per-thread link is only a per-thread exit: a reader following twenty posts
 * had to find twenty emails to leave them. The row behind the token already
 * carries the address, so the page can show the rest — which is also a widening
 * of what one leaked token discloses, and the reason the per-row buttons are
 * keyed by subscription id and never by the row's own token. A page that
 * scattered N tokens would hand over N permanent capabilities to anyone who
 * scraped it once.
 */
describe("the landing page's other-threads list", () => {
	const OTHER = "someone.else@example.com";

	it("renders nothing extra when this is the only subscription", async () => {
		const html = await (await get()).text();
		expect(html).not.toContain("also gets notifications");
		expect(html).not.toContain("Unsubscribe from all threads");
	});

	it("lists the address's other active threads and an all-button", async () => {
		addSub("s-two", "second-post", EMAIL, { title: "Second post" });
		const html = await (await get()).text();
		expect(html).toContain("also gets notifications");
		expect(html).toContain("Second post");
		expect(html).toContain("Unsubscribe from all threads");
	});

	it("omits the thread the page is already about", async () => {
		addSub("s-two", "second-post", EMAIL, { title: "Second post" });
		const html = await (await get()).text();
		// "Notify me" appears once, in the confirmation question at the top —
		// listing it again below would give the same thread two buttons.
		expect(html.match(/Notify me/g)).toHaveLength(1);
	});

	it("omits cancelled rows", async () => {
		addSub("s-gone", "gone-post", EMAIL, { title: "Gone post", cancelled: true });
		expect(await (await get()).text()).not.toContain("Gone post");
	});

	it("never lists another address's threads", async () => {
		addSub("s-other", "their-post", OTHER, { title: "Their post" });
		const html = await (await get()).text();
		expect(html).not.toContain("Their post");
		expect(html).not.toContain("s-other");
	});

	it("keys per-row buttons by subscription id, never by the row's token", async () => {
		addSub("s-two", "second-post", EMAIL, { title: "Second post" });
		const html = await (await get()).text();
		expect(html).toContain(`/unsubscribe/${TOKEN}/row/s-two`);
		// The other row's own unsubscribe token must not reach the page: that
		// would be a second permanent capability sitting in scrapeable HTML.
		expect(html).not.toContain("tok-s-two");
	});

	it("still lists the others on the already-unsubscribed page", async () => {
		// That reader is finished with this thread and is exactly the one who may
		// want out of the rest.
		addSub("s-two", "second-post", EMAIL, { title: "Second post" });
		await submit();
		const html = await (await get()).text();
		expect(html).toContain("already unsubscribed");
		expect(html).toContain("Second post");
	});

	it("escapes titles in the list", async () => {
		addSub("s-two", "second-post", EMAIL, {
			title: '<img src=x onerror=alert(1)>',
		});
		const html = await (await get()).text();
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});

describe("POST /subscribe/unsubscribe/:token/all", () => {
	const OTHER = "someone.else@example.com";

	const all = (origin: string | null = SELF, token = TOKEN) =>
		app().request(
			`${url(token)}/all`,
			{ method: "POST", headers: origin ? { origin } : {} },
			env as unknown as Record<string, unknown>,
		);

	it("cancels every thread for the token's address", async () => {
		addSub("s-two", "second-post", EMAIL);
		addSub("s-three", "third-post", EMAIL);

		const res = await all();
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("every thread");
		expect(unsubscribedAt()).not.toBeNull();
		expect(cancelledAt("s-two")).not.toBeNull();
		expect(cancelledAt("s-three")).not.toBeNull();
	});

	it("leaves other addresses alone", async () => {
		addSub("s-other", "their-post", OTHER);
		await all();
		expect(cancelledAt("s-other")).toBeNull();
	});

	it("403s a cross-site POST even with a valid token", async () => {
		addSub("s-two", "second-post", EMAIL);
		const res = await all("https://evil.example");
		expect(res.status).toBe(403);
		expect(unsubscribedAt()).toBeNull();
		expect(cancelledAt("s-two")).toBeNull();
	});

	it("403s a POST with no Origin — this is not the RFC 8058 path", async () => {
		// Only /one-click is relaxed for a missing Origin. Folding this route in
		// would drop the CSRF check on a button that cancels everything.
		const res = await all(null);
		expect(res.status).toBe(403);
		expect(unsubscribedAt()).toBeNull();
	});

	it("reports an unknown token without writing", async () => {
		const res = await all(SELF, "z".repeat(64));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Link expired or already used.");
		expect(unsubscribedAt()).toBeNull();
	});
});

describe("POST /subscribe/unsubscribe/:token/row/:id", () => {
	const OTHER = "someone.else@example.com";

	const row = (id: string, origin: string | null = SELF, token = TOKEN) =>
		app().request(
			`${url(token)}/row/${id}`,
			{ method: "POST", headers: origin ? { origin } : {} },
			env as unknown as Record<string, unknown>,
		);

	it("cancels the listed row and leaves the page's own thread alone", async () => {
		addSub("s-two", "second-post", EMAIL, { title: "Second post" });
		const res = await row("s-two");
		expect(res.status).toBe(200);
		expect(cancelledAt("s-two")).not.toBeNull();
		// The mail's own thread still has its confirmation form above the list.
		expect(unsubscribedAt()).toBeNull();
	});

	it("404s on another address's id and writes nothing", async () => {
		// The id is not a capability. Answering anything other than the
		// unknown-token page would confirm the id exists.
		addSub("s-other", "their-post", OTHER);
		const res = await row("s-other");
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("Link expired or already used.");
		expect(cancelledAt("s-other")).toBeNull();
	});

	it("404s identically on an id that does not exist", async () => {
		const res = await row("s-nope");
		expect(res.status).toBe(404);
		expect(await res.text()).toContain("Link expired or already used.");
	});

	it("403s a cross-site POST even with a valid token and id", async () => {
		addSub("s-two", "second-post", EMAIL);
		const res = await row("s-two", "https://evil.example");
		expect(res.status).toBe(403);
		expect(cancelledAt("s-two")).toBeNull();
	});

	it("403s a POST with no Origin", async () => {
		addSub("s-two", "second-post", EMAIL);
		const res = await row("s-two", null);
		expect(res.status).toBe(403);
		expect(cancelledAt("s-two")).toBeNull();
	});

	it("is idempotent and does not move the original timestamp", async () => {
		addSub("s-two", "second-post", EMAIL);
		await row("s-two");
		const stamped = cancelledAt("s-two");
		await row("s-two");
		expect(cancelledAt("s-two")).toBe(stamped);
	});
});
