/**
 * The moderator notification digest, against real SQLite with every migration
 * applied.
 *
 * Real SQLite rather than a substring-routing D1 stub because two of the load-
 * bearing behaviours here *are* SQL: the partial UNIQUE index that collapses a
 * report brigade to one queue row, and the debounce/limit query that decides
 * what a tick picks up. A stub that pattern-matches the statement would assert
 * nothing about either.
 *
 * What matters most is at the top of the file: an instance that never
 * configured email, or never turned the flag on, must get a *silent no-op*.
 * This runs every five minutes forever on every install that upgrades, so the
 * degraded path is the common path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	enqueueModeratorNotification,
	listPendingModeratorNotifications,
} from "../src/db/queries";
import { runModeratorDigest } from "../src/lib/moderator-digest";
import { makeKv } from "./helpers/kv";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
/**
 * Wall clock, not a frozen constant: `enqueueModeratorNotification` stamps
 * `created_at` with a real `Date.now()`, so a fixed epoch here would put every
 * queued row far in the future of the tick timestamps below and the debounce
 * query would match nothing.
 */
const NOW = Date.now();
/** Comfortably past the digest's 5-minute debounce, so a fresh row is eligible. */
const AFTER_DEBOUNCE = NOW + 6 * 60 * 1000;
const SLUG = "a-post";

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

let sqlite: DatabaseSync;
let env: Bindings;
/** Every Resend request body this tick produced, parsed. */
let sent: { to: string[]; subject: string; html: string }[];
/** Status code the fake Resend returns; flipped to exercise send failure. */
let resendStatus: number;

const migrate = (db: DatabaseSync) => {
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
};

/** Insert a comment and return its id. */
const addComment = (
	id: string,
	status: string,
	opts: { author?: string | null } = {},
): string => {
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		// `in`, not `??` — an explicit null is the authorless case under test.
		.run(id, SLUG, "author" in opts ? opts.author : "u1", "hi", "<p>hi</p>", status, NOW);
	return id;
};

/** Flip a flag on as /admin/settings would — a `settings` row beats the env. */
const setFlag = (key: string, value: boolean) => {
	sqlite
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run(key, value ? "1" : "0", NOW);
};

const pendingRows = () =>
	sqlite
		.prepare(
			"SELECT id, comment_id, reason, sent_at FROM moderator_notifications ORDER BY id",
		)
		.all() as { id: string; comment_id: string; reason: string; sent_at: number | null }[];

/** Slots spent in the moderator burst window. */
const burstSpent = (): number =>
	(
		sqlite
			.prepare("SELECT sent FROM email_send_budget WHERE scope = ?")
			.get("moderator:burst") as { sent: number }
	).sent;

/**
 * Put `sent` slots on the moderator burst counter, inside the window the tick
 * will reserve against. The cap is 10, so `spendBurst(10)` denies outright and
 * `spendBurst(9)` leaves exactly one slot — the state that used to split a
 * multi-recipient fan-out in half.
 */
const spendBurst = (n: number) =>
	sqlite
		.prepare(
			"UPDATE email_send_budget SET sent = ?, window_start = ? WHERE scope = 'moderator:burst'",
		)
		.run(n, AFTER_DEBOUNCE);

beforeEach(() => {
	sent = [];
	resendStatus = 200;
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		if (resendStatus === 200) {
			sent.push(JSON.parse(String(init.body)));
		}
		return new Response("{}", { status: resendStatus });
	});

	sqlite = new DatabaseSync(":memory:");
	migrate(sqlite);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "A post", null, NOW);
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("u1", "anon", "hash", "Jamie", NOW);

	env = {
		DB: makeD1(sqlite),
		// Fresh per test: loadSettings caches the resolved object here, so a
		// carried-over store would serve one test's flag to the next.
		TREE_CACHE: makeKv(),
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
		EMAIL_FROM: "no-reply@example.com",
		PUBLIC_BASE_URL: "https://comments.example",
		ADMIN_EMAILS: "ops@example.com",
		MODERATOR_EMAIL_ENABLED: "true",
	} as unknown as Bindings;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runModeratorDigest — degrades, never fails", () => {
	it("is a silent no-op without an email provider", async () => {
		env.EMAIL_PROVIDER = "";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await expect(runModeratorDigest(env, AFTER_DEBOUNCE)).resolves.toBeUndefined();
		expect(sent).toHaveLength(0);
	});

	it("is a silent no-op without PUBLIC_BASE_URL", async () => {
		// Every link in the mail is built from it, so a digest without one would
		// be a list of comments nobody can act on.
		env.PUBLIC_BASE_URL = "";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(0);
	});

	it("sends nothing while the flag is off", async () => {
		// The default on every upgraded install. Outbound mail must not start on
		// its own.
		env.MODERATOR_EMAIL_ENABLED = "";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(0);
		// And the row is still there — turning the flag back on picks it up.
		expect(pendingRows()[0]!.sent_at).toBeNull();
	});

	it("lets a settings row silence it without a deploy", async () => {
		// DB row beats env var, which is the point of putting the flag in FLAGS
		// rather than reading the env directly: an operator drowning in moderation
		// mail can stop it from /admin/settings mid-incident.
		setFlag("moderator_email_enabled", false);
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(0);
	});

	it("sends nothing when no recipient is configured", async () => {
		env.ADMIN_EMAILS = "";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(0);
	});
});

