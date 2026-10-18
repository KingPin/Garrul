/**
 * Set-based subscriber fan-out (src/db/queries.ts) and the digest-side
 * guards that protect the same queue.
 *
 * Real SQLite with every migration applied. `makeD1` from the admin harness
 * enforces D1's 100-bound-parameter cap, which is the whole point of the
 * digest boundary tests below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/admin-sqlite";
import {
	MAX_NOTIFICATIONS_PER_DIGEST,
	enqueueNotificationsForPost,
	listPendingDigests,
	markAllSubscriptionsUnsubscribedForEmail,
	markSubscriptionUnsubscribed,
} from "../src/db/queries";
import { runDigest } from "../src/lib/digest";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const SLUG = "fanout-post";
const T0 = 1_700_000_000_000;

let sqlite: DatabaseSync;
let db: D1Database;

const addSub = (
	id: string,
	email: string,
	opts: { slug?: string; confirmed?: boolean; unsubscribed?: boolean } = {},
): void => {
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at, unsubscribed_at, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
		)
		.run(
			id,
			opts.slug ?? SLUG,
			email,
			id.padEnd(64, "t"),
			opts.confirmed === false ? null : T0,
			opts.unsubscribed ? T0 : null,
			T0,
		);
};

const addComment = (id: string, slug = SLUG): void => {
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, user_id, body_md, body_html, created_at)
			 VALUES (?, ?, 'u1', 'hi', '<p>hi</p>', ?)`,
		)
		.run(id, slug, T0);
};

const rows = (): { id: string; subscription_id: string; sent_at: number | null }[] =>
	sqlite
		.prepare("SELECT id, subscription_id, sent_at FROM notifications ORDER BY subscription_id")
		.all() as never;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	db = makeD1(sqlite);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, NULL, ?)")
		.run(SLUG, "Fan-out", T0);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('other', 'Other', NULL, ?)")
		.run(T0);
	sqlite
		.prepare("INSERT INTO users (id, provider, name, created_at) VALUES ('u1', 'anon', 'Ann', ?)")
		.run(T0);
	addComment("c1");
});

describe("enqueueNotificationsForPost", () => {
	it("enqueues one row per confirmed, active subscriber when the author has no email", async () => {
		for (let i = 0; i < 60; i++) addSub(`s${String(i).padStart(2, "0")}`, `r${i}@example.com`);
		const n = await enqueueNotificationsForPost(db, SLUG, "c1", null, T0 + 1);
		expect(n).toBe(60);
		const all = rows();
		expect(all).toHaveLength(60);
		for (const r of all) {
			expect(r.id.endsWith(`-${r.subscription_id}`)).toBe(true);
			expect(r.id.length).toBe(26 + 1 + r.subscription_id.length);
			expect(r.sent_at).toBeNull();
		}
		expect(sqlite.prepare("SELECT DISTINCT created_at AS t FROM notifications").all()).toEqual([
			{ t: T0 + 1 },
		]);
	});

	it("skips the author's own address", async () => {
		for (let i = 0; i < 60; i++) addSub(`s${String(i).padStart(2, "0")}`, `r${i}@example.com`);
		const n = await enqueueNotificationsForPost(db, SLUG, "c1", "r7@example.com", T0);
		expect(n).toBe(59);
		expect(rows().map((r) => r.subscription_id)).not.toContain("s07");
	});

	it("ignores unconfirmed, unsubscribed and other-post subscriptions", async () => {
		addSub("live", "live@example.com");
		addSub("pending", "pending@example.com", { confirmed: false });
		addSub("gone", "gone@example.com", { unsubscribed: true });
		addSub("elsewhere", "else@example.com", { slug: "other" });
		expect(await enqueueNotificationsForPost(db, SLUG, "c1", null, T0)).toBe(1);
		expect(rows().map((r) => r.subscription_id)).toEqual(["live"]);
	});
});

/** Queue `count` due notifications for `subId`, each on its own comment. */
const queueFor = (subId: string, count: number, tOffset = 0): void => {
	for (let i = 0; i < count; i++) {
		const cid = `${subId}-c${i}`;
		addComment(cid);
		sqlite
			.prepare(
				`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
				 VALUES (?, ?, ?, ?, NULL)`,
			)
			.run(`${subId}-n${String(i).padStart(3, "0")}`, subId, cid, T0 + tOffset + i);
	}
};

