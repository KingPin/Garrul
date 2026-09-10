/**
 * Query-plan coverage for the indexed subscription lookups — email (0017) and
 * unsubscribe token (0024).
 *
 * `countPendingSubscriptionsForEmail` runs once per unauthenticated POST
 * /api/v1/subscribe to enforce the per-email pending cap, and D1 bills rows
 * *read*. The only email-mentioning index before 0017 was `UNIQUE (post_slug,
 * email)`, and SQLite can only use a composite index for a *prefix* of its
 * columns — so an email-only predicate was a full table scan an attacker could
 * trigger for free.
 *
 * A functional test can't see the difference: a scan and a seek return the same
 * rows. So these assert the plan, using node:sqlite with every migration
 * applied. If a future migration drops or reorders idx_subs_email_confirmed,
 * this fails instead of the regression shipping silently.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getSubscriptionByToken } from "../src/db/queries";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

let sqlite: DatabaseSync;

beforeAll(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
});

const plan = (sql: string): string =>
	(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
		.map((r) => r.detail)
		.join(" | ");

describe("subscriptions email index", () => {
	it("serves the pending-cap count from the index, not a scan", () => {
		// Verbatim predicate from countPendingSubscriptionsForEmail.
		const detail = plan(
			`SELECT COUNT(*) AS n FROM subscriptions
			  WHERE email = 'a@example.com' AND confirmed_at IS NULL`,
		);
		expect(detail).toContain("idx_subs_email_confirmed");
		expect(detail).not.toContain("SCAN subscriptions");
		// Both predicate columns are in the index, so SQLite never touches the
		// table at all — this is the cheapest shape available.
		expect(detail).toContain("COVERING INDEX");
	});

	it("serves the erasure lookups from the index", () => {
		// eraseUserData deletes an erased account's subscriptions by email.
		for (const sql of [
			`SELECT id FROM subscriptions WHERE email = 'a@example.com'`,
			`DELETE FROM subscriptions WHERE email = 'a@example.com'`,
		]) {
			const detail = plan(sql);
			expect(detail).toContain("idx_subs_email_confirmed");
			expect(detail).not.toContain("SCAN subscriptions");
		}
	});

	it("keeps the per-post fanout on the post_slug index", () => {
		// The digest's confirmed-subscriber fanout is keyed on post_slug, which
		// *is* the prefix of UNIQUE (post_slug, email). The new index must not
		// have displaced it.
		const detail = plan(
			`SELECT id FROM subscriptions
			  WHERE post_slug = 'p' AND unsubscribed_at IS NULL
			    AND confirmed_at IS NOT NULL`,
		);
		expect(detail).not.toContain("SCAN subscriptions");
	});

	it("does not make email unique — one address subscribes to many posts", () => {
		const now = Date.now();
		const ins = sqlite.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		ins.run("s1", "post-a", "dup@example.com", "t1", now);
		expect(() =>
			ins.run("s2", "post-b", "dup@example.com", "t2", now),
		).not.toThrow();
	});
});

describe("subscriptions token index", () => {
	it("serves the unsubscribe-token lookup from the index, not a scan", () => {
		// Verbatim projection and predicate from getSubscriptionByToken, which
		// backs the unauthenticated CARVE_OUT GET and the un-rate-limited RFC
		// 8058 one-click POST. Before 0024 this was `SCAN subscriptions` for
		// every request, including one carrying a token that does not exist.
		const detail = plan(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at, locale
			   FROM subscriptions WHERE token = 'deadbeef'`,
		);
		expect(detail).toContain("idx_subs_token");
		expect(detail).not.toContain("SCAN subscriptions");
	});

	it("keeps one address able to hold many tokens", () => {
		// idx_subs_token is deliberately not UNIQUE — see the migration header.
		const now = Date.now();
		const ins = sqlite.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		);
		ins.run("t-s1", "post-c", "many@example.com", "same-token", now);
		expect(() =>
			ins.run("t-s2", "post-d", "many@example.com", "same-token", now),
		).not.toThrow();
	});
});

describe("getSubscriptionByToken shape guard", () => {
	// A D1 that fails the test if it is ever asked to prepare a statement. The
	// point of the guard is that junk input costs no D1 read at all, and only a
	// stub that refuses to be queried can prove that.
	const refusingDb = {
		prepare: () => {
			throw new Error("getSubscriptionByToken queried D1 for a junk token");
		},
	} as unknown as D1Database;

	const good = "a".repeat(64);

	it.each([
		["empty", ""],
		["too short", "a".repeat(63)],
		["too long", "a".repeat(65)],
		["uppercase hex", "A".repeat(64)],
		["non-hex", "z".repeat(64)],
		["hex with a wildcard", `${"a".repeat(63)}%`],
		["sql-ish", "' OR 1=1 --"],
	])("returns null without querying: %s", async (_label, token) => {
		await expect(getSubscriptionByToken(refusingDb, token)).resolves.toBeNull();
	});

	it("still queries for a well-formed token", async () => {
		// The guard must not become the access control. A random 64-hex token is
		// indistinguishable from a real one until D1 answers, which is why the
		// index exists.
		let asked = "";
		const db = {
			prepare: (sql: string) => {
				asked = sql;
				return { bind: () => ({ first: async () => null }) };
			},
		} as unknown as D1Database;
		await expect(getSubscriptionByToken(db, good)).resolves.toBeNull();
		expect(asked).toContain("FROM subscriptions WHERE token = ?");
	});
});
