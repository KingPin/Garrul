/**
 * Per-address subscription queries (src/db/queries.ts).
 *
 * These three back both management surfaces — the signed-in reader's widget
 * panel and the emailed landing page — so the invariants here are the ones the
 * routes above them assume rather than re-check:
 *
 *   - address scoping is absolute (one reader never sees another's rows), and
 *   - the address is matched lowercased, because `subscriptions.email` is
 *     always written through `.toLowerCase()` while `users.email` keeps
 *     whatever casing the OAuth provider returned. A case-sensitive compare
 *     here shows a GitHub user with a capitalised address an empty list.
 *
 * Real SQLite with every migration applied.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	getSubscriptionForEmailAndSlug,
	listActiveSubscriptionsForEmail,
	markAllSubscriptionsUnsubscribedForEmail,
} from "../src/db/queries";

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

const READER = "reader@example.com";
const OTHER = "someone.else@example.com";
const T0 = 1_700_000_000_000;

let sqlite: DatabaseSync;
let db: D1Database;

const addPost = (slug: string, title: string | null): void => {
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(slug, title, null, T0);
};

/** One subscription row. `at` orders the list; `cancelled` stamps it. */
const addSub = (
	id: string,
	slug: string,
	email: string,
	opts: { at?: number; cancelled?: boolean } = {},
): void => {
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
			`${id}-token`,
			T0,
			opts.at ?? T0,
			opts.cancelled ? T0 : null,
		);
};

const cancelledAt = (id: string): number | null =>
	(
		sqlite
			.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(id) as { unsubscribed_at: number | null }
	).unsubscribed_at;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	db = makeD1(sqlite) as D1Database;
});

describe("listActiveSubscriptionsForEmail", () => {
	it("returns only that address's rows, newest first, with titles", async () => {
		addPost("alpha", "Alpha");
		addPost("beta", "Beta");
		addPost("gamma", "Gamma");
		addSub("s1", "alpha", READER, { at: T0 + 1 });
		addSub("s2", "beta", READER, { at: T0 + 2 });
		addSub("s3", "gamma", OTHER, { at: T0 + 3 });

		const list = await listActiveSubscriptionsForEmail(db, READER);

		expect(list.map((r) => r.id)).toEqual(["s2", "s1"]);
		expect(list.map((r) => r.title)).toEqual(["Beta", "Alpha"]);
	});

	it("excludes already-cancelled rows", async () => {
		addPost("alpha", "Alpha");
		addPost("beta", "Beta");
		addSub("s1", "alpha", READER);
		addSub("s2", "beta", READER, { cancelled: true });

		const list = await listActiveSubscriptionsForEmail(db, READER);

		expect(list.map((r) => r.id)).toEqual(["s1"]);
	});

	it("keeps a subscription whose post row does not exist yet", async () => {
		// `posts` rows are created on first comment, so a reader can follow a
		// slug that has none. An inner join would hide it — and a subscription
		// you cannot see is one you cannot cancel.
		addSub("s1", "not-commented-on-yet", READER);

		const list = await listActiveSubscriptionsForEmail(db, READER);

		expect(list).toHaveLength(1);
		expect(list[0]?.post_slug).toBe("not-commented-on-yet");
		expect(list[0]?.title).toBeNull();
	});

	it("matches the address case-insensitively", async () => {
		addPost("alpha", "Alpha");
		addSub("s1", "alpha", READER);

		// What `users.email` looks like when GitHub returns it capitalised.
		const list = await listActiveSubscriptionsForEmail(db, "Reader@Example.com");

		expect(list.map((r) => r.id)).toEqual(["s1"]);
	});

	it("is empty for an address with nothing", async () => {
		expect(await listActiveSubscriptionsForEmail(db, READER)).toEqual([]);
	});
});

describe("markAllSubscriptionsUnsubscribedForEmail", () => {
	it("stamps every active row for the address and nothing else", async () => {
		addSub("s1", "alpha", READER);
		addSub("s2", "beta", READER);
		addSub("s3", "gamma", OTHER);

		expect(await markAllSubscriptionsUnsubscribedForEmail(db, READER)).toBe(2);

		expect(cancelledAt("s1")).not.toBeNull();
		expect(cancelledAt("s2")).not.toBeNull();
		expect(cancelledAt("s3")).toBeNull();
	});

	it("does not overwrite an existing cancellation timestamp", async () => {
		// That timestamp is the record of when the reader actually asked to
		// stop; a second click must not move it.
		addSub("s1", "alpha", READER, { cancelled: true });
		const original = cancelledAt("s1");

		expect(await markAllSubscriptionsUnsubscribedForEmail(db, READER)).toBe(0);

		expect(cancelledAt("s1")).toBe(original);
	});

	it("matches the address case-insensitively", async () => {
		addSub("s1", "alpha", READER);

		expect(
			await markAllSubscriptionsUnsubscribedForEmail(db, "READER@EXAMPLE.COM"),
		).toBe(1);
		expect(cancelledAt("s1")).not.toBeNull();
	});
});

describe("getSubscriptionForEmailAndSlug", () => {
	it("finds the row for (slug, address)", async () => {
		addSub("s1", "alpha", READER);

		const row = await getSubscriptionForEmailAndSlug(db, READER, "alpha");

		expect(row?.id).toBe("s1");
	});

	it("does not cross addresses", async () => {
		addSub("s1", "alpha", OTHER);

		expect(await getSubscriptionForEmailAndSlug(db, READER, "alpha")).toBeNull();
	});

	it("returns cancelled rows too — the caller decides what counts", async () => {
		addSub("s1", "alpha", READER, { cancelled: true });

		const row = await getSubscriptionForEmailAndSlug(db, READER, "alpha");

		expect(row?.id).toBe("s1");
		expect(row?.unsubscribed_at).not.toBeNull();
	});

	it("matches the address case-insensitively", async () => {
		addSub("s1", "alpha", READER);

		const row = await getSubscriptionForEmailAndSlug(
			db,
			"Reader@Example.com",
			"alpha",
		);

		expect(row?.id).toBe("s1");
	});

	it("is null when the address follows nothing on that slug", async () => {
		addSub("s1", "alpha", READER);

		expect(await getSubscriptionForEmailAndSlug(db, READER, "beta")).toBeNull();
	});
});