const DUE = T0 + 10 * 60 * 1000;

describe("listPendingDigests", () => {
	it("returns whole groups, never a subscriber split across the limit", async () => {
		addSub("a", "a@example.com");
		addSub("b", "b@example.com");
		addSub("c", "c@example.com");
		// Interleave so that sorting by created_at alternates subscribers.
		for (let i = 0; i < 4; i++) {
			for (const s of ["a", "b", "c"]) {
				const cid = `${s}-${i}`;
				addComment(cid);
				sqlite
					.prepare(
						`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
						 VALUES (?, ?, ?, ?, NULL)`,
					)
					.run(`${s}-n${i}`, s, cid, T0 + i * 3 + ["a", "b", "c"].indexOf(s));
			}
		}
		const groups = await listPendingDigests(db, DUE, 2);
		expect(groups.map((g) => g.subscription_id)).toEqual(["a", "b"]);
		for (const g of groups) expect(g.notification_ids).toHaveLength(4);
	});

	it("caps one subscriber's group at MAX_NOTIFICATIONS_PER_DIGEST oldest rows", async () => {
		addSub("big", "big@example.com");
		queueFor("big", 101);
		const [g] = await listPendingDigests(db, DUE, 50);
		expect(MAX_NOTIFICATIONS_PER_DIGEST).toBe(50);
		expect(g?.notification_ids).toHaveLength(50);
		expect(g?.notification_ids[0]).toBe("big-n000");
		expect(g?.notification_ids[49]).toBe("big-n049");
	});
});

describe("runDigest at the D1 bind cap", () => {
	let sent: unknown[];
	const env = () =>
		({
			DB: db,
			EMAIL_PROVIDER: "resend",
			RESEND_API_KEY: "re_test",
			EMAIL_FROM: "comments@example.com",
			PUBLIC_BASE_URL: "https://comments.example.com",
		}) as never;
	const pending = (): number =>
		(sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL").get() as { n: number }).n;

	beforeEach(() => {
		sent = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("drains 101 rows over three ticks without exceeding 100 binds", async () => {
		addSub("big", "big@example.com");
		queueFor("big", 101);
		await runDigest(env(), DUE);
		expect(sent).toHaveLength(1);
		expect(pending()).toBe(51);
		await runDigest(env(), DUE);
		expect(pending()).toBe(1);
		await runDigest(env(), DUE);
		expect(pending()).toBe(0);
		expect(sent).toHaveLength(3);
	});

	it("marks 50 of exactly 100 rows on the first tick", async () => {
		addSub("big", "big@example.com");
		queueFor("big", 100);
		await runDigest(env(), DUE);
		expect(pending()).toBe(50);
	});
});

describe("unsubscribe stamps pending notifications", () => {
	const sentAt = (nid: string): number | null =>
		(sqlite.prepare("SELECT sent_at FROM notifications WHERE id = ?").get(nid) as { sent_at: number | null }).sent_at;

	it("single: stamps only that subscription's pending rows", async () => {
		addSub("a", "a@example.com");
		addSub("b", "b@example.com");
		queueFor("a", 2);
		queueFor("b", 1);
		sqlite.prepare("UPDATE notifications SET sent_at = 5 WHERE id = 'a-n000'").run();
		await markSubscriptionUnsubscribed(db, "a");
		expect(sentAt("a-n000")).toBe(5);
		expect(sentAt("a-n001")).not.toBeNull();
		expect(sentAt("b-n000")).toBeNull();
	});

	it("all-for-address: stamps every subscription of that address and nothing else", async () => {
		addSub("a1", "reader@example.com");
		addSub("a2", "reader@example.com", { slug: "other" });
		addSub("b", "b@example.com");
		queueFor("a1", 1);
		queueFor("a2", 1);
		queueFor("b", 1);
		expect(await markAllSubscriptionsUnsubscribedForEmail(db, "READER@example.com")).toBe(2);
		expect(sentAt("a1-n000")).not.toBeNull();
		expect(sentAt("a2-n000")).not.toBeNull();
		expect(sentAt("b-n000")).toBeNull();
		expect(await markAllSubscriptionsUnsubscribedForEmail(db, "reader@example.com")).toBe(0);
	});
});
