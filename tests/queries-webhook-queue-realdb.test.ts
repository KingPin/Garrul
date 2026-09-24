/**
 * Webhook delivery queue queries against REAL SQLite (every migration applied).
 *
 * src/lib/webhook.ts drives these from the retry cron; this pins the SQL
 * itself: due-only listing in schedule order, the delivered / retry / giveup
 * transitions, a prune that never drops a pending row, and the endpoint
 * fail counter that auto-disables once and remembers when.
 */
import { describe, it, expect } from "vitest";
import {
	enqueueWebhookDelivery,
	incrementWebhookFailCount,
	listPendingWebhookDeliveries,
	markWebhookDelivered,
	markWebhookFailed,
	pruneWebhookDeliveries,
	resetWebhookFailCount,
} from "../src/db/queries";
import { adminHarness } from "./helpers/admin-sqlite";

const setup = () => {
	const h = adminHarness();
	h.sqlite
		.prepare(
			`INSERT INTO webhook_endpoints (id, url, adapter, enabled, created_at, updated_at)
			 VALUES ('w1', 'https://hooks.example.com/x', 'generic', 1, 1, 1)`,
		)
		.run();
	const delivery = (id: string) =>
		h.sqlite
			.prepare("SELECT status, attempts, last_error, next_attempt_at FROM webhook_deliveries WHERE id = ?")
			.get(id) as { status: string; attempts: number; last_error: string | null; next_attempt_at: number };
	const endpoint = () =>
		h.sqlite
			.prepare("SELECT enabled, fail_count, disabled_at FROM webhook_endpoints WHERE id = 'w1'")
			.get() as { enabled: number; fail_count: number; disabled_at: number | null };
	return { db: h.env.DB, sqlite: h.sqlite, delivery, endpoint };
};

describe("webhook delivery queue", () => {
	it("lists only due pending rows, earliest first, up to the limit", async () => {
		const { db } = setup();
		const late = await enqueueWebhookDelivery(db, "w1", "comment.posted", "{}", 300);
		const early = await enqueueWebhookDelivery(db, "w1", "comment.posted", "{}", 100);
		const mid = await enqueueWebhookDelivery(db, "w1", "comment.posted", "{}", 200);
		await enqueueWebhookDelivery(db, "w1", "comment.posted", "{}", 999);
		await markWebhookDelivered(db, mid);

		const due = await listPendingWebhookDeliveries(db, 300, 10);
		expect(due.map((d) => d.id)).toEqual([early, late]);
		expect(due[0]).toMatchObject({ status: "pending", attempts: 0, event: "comment.posted" });
		expect((await listPendingWebhookDeliveries(db, 300, 1)).map((d) => d.id)).toEqual([early]);
	});

	it("moves a row through retry, giveup and delivered", async () => {
		const { db, delivery } = setup();
		const id = await enqueueWebhookDelivery(db, "w1", "comment.spam", "{}", 1);
		await markWebhookFailed(db, id, 5000, "HTTP 503");
		expect(delivery(id)).toEqual({
			status: "pending",
			attempts: 1,
			last_error: "HTTP 503",
			next_attempt_at: 5000,
		});
		await markWebhookFailed(db, id, null, "HTTP 410");
		expect(delivery(id)).toMatchObject({ status: "giveup", attempts: 2, next_attempt_at: 0 });

		const ok = await enqueueWebhookDelivery(db, "w1", "comment.spam", "{}", 1);
		await markWebhookFailed(db, ok, 10, "timeout");
		await markWebhookDelivered(db, ok);
		expect(delivery(ok)).toMatchObject({ status: "delivered", attempts: 2, last_error: null });
	});

	it("prunes old finished rows but keeps every pending one", async () => {
		const { db, sqlite } = setup();
		const done = await enqueueWebhookDelivery(db, "w1", "e", "{}", 1);
		const dead = await enqueueWebhookDelivery(db, "w1", "e", "{}", 1);
		const waiting = await enqueueWebhookDelivery(db, "w1", "e", "{}", 1);
		await markWebhookDelivered(db, done);
		await markWebhookFailed(db, dead, null, "gone");
		sqlite.prepare("UPDATE webhook_deliveries SET created_at = 1").run();
		const fresh = await enqueueWebhookDelivery(db, "w1", "e", "{}", 1);
		await markWebhookDelivered(db, fresh);

		expect(await pruneWebhookDeliveries(db, 1000)).toBe(2);
		const left = (sqlite.prepare("SELECT id FROM webhook_deliveries").all() as Array<{ id: string }>)
			.map((r) => r.id)
			.sort();
		expect(left).toEqual([waiting, fresh].sort());
	});

	it("counts failures, auto-disables once keeping the first timestamp, and resets", async () => {
		const { db, endpoint } = setup();
		await incrementWebhookFailCount(db, "w1", null);
		expect(endpoint()).toEqual({ enabled: 1, fail_count: 1, disabled_at: null });
		await incrementWebhookFailCount(db, "w1", 111);
		await incrementWebhookFailCount(db, "w1", 222);
		expect(endpoint()).toEqual({ enabled: 0, fail_count: 3, disabled_at: 111 });
		await resetWebhookFailCount(db, "w1");
		expect(endpoint()).toEqual({ enabled: 0, fail_count: 0, disabled_at: null });
	});
});
