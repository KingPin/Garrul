/**
 * The digest sets RFC 8058 List-Unsubscribe headers.
 *
 * This is what makes Gmail and Apple Mail render their *native* Unsubscribe
 * button, and Gmail's bulk-sender guidance expects one-click from anyone
 * sending at volume. Nothing in the rendered mail reveals whether the headers
 * are set, so it is the kind of regression that ships silently and is only
 * noticed as a deliverability problem months later — hence assertions against
 * the bytes that would actually have gone to Resend.
 *
 * Same real-SQLite + stubbed-fetch shape as digest-locale.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDigest } from "../src/lib/digest";

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
const SUB_ID = "01HSUB0000000000000000";
const TOKEN = "t".repeat(64);
const BASE = "https://comments.example.com";
const T0 = 1_700_000_000_000;
/** Comfortably past DEBOUNCE_MS, so the queued notification is due. */
const NOW = T0 + 60 * 60 * 1000;

type SentMail = {
	subject: string;
	html: string;
	headers?: Record<string, string>;
};

let sqlite: DatabaseSync;
let sent: SentMail[];

const env = () =>
	({
		DB: makeD1(sqlite),
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
		EMAIL_FROM: "comments@example.com",
		PUBLIC_BASE_URL: BASE,
	}) as never;

const mail = (): SentMail => {
	const m = sent[0];
	if (!m) throw new Error("runDigest sent nothing");
	return m;
};

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Notify me", null, T0);
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, name, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("u1", "anon", "Jana", T0);
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		)
		.run(SUB_ID, SLUG, "reader@example.com", TOKEN, T0, T0);
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run("c0", SLUG, "u1", "hi", "<p>hi</p>", T0);
	sqlite
		.prepare(
			`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
			 VALUES (?, ?, ?, ?, NULL)`,
		)
		.run("n0", SUB_ID, "c0", T0);

	sent = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)) as SentMail);
		return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runDigest — List-Unsubscribe", () => {
	it("sets both headers, in the angle-bracket form RFC 8058 requires", async () => {
		await runDigest(env(), NOW);

		expect(mail().headers).toEqual({
			"List-Unsubscribe": `<${BASE}/api/v1/subscribe/unsubscribe/${TOKEN}/one-click>`,
			// Without this second header a client renders a plain link, not the
			// one-click button — the pair is the feature.
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		});
	});

	it("points at /one-click, not the human confirmation page", async () => {
		// The bare unsubscribe path renders a form and requires a same-origin
		// POST. A provider posting there gets a 403 and the reader gets
		// "unsubscribe failed".
		await runDigest(env(), NOW);

		const target = mail().headers?.["List-Unsubscribe"];
		expect(target).toMatch(/\/one-click>$/);
	});

	it("advertises no mailto: alternative", async () => {
		// Garrul has no inbound mail handling, so a mailto would name an address
		// nothing reads and every unsubscribe through it would fail silently.
		await runDigest(env(), NOW);

		expect(mail().headers?.["List-Unsubscribe"]).not.toContain("mailto:");
	});

	it("keeps the visible footer link as the fallback", async () => {
		// Clients that ignore the headers still need a way out, and it points at
		// the human confirm page rather than the one-click endpoint.
		await runDigest(env(), NOW);

		const html = mail().html;
		expect(html).toContain(`${BASE}/api/v1/subscribe/unsubscribe/${TOKEN}`);
		expect(html).not.toContain("/one-click");
	});
});
