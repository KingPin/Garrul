/**
 * The admin list filters (comments, audit log, subscriptions) against REAL
 * SQLite. Each filter adds one WHERE clause; this pins that every clause
 * narrows to the right rows, that LIKE wildcards in a search are literal, and
 * that the host filter resolves through posts.url.
 */
import { describe, it, expect } from "vitest";
import { adminListAudit, adminListComments, adminListSubscriptions } from "../src/db/queries";
import { ADMIN_ID, MOD_ID, adminHarness } from "./helpers/admin-sqlite";

const seeded = () => {
	const h = adminHarness();
	const run = (sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).run(...(args as never[]));
	run(
		`INSERT INTO posts (slug, title, url, created_at) VALUES
		 ('a', 'A', 'https://blog.example/a', 1), ('b', 'B', 'https://other.example/b', 1)`,
	);
	const comment = `INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
	                   renderer_version, status, ip_hash, user_agent, created_at, depth)
	                 VALUES (?, ?, NULL, ?, ?, '<p>x</p>', 3, ?, 'h', 'ua', ?, 0)`;
	run(comment, "c1", "a", ADMIN_ID, "Hello 100% World", "approved", 10);
	run(comment, "c2", "a", MOD_ID, "hello 100 world", "pending", 20);
	run(comment, "c3", "b", MOD_ID, "goodbye", "approved", 30);
	run(
		`INSERT INTO reports (id, comment_id, reporter_user_id, reason, status, created_at)
		 VALUES ('r1', 'c3', ?, 'spam', 'open', 1)`,
		ADMIN_ID,
	);
	const audit = `INSERT INTO audit_log (id, admin_id, action, target_kind, target_id, created_at)
	               VALUES (?, ?, ?, ?, ?, ?)`;
	run(audit, "a1", ADMIN_ID, "comment.spam", "comment", "c1", 10);
	run(audit, "a2", MOD_ID, "comment.approve", "comment", "c3", 20);
	run(audit, "a3", ADMIN_ID, "user.ban", "user", MOD_ID, 30);
	const sub = `INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirmed_at, unsubscribed_at)
	             VALUES (?, ?, ?, ?, ?, ?, ?)`;
	run(sub, "s1", "a", "Ann_1@example.com", "t1", 10, 1, null);
	run(sub, "s2", "a", "annx1@example.com", "t2", 20, null, null);
	run(sub, "s3", "b", "bob@example.com", "t3", 30, 1, 5);
	return h.env.DB;
};

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("adminListComments filters", () => {
	it("narrows by each clause", async () => {
		const db = seeded();
		const list = (f: Parameters<typeof adminListComments>[1]) => adminListComments(db, f, 50, null, null).then(ids);
		expect(await list({})).toEqual(["c1", "c2", "c3"]);
		expect(await list({ status: "pending" })).toEqual(["c2"]);
		expect(await list({ q: "100%" })).toEqual(["c1"]);
		expect(await list({ post_slug: "b" })).toEqual(["c3"]);
		expect(await list({ user_id: MOD_ID })).toEqual(["c2", "c3"]);
		expect(await list({ from: 20 })).toEqual(["c2", "c3"]);
		expect(await list({ to: 20 })).toEqual(["c1"]);
		expect(await list({ host: "other.example" })).toEqual(["c3"]);
		expect(await list({ reported: true })).toEqual(["c3"]);
	});
});

describe("adminListAudit filters", () => {
	it("narrows by each clause, and a host keeps only comment rows on that host", async () => {
		const db = seeded();
		const list = (f: Parameters<typeof adminListAudit>[1]) => adminListAudit(db, f, 50, null, null).then(ids);
		expect(await list({ admin_id: ADMIN_ID })).toEqual(["a1", "a3"]);
		expect(await list({ action: "user.ban" })).toEqual(["a3"]);
		expect(await list({ target_kind: "comment" })).toEqual(["a1", "a2"]);
		expect(await list({ target_id: "c3" })).toEqual(["a2"]);
		expect(await list({ from: 20, to: 30 })).toEqual(["a2"]);
		expect(await list({ host: "blog.example" })).toEqual(["a1"]);
	});
});

describe("adminListSubscriptions filters", () => {
	it("narrows by each clause with literal LIKE wildcards", async () => {
		const db = seeded();
		const list = (f: Parameters<typeof adminListSubscriptions>[1]) =>
			adminListSubscriptions(db, f, 50, null, null).then(ids);
		expect(await list({ q: "ANN_1" })).toEqual(["s1"]);
		expect(await list({ post_slug: "b" })).toEqual(["s3"]);
		expect(await list({ confirmed: true })).toEqual(["s1", "s3"]);
		expect(await list({ confirmed: false })).toEqual(["s2"]);
		expect(await list({ unsubscribed: true })).toEqual(["s3"]);
		expect(await list({ unsubscribed: false })).toEqual(["s1", "s2"]);
		expect(await list({ host: "blog.example" })).toEqual(["s1", "s2"]);
		expect(ids(await adminListSubscriptions(db, {}, 50, 20, "s2"))).toEqual(["s1"]);
	});
});
