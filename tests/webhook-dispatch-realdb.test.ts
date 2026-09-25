/**
 * fireWebhook / runWebhookRetries failure edges against REAL SQLite, with the
 * receiver a stubbed fetch.
 *
 * A first-attempt success must sign the body and clear a stale fail count.
 * A broken endpoint lookup, a missing execution context, a crashing retry and
 * a failing prune must each be logged and swallowed: the webhook path runs
 * after the comment is already saved and may never fail the request or the cron.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { enqueueWebhookDelivery } from "../src/db/queries";
import { fireWebhook, runWebhookRetries } from "../src/lib/webhook";
import { verifyWebhookSignature } from "../src/lib/webhook-sig";
import { adminHarness } from "./helpers/admin-sqlite";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// Event names of every structured log line written while `fn` runs.
const loggedEvents = () => {
	const lines: string[] = [];
	const grab = (line: unknown) => {
		lines.push(JSON.parse(String(line)).msg);
	};
	vi.spyOn(console, "log").mockImplementation(grab);
	vi.spyOn(console, "error").mockImplementation(grab);
	return lines;
};

const PAYLOAD = {
	event: "comment.posted" as const,
	comment_id: "c1",
	post_slug: "p",
	user_id: "u1",
	ts: 1,
};

// Wrap the D1 stub so any statement whose SQL matches `pattern` throws.
const breaking = (db: D1Database, pattern: RegExp): D1Database =>
	({
		prepare(sql: string) {
			if (pattern.test(sql)) throw new Error("d1 unavailable");
			return db.prepare(sql);
		},
	}) as unknown as D1Database;

const stubFetch = () => {
	const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
			return new Response("ok", { status: 200 });
		}),
	);
	return calls;
};

describe("fireWebhook", () => {
	it("signs a first-attempt delivery and clears the endpoint's stale fail count", async () => {
		const { env, sqlite } = adminHarness();
		const secret = "s".repeat(32);
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, secret, adapter, enabled, fail_count, created_at, updated_at)
				 VALUES ('w1', 'https://hooks.example.com/h', ?, 'generic', 1, 4, 1, 1)`,
			)
			.run(secret);
		const calls = stubFetch();
		const pending: Promise<unknown>[] = [];
		fireWebhook(env, { waitUntil: (p) => pending.push(p) }, PAYLOAD);
		await Promise.all(pending);

		expect(calls.map((c) => c.url)).toEqual(["https://hooks.example.com/h"]);
		const header = calls[0]?.headers["x-garrul-signature"] ?? "";
		expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(await verifyWebhookSignature(secret, calls[0]?.body ?? "", header)).toBe(true);
		expect(await verifyWebhookSignature("wrong-secret".padEnd(32, "x"), calls[0]?.body ?? "", header)).toBe(false);
		expect(sqlite.prepare("SELECT fail_count FROM webhook_endpoints").get()).toEqual({ fail_count: 0 });
	});

	it("sends nothing without an execution context or when the endpoint lookup fails", async () => {
		const { env, sqlite } = adminHarness();
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, adapter, enabled, created_at, updated_at)
				 VALUES ('w1', 'https://hooks.example.com/h', 'generic', 1, 1, 1)`,
			)
			.run();
		const calls = stubFetch();
		const events = loggedEvents();
		fireWebhook(env, undefined, PAYLOAD);

		const pending: Promise<unknown>[] = [];
		fireWebhook({ ...env, DB: breaking(env.DB, /FROM webhook_endpoints/) }, { waitUntil: (p) => pending.push(p) }, PAYLOAD);
		await expect(Promise.all(pending)).resolves.toBeDefined();
		expect(calls).toEqual([]);
		expect(events).toEqual(["webhook.skipped_no_ctx", "webhook.load_endpoints"]);
	});
});

describe("runWebhookRetries failure isolation", () => {
	it("survives a crashing retry and a failing prune, without blocking a healthy delivery", async () => {
		const { env, sqlite } = adminHarness();
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, adapter, enabled, created_at, updated_at)
				 VALUES ('w1', 'https://hooks.example.com/h', 'generic', 1, 1, 1)`,
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, adapter, enabled, created_at, updated_at)
				 VALUES ('w2', 'https://hooks.example.com/healthy', 'generic', 1, 1, 1)`,
			)
			.run();
		await enqueueWebhookDelivery(env.DB, "w1", "comment.posted", "{}", 1);
		await enqueueWebhookDelivery(env.DB, "w2", "comment.posted", "{}", 1);
		const calls = stubFetch();
		const events = loggedEvents();
		// The DB stub only sees SQL text, not bound args, so isolate the crash to
		// the batch's *first* endpoint lookup (w1's) rather than trying to target
		// it by id: prune breaks every time (it isn't per-row).
		let brokeOnce = false;
		const db = {
			prepare(sql: string) {
				if (/FROM webhook_endpoints WHERE id/.test(sql) && !brokeOnce) {
					brokeOnce = true;
					throw new Error("d1 unavailable");
				}
				if (/DELETE FROM webhook_deliveries/.test(sql)) throw new Error("d1 unavailable");
				return env.DB.prepare(sql);
			},
		} as unknown as D1Database;
		await expect(runWebhookRetries({ ...env, DB: db })).resolves.toBeUndefined();
		expect(calls.map((c) => c.url)).toEqual(["https://hooks.example.com/healthy"]);
		expect(events).toEqual(["webhook.retry_crash", "webhook.prune_failed"]);
	});
});