describe("runModeratorDigest — what goes out", () => {
	it("coalesces a burst into one email", async () => {
		// The property that makes this channel usable during a spam flood: the
		// queue depth changes the digest's length, not the number of emails.
		for (const i of [1, 2, 3, 4, 5]) {
			await enqueueModeratorNotification(env.DB, addComment(`c${i}`, "pending"), "pending");
		}
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent).toHaveLength(1);
		expect(sent[0]!.subject).toBe("5 comments need review");
		expect(pendingRows().every((r) => r.sent_at !== null)).toBe(true);
	});

	it("holds anything newer than the debounce window", async () => {
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		// A tick that fires a second after the comment landed: nothing is due yet.
		await runModeratorDigest(env, NOW + 1000);
		expect(sent).toHaveLength(0);
		expect(pendingRows()[0]!.sent_at).toBeNull();
	});

	it("names both reasons and both audiences", async () => {
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await enqueueModeratorNotification(env.DB, addComment("c2", "approved"), "reported");
		env.MODERATOR_NOTIFY_EMAILS = "mod@example.com, MOD@example.com , ops@example.com";
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		// Deduped and lowercased, one send each.
		expect(sent.map((s) => s.to[0])).toEqual(["mod@example.com", "ops@example.com"]);
		expect(sent[0]!.html).toContain("Held for review");
		expect(sent[0]!.html).toContain("Reported by a reader");
	});

	it("re-sanitizes the stored body rather than trusting it", async () => {
		// body_html is sanitized for a browser; an email client has a different
		// threat model. Stored HTML that predates a sanitizer change must not
		// reach an inbox on the strength of having once been accepted.
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"c1",
				SLUG,
				"u1",
				"x",
				'<p onclick="steal()">hi</p><img src=x onerror=alert(1)>',
				"pending",
				NOW,
			);
		await enqueueModeratorNotification(env.DB, "c1", "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent[0]!.html).not.toContain("onclick");
		expect(sent[0]!.html).not.toContain("onerror");
		expect(sent[0]!.html).not.toContain("<img");
	});

	it("escapes the post slug and the author name", async () => {
		// Both are attacker-influenced: the slug comes off the host page and a
		// name is whatever an author typed.
		sqlite
			.prepare(
				"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run("u2", "anon", "h2", "<script>x</script>", NOW);
		sqlite
			.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
			.run("</td><script>", "Evil", null, NOW);
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run("c1", "</td><script>", "u2", "x", "<p>x</p>", "pending", NOW);
		await enqueueModeratorNotification(env.DB, "c1", "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent[0]!.html).not.toContain("<script>");
		expect(sent[0]!.html).toContain("&lt;script&gt;");
	});
});

describe("runModeratorDigest — rows a moderator already handled", () => {
	it("drops a comment that was approved inside the debounce window", async () => {
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		sqlite.prepare("UPDATE comments SET status = 'approved' WHERE id = 'c1'").run();
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent).toHaveLength(0);
		// Cleared anyway: leaving it pending would rescan it on every tick forever.
		expect(pendingRows()[0]!.sent_at).not.toBeNull();
	});

	it("still reports a published comment", async () => {
		// A report on an approved comment is the entire point of reporting —
		// 'approved' is not a reason to drop a 'reported' row.
		await enqueueModeratorNotification(env.DB, addComment("c1", "approved"), "reported");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(1);
	});

	it("drops a report on a deleted comment", async () => {
		await enqueueModeratorNotification(env.DB, addComment("c1", "deleted"), "reported");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(0);
	});
});

describe("moderator_notifications — the queue itself", () => {
	it("collapses a report brigade to one row", async () => {
		// The report endpoint dedups per reporting network, so N networks is N
		// calls to here. The partial UNIQUE index is what bounds the queue.
		addComment("c1", "approved");
		for (let i = 0; i < 10; i++) {
			await enqueueModeratorNotification(env.DB, "c1", "reported");
		}
		expect(pendingRows()).toHaveLength(1);
	});

	it("lets the same comment raise both reasons", async () => {
		addComment("c1", "pending");
		await enqueueModeratorNotification(env.DB, "c1", "pending");
		await enqueueModeratorNotification(env.DB, "c1", "reported");
		expect(pendingRows()).toHaveLength(2);
	});

	it("queues again once the first digest has gone out", async () => {
		// The dedup index is partial on sent_at IS NULL, so it bounds the queue
		// and not the history: a report after the email is a second email, which
		// is right — the first one may have been about a comment left up.
		await enqueueModeratorNotification(env.DB, addComment("c1", "approved"), "reported");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		await enqueueModeratorNotification(env.DB, "c1", "reported");
		expect(pendingRows().filter((r) => r.sent_at === null)).toHaveLength(1);
	});
});

