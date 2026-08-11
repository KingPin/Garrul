/**
 * Digest mail is written in the subscriber's language.
 *
 * This is the failure the whole i18n effort exists to fix: a reader subscribes
 * from a German page, and five minutes later an English email arrives. The
 * cron tick that sends it has no request to negotiate a locale from, so the
 * only place the answer can come from is the subscription row — which is why
 * `subscriptions.locale` exists.
 *
 * Real SQLite with every migration applied, and `fetch` stubbed at the Resend
 * boundary so the assertions are made against the bytes that would actually
 * have been sent.
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

const SLUG = "willkommen";
const SUB_ID = "01HSUB0000000000000000";
const T0 = 1_700_000_000_000;
/** Comfortably past DEBOUNCE_MS, so the queued notifications are due. */
const NOW = T0 + 60 * 60 * 1000;

let sqlite: DatabaseSync;
let sent: { subject: string; html: string }[];

const env = () =>
	({
		DB: makeD1(sqlite),
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
		EMAIL_FROM: "comments@example.com",
		PUBLIC_BASE_URL: "https://comments.example.com",
	}) as never;

/** Queue `count` approved comments against the subscription, all due. */
const queue = (count: number): void => {
	for (let i = 0; i < count; i++) {
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(`c${i}`, SLUG, "u1", "hallo", "<p>hallo</p>", T0);
		sqlite
			.prepare(
				`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
				 VALUES (?, ?, ?, ?, NULL)`,
			)
			.run(`n${i}`, SUB_ID, `c${i}`, T0);
	}
};

/** Give the subscription a locale, or NULL for a row predating the column. */
const setLocale = (locale: string | null): void => {
	sqlite
		.prepare("UPDATE subscriptions SET locale = ? WHERE id = ?")
		.run(locale, SUB_ID);
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
		.run(SLUG, "Willkommen", null, T0);
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
		.run(SUB_ID, SLUG, "leser@example.com", "t".repeat(64), T0, T0);

	sent = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runDigest — locale", () => {
	it("writes the mail in the locale the subscriber signed up in", async () => {
		setLocale("de");
		queue(2);
		await runDigest(env(), NOW);

		expect(sent).toHaveLength(1);
		const mail = sent[0] as { subject: string; html: string };
		expect(mail.subject).toBe('Neue Antworten zu „Willkommen“');
		expect(mail.html).toContain("2 neue Kommentare zu „Willkommen“");
		expect(mail.html).toContain(
			"Benachrichtigungen zu diesem Thread abbestellen",
		);
	});

	it("selects the singular form from the subscriber's own plural rules", async () => {
		// The `${count === 1 ? "" : "s"}` this replaced was English grammar
		// hardcoded into the layout — invisible until a second language existed.
		setLocale("de");
		queue(1);
		await runDigest(env(), NOW);

		expect((sent[0] as { html: string }).html).toContain(
			"1 neuer Kommentar zu „Willkommen“",
		);
	});

	it("falls back to English for a row written before the column existed", async () => {
		// NULL is the honest value for those rows, and English is what they have
		// always received — a backfill would claim knowledge we don't have.
		setLocale(null);
		queue(2);
		await runDigest(env(), NOW);

		const mail = sent[0] as { subject: string; html: string };
		expect(mail.subject).toBe('New replies on "Willkommen"');
		// Entity-encoded, not raw: the heading is escaped as a whole, which is
		// also what keeps a post title full of markup out of the mail body.
		expect(mail.html).toContain("2 new comments on &quot;Willkommen&quot;");
	});

	it("falls back to English for a locale that no longer ships", async () => {
		// A locale can be removed after rows already reference it. `tFor`
		// whitelists, so this degrades instead of throwing inside a cron tick
		// where nothing is watching.
		setLocale("xx");
		queue(1);
		await runDigest(env(), NOW);

		expect((sent[0] as { html: string }).html).toContain("1 new comment on");
	});

	it("marks the digest sent so the next tick doesn't repeat it", async () => {
		setLocale("de");
		queue(2);
		await runDigest(env(), NOW);
		await runDigest(env(), NOW);

		expect(sent).toHaveLength(1);
	});
});
