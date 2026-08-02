/**
 * upsertSubscription / confirmSubscription conflict semantics (M5).
 *
 * POST /api/v1/subscribe is unauthenticated and accepts an arbitrary address.
 * The upsert used to run `token = excluded.token` and `unsubscribed_at = NULL`
 * unconditionally on conflict, so anyone who knew (or guessed) an address could:
 *
 *   - invalidate every unsubscribe link already sitting in that mailbox, and
 *   - resurrect a subscription the recipient had cancelled — with `confirmed_at`
 *     preserved, so no confirmation mail fired and the victim was never told.
 *
 * Real SQLite with every migration applied: the whole finding lives in an
 * ON CONFLICT clause, which a stub can't exercise.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	confirmSubscription,
	getSubscriptionByConfirmToken,
	listActiveSubscriptionsForPost,
	markSubscriptionUnsubscribed,
	upsertSubscription,
	type Subscription,
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

const SLUG = "notify-me";
const EMAIL = "reader@example.com";

let db: D1Database;

beforeEach(() => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Notify me", null, 1_700_000_000_000);
	db = makeD1(sqlite) as D1Database;
});

/** What an anonymous POST does: fresh tokens, no proof of inbox ownership. */
const stranger = (token: string, confirmToken: string): Promise<Subscription> =>
	upsertSubscription(db, SLUG, EMAIL, token, confirmToken, false);

/** What the auto-confirm path does: a signed-in owner of this exact address. */
const owner = (token: string): Promise<Subscription> =>
	upsertSubscription(db, SLUG, EMAIL, token, null, true);

/** A live, confirmed subscription, as the double-opt-in loop leaves it. */
const confirmed = async (): Promise<Subscription> => {
	const sub = await stranger("tok-original", "confirm-original");
	await confirmSubscription(db, sub.id);
	// Re-read: the upsert's return value predates the confirm.
	const row = await getSubscriptionByConfirmToken(db, "confirm-original");
	if (!row) throw new Error("test setup: confirmed row not found");
	return row;
};

describe("upsertSubscription — re-subscribe by a stranger", () => {
	it("keeps the unsubscribe token of a confirmed row", async () => {
		await confirmed();
		const after = await stranger("tok-attacker", "confirm-attacker");
		// Every unsubscribe link already in the mailbox still works.
		expect(after.token).toBe("tok-original");
	});

	it("is inert on a live confirmed row", async () => {
		const before = await confirmed();
		const after = await stranger("tok-attacker", "confirm-attacker");
		expect(after.confirmed_at).toBe(before.confirmed_at);
		expect(after.confirm_token).toBe("confirm-original");
		expect(after.unsubscribed_at).toBeNull();
	});

	it("does not resurrect a cancelled subscription", async () => {
		const sub = await confirmed();
		await markSubscriptionUnsubscribed(db, sub.id);

		const after = await stranger("tok-attacker", "confirm-attacker");
		expect(after.unsubscribed_at).not.toBeNull();
		// Reset to pending, so coming back requires the confirm link — which is
		// what actually reaches the recipient.
		expect(after.confirmed_at).toBeNull();
		expect(after.token).toBe("tok-original");
		// Nothing is delivered in the meantime.
		expect(await listActiveSubscriptionsForPost(db, SLUG)).toHaveLength(0);
	});

	it("retires the old confirm link when a cancelled row is re-requested", async () => {
		const sub = await confirmed();
		await markSubscriptionUnsubscribed(db, sub.id);
		await stranger("tok-attacker", "confirm-new");

		expect(await getSubscriptionByConfirmToken(db, "confirm-original")).toBeNull();
		expect(
			(await getSubscriptionByConfirmToken(db, "confirm-new"))?.id,
		).toBe(sub.id);
	});

	it("refreshes the confirm token of a still-unconfirmed row (resend)", async () => {
		await stranger("tok-original", "confirm-first");
		const after = await stranger("tok-second", "confirm-second");
		expect(after.confirm_token).toBe("confirm-second");
		expect(after.confirmed_at).toBeNull();
		// The unsubscribe token still isn't the requester's to rotate.
		expect(after.token).toBe("tok-original");
	});
});

describe("upsertSubscription — auto-confirm path", () => {
	it("revives a cancelled row immediately for a proven owner", async () => {
		const sub = await confirmed();
		await markSubscriptionUnsubscribed(db, sub.id);

		const after = await owner("tok-owner");
		expect(after.unsubscribed_at).toBeNull();
		expect(after.confirmed_at).not.toBeNull();
		expect(after.confirm_token).toBeNull();
		// Rotation is allowed here: they just proved they hold the mailbox.
		expect(after.token).toBe("tok-owner");
		expect(await listActiveSubscriptionsForPost(db, SLUG)).toHaveLength(1);
	});

	it("confirms a pending row without an email round-trip", async () => {
		await stranger("tok-original", "confirm-first");
		const after = await owner("tok-owner");
		expect(after.confirmed_at).not.toBeNull();
		expect(after.confirm_token).toBeNull();
	});
});

describe("confirmSubscription", () => {
	it("reports whether this call was the one that confirmed", async () => {
		const sub = await stranger("tok", "confirm-tok");
		expect(await confirmSubscription(db, sub.id)).toBe(true);
		// A mail-client prefetch followed by the human's click: still fine, but
		// only the first one did anything.
		expect(await confirmSubscription(db, sub.id)).toBe(false);
	});

	it("keeps the token alive so a prefetched link still renders for the human", async () => {
		const sub = await stranger("tok", "confirm-tok");
		await confirmSubscription(db, sub.id);
		expect((await getSubscriptionByConfirmToken(db, "confirm-tok"))?.id).toBe(
			sub.id,
		);
	});

	it("cannot un-cancel a subscription", async () => {
		// The link stays valid after confirming, so it must not double as a
		// resurrection primitive once the recipient unsubscribes.
		const sub = await confirmed();
		await markSubscriptionUnsubscribed(db, sub.id);

		expect(await confirmSubscription(db, sub.id)).toBe(false);
		expect(await listActiveSubscriptionsForPost(db, SLUG)).toHaveLength(0);
	});

	it("clears unsubscribed_at when a re-subscribed row is confirmed", async () => {
		const sub = await confirmed();
		await markSubscriptionUnsubscribed(db, sub.id);
		await stranger("tok-attacker", "confirm-new");

		// Only the recipient can follow this link out of their own mailbox.
		expect(await confirmSubscription(db, sub.id)).toBe(true);
		expect(await listActiveSubscriptionsForPost(db, SLUG)).toHaveLength(1);
	});
});
