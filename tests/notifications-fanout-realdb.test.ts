/**
 * Set-based subscriber fan-out (src/db/queries.ts) and the digest-side
 * guards that protect the same queue.
 *
 * Real SQLite with every migration applied. `makeD1` from the admin harness
 * enforces D1's 100-bound-parameter cap, which is the whole point of the
 * digest boundary tests below.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/admin-sqlite";
import { enqueueNotificationsForPost } from "../src/db/queries";

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