describe("runModeratorDigest — send failure", () => {
	it("leaves every row pending for the next tick", async () => {
		resendStatus = 500;
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(pendingRows()[0]!.sent_at).toBeNull();

		// And the retry lands.
		resendStatus = 200;
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent).toHaveLength(1);
		expect(pendingRows()[0]!.sent_at).not.toBeNull();
	});

	it("hands the budget slot back, so an outage doesn't spend the day", async () => {
		resendStatus = 500;
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(burstSpent()).toBe(0);
	});

	it("names the addresses that failed but still clears the batch", async () => {
		// One bad address must not hold the queue: the retry would re-mail everyone
		// who already got it, every tick, for as long as that address bounces.
		env.MODERATOR_NOTIFY_EMAILS = "good@example.com, bad@example.com";
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			if (body.to.includes("bad@example.com")) return new Response("{}", { status: 422 });
			sent.push(body);
			return new Response("{}", { status: 200 });
		});
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent.map((s) => s.to).flat()).toEqual(["good@example.com"]);
		expect(pendingRows()[0]!.sent_at).not.toBeNull();
	});

	it("never touches the confirmation budget", async () => {
		// The whole reason for separate scopes: a spam flood filling the queue
		// must not be able to stop new subscribers from confirming.
		for (const i of [1, 2, 3]) {
			await enqueueModeratorNotification(env.DB, addComment(`c${i}`, "pending"), "pending");
		}
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		const confirm = sqlite
			.prepare("SELECT sent FROM email_send_budget WHERE scope = 'confirm:daily'")
			.get() as { sent: number };
		expect(confirm.sent).toBe(0);
	});
});

describe("runModeratorDigest — the send budget", () => {
	it("costs one slot per digest, not one per recipient", async () => {
		env.MODERATOR_NOTIFY_EMAILS = "a@example.com, b@example.com, c@example.com";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent).toHaveLength(3);
		expect(burstSpent()).toBe(1);
	});

	it("does not split a fan-out across a cap that runs out midway", async () => {
		// The regression this pins. Reserving a slot per recipient made the batch
		// divisible: with one slot left and two moderators, the first was mailed,
		// the second was not, and the rows were marked sent for both — so the
		// second never heard about those comments, on that tick or any later one.
		spendBurst(9);
		env.MODERATOR_NOTIFY_EMAILS = "a@example.com, b@example.com";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent.flatMap((s) => s.to)).toEqual(["a@example.com", "b@example.com"]);
		expect(pendingRows()[0]!.sent_at).not.toBeNull();
	});

	it("mails nobody and holds the rows when the cap is already spent", async () => {
		spendBurst(10);
		env.MODERATOR_NOTIFY_EMAILS = "a@example.com, b@example.com";
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		await runModeratorDigest(env, AFTER_DEBOUNCE);

		expect(sent).toHaveLength(0);
		expect(pendingRows()[0]!.sent_at).toBeNull();
	});
});

describe("listPendingModeratorNotifications", () => {
	it("caps a tick and leaves the rest queued", async () => {
		for (let i = 0; i < 5; i++) {
			await enqueueModeratorNotification(env.DB, addComment(`c${i}`, "pending"), "pending");
		}
		const page = await listPendingModeratorNotifications(env.DB, AFTER_DEBOUNCE, 2);
		expect(page).toHaveLength(2);
	});

	it("keeps a comment whose author row has gone missing", async () => {
		// LEFT JOIN, not JOIN. `comments.user_id` is NOT NULL with an FK, so this
		// should be unreachable — which is exactly why the join is defensive: an
		// INNER JOIN would make a dangling reference *hide a comment from the
		// moderation queue*, the one failure mode this table exists to prevent.
		// FK enforcement is dropped for the delete to reach that state at all.
		await enqueueModeratorNotification(env.DB, addComment("c1", "pending"), "pending");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.prepare("DELETE FROM users WHERE id = 'u1'").run();

		const page = await listPendingModeratorNotifications(env.DB, AFTER_DEBOUNCE, 10);
		expect(page).toHaveLength(1);
		expect(page[0]!.author_name).toBeNull();

		// And the digest names them rather than rendering a blank byline.
		await runModeratorDigest(env, AFTER_DEBOUNCE);
		expect(sent[0]!.html).toContain("Anonymous");
	});
});
