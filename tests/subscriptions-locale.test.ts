/**
 * A subscription remembers the language it was made in.
 *
 * The widget forwards its resolved locale on every API call, so the subscribe
 * request is the last moment anything knows what language the reader is
 * looking at. Everything downstream — the confirmation mail, the page its link
 * lands on, and every digest the cron sends months later — reads it back off
 * the row.
 *
 * Real SQLite with every migration applied, `fetch` stubbed at the Resend
 * boundary, and the router mounted with `localeMiddleware` exactly as
 * `src/index.ts` mounts it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/index";
import { localeMiddleware } from "../src/lib/locale";
import { subscriptions } from "../src/routes/api.subscriptions";
import { makeKv } from "./helpers/kv";

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

const SLUG = "willkommen";
const EMAIL = "leser@example.com";
const SELF = "https://comments.example.com";
const T0 = 1_700_000_000_000;

let sqlite: DatabaseSync;
let env: Bindings;
let sent: { subject: string; html: string }[];

/** Mounted as index.ts does: the locale middleware covers all of /api/*. */
const app = () => {
	const a = new Hono<{ Bindings: Bindings }>();
	a.use("/api/*", localeMiddleware());
	a.route("/api/v1/subscribe", subscriptions);
	return a;
};

const subscribe = (query = "") =>
	app().request(
		`${SELF}/api/v1/subscribe${query}`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
			body: JSON.stringify({ post_slug: SLUG, email: EMAIL }),
		},
		env as unknown as Record<string, unknown>,
	);

const row = (): { locale: string | null; confirm_token: string; token: string } =>
	sqlite
		.prepare("SELECT locale, confirm_token, token FROM subscriptions WHERE email = ?")
		.get(EMAIL) as never;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Willkommen", null, T0);
	env = {
		DB: makeD1(sqlite),
		// The route resolves the confirmation-email caps through loadNumbers.
		TREE_CACHE: makeKv(),
		IP_HASH_SECRET: "s".repeat(32),
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
		EMAIL_FROM: "comments@example.com",
		PUBLIC_BASE_URL: SELF,
		ENV: "production",
	} as unknown as Bindings;

	sent = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("POST /api/v1/subscribe — locale", () => {
	it("stores the locale the request was made in", async () => {
		const res = await subscribe("?lang=de");
		expect(res.status).toBe(200);
		expect(row().locale).toBe("de");
	});

	it("sends the confirmation mail in that locale", async () => {
		await subscribe("?lang=de");
		const mail = sent[0] as { subject: string; html: string };
		expect(mail.subject).toBe("Abo für Kommentare zu Willkommen bestätigen");
		expect(mail.html).toContain("Abo bestätigen");
		expect(mail.html).toContain("<strong>Willkommen</strong>");
	});

	it("answers the widget in that locale too", async () => {
		const body = (await (await subscribe("?lang=de")).json()) as { message: string };
		expect(body.message).toBe("Bitte im Posteingang das Abo bestätigen.");
	});

	it("stores English when nothing asked for a language", async () => {
		// Not NULL: NULL is reserved for rows that predate the column, and the
		// difference is what lets a future backfill tell them apart.
		await subscribe();
		expect(row().locale).toBe("en");
	});

	it("refuses a machine-seeded locale offered as a host-page hint", async () => {
		// The sourcing policy, enforced one layer deeper than /api/v1/config:
		// unreviewed German is only ever seen by an operator who typed the tag.
		await subscribe("?hl=de");
		expect(row().locale).toBe("en");
	});
});

describe("the pages the emailed links land on", () => {
	const landing = (path: string) =>
		app().request(
			`${SELF}/api/v1/subscribe/${path}`,
			{ method: "GET" },
			env as unknown as Record<string, unknown>,
		);

	it("confirms in the subscription's language, not the request's", async () => {
		// The click comes from a mail client, which sends no ?lang= at all.
		await subscribe("?lang=de");
		const html = await (await landing(`confirm/${row().confirm_token}`)).text();
		expect(html).toContain('<html lang="de"');
		expect(html).toContain("Benachrichtigungen zu Kommentaren bei");
	});

	it("offers the unsubscribe form in the same language", async () => {
		await subscribe("?lang=de");
		const html = await (await landing(`unsubscribe/${row().token}`)).text();
		expect(html).toContain('<html lang="de"');
		expect(html).toContain("Ja, abbestellen");
	});

	it("falls back to the request's locale when no row matches the token", async () => {
		// An expired token resolves nothing to read a locale off, so the only
		// signal left is the request — which is usually none, i.e. English.
		const html = await (await landing(`confirm/${"x".repeat(64)}`)).text();
		expect(html).toContain('<html lang="en"');
		expect(html).toContain("Link expired or already used.");
	});

	it("does not advertise a language the row stored but the registry lost", async () => {
		// A row outlives the registry that validated its locale on the way in, so
		// retiring a locale leaves live subscriptions pointing at a tag `tFor`
		// no longer carries. The page must not claim `lang="zz"` over the English
		// copy it actually renders — a mismatch only assistive tech reports.
		await subscribe("?lang=de");
		sqlite.prepare("UPDATE subscriptions SET locale = ? WHERE email = ?").run("zz", EMAIL);
		const html = await (await landing(`confirm/${row().confirm_token}`)).text();
		expect(html).toContain('<html lang="en"');
		expect(html).toContain("Turn on comment notifications for");
	});

	it("still honours a stored regional tag the registry resolves", async () => {
		// The flip side: canonicalizing must not throw away a usable locale.
		// `de-AT` is not a registry key but negotiates onto `de`.
		await subscribe("?lang=de");
		sqlite.prepare("UPDATE subscriptions SET locale = ? WHERE email = ?").run("de-AT", EMAIL);
		const html = await (await landing(`confirm/${row().confirm_token}`)).text();
		expect(html).toContain('<html lang="de"');
		expect(html).toContain("Benachrichtigungen zu Kommentaren bei");
	});
});
