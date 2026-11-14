/**
 * runWebhookRetries against REAL SQLite, with the receivers a stubbed fetch.
 *
 * One cron pass must: deliver a due row and clear its endpoint's fail count;
 * give up on a row whose endpoint was paused; reschedule a failed retry on
 * the backoff schedule; refuse to follow a redirect; and, on the last retry,
 * give up and auto-disable an endpoint that reaches the failure threshold.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { enqueueWebhookDelivery } from "../src/db/queries";
import { RETRY_SCHEDULE_MS, dispatchWebhook, runWebhookRetries } from "../src/lib/webhook";
import { adminHarness } from "./helpers/admin-sqlite";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("runWebhookRetries", () => {
	it("delivers, reschedules, gives up and auto-disables in one pass", async () => {
		const { env, sqlite } = adminHarness();
		const endpoint = sqlite.prepare(
			`INSERT INTO webhook_endpoints (id, url, adapter, enabled, fail_count, created_at, updated_at)
			 VALUES (?, ?, 'generic', ?, ?, 1, 1)`,
		);
		endpoint.run("ok", "https://ok.example.com/h", 1, 3);
		endpoint.run("paused", "https://paused.example.com/h", 0, 0);
		endpoint.run("down", "https://down.example.com/h", 1, 9);
		endpoint.run("moved", "https://moved.example.com/h", 1, 0);
		const enqueue = async (ep: string, attempts: number) => {
			const id = await enqueueWebhookDelivery(env.DB, ep, "comment.posted", '{"x":1}', 1);
			sqlite.prepare("UPDATE webhook_deliveries SET attempts = ? WHERE id = ?").run(attempts, id);
			return id;
		};
		const delivered = await enqueue("ok", 0);
		const paused = await enqueue("paused", 0);
		const retried = await enqueue("down", 1);
		const last = await enqueue("down", RETRY_SCHEDULE_MS.length - 1);
		const moved = await enqueue("moved", 0);

		const fetchMock = vi.fn(async (url: string) => {
			const host = new URL(url).host;
			if (host.startsWith("ok.")) return new Response("", { status: 200 });
			if (host.startsWith("moved.")) return new Response("", { status: 307 });
			return new Response("", { status: 503 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const before = Date.now();
		await runWebhookRetries(env as never);

		const row = (id: string) =>
			sqlite
				.prepare("SELECT status, last_error, next_attempt_at FROM webhook_deliveries WHERE id = ?")
				.get(id) as { status: string; last_error: string | null; next_attempt_at: number };
		const ep = (id: string) =>
			sqlite.prepare("SELECT enabled, fail_count, disabled_at FROM webhook_endpoints WHERE id = ?").get(id) as {
				enabled: number;
				fail_count: number;
				disabled_at: number | null;
			};

		expect(row(delivered).status).toBe("delivered");
		expect(ep("ok").fail_count).toBe(0);
		expect(row(paused)).toMatchObject({ status: "giveup", last_error: "endpoint_disabled" });
		expect(row(retried)).toMatchObject({ status: "pending", last_error: "http_503" });
		expect(row(retried).next_attempt_at).toBeGreaterThanOrEqual(before + (RETRY_SCHEDULE_MS[2] as number));
		expect(row(last)).toMatchObject({ status: "giveup", last_error: "http_503" });
		expect(ep("down")).toMatchObject({ enabled: 0, fail_count: 10 });
		expect(ep("down").disabled_at).not.toBeNull();
		expect(row(moved)).toMatchObject({ status: "pending", last_error: "redirect_refused" });
		// The paused endpoint was never contacted.
		expect(fetchMock.mock.calls.map(([u]) => new URL(u).host)).not.toContain("paused.example.com");
	});

	it("does nothing when no delivery is due", async () => {
		const { env } = adminHarness();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await runWebhookRetries(env as never);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Discord 429 handling", () => {
	const throttled = () =>
		new Response(JSON.stringify({ retry_after: 2.5 }), {
			status: 429,
			headers: { "retry-after": "3" },
		});

	const run = async (adapter: string, attempts: number) => {
		const { env, sqlite } = adminHarness();
		const e = env as unknown as Record<string, unknown>;
		e.DISCORD_BOT_TOKEN = "fake-token";
		e.DISCORD_PUBLIC_KEY = "ab".repeat(32);
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, adapter, enabled, fail_count, created_at, updated_at)
				 VALUES ('e', ?, ?, 1, 9, 1, 1)`,
			)
			.run(adapter === "discord_bot" ? "666666666666666666" : "https://discord.com/api/webhooks/1/x", adapter);
		const id = await enqueueWebhookDelivery(env.DB, "e", "comment.posted", '{"x":1}', 1);
		sqlite.prepare("UPDATE webhook_deliveries SET attempts = ? WHERE id = ?").run(attempts, id);
		vi.stubGlobal("fetch", vi.fn(async () => throttled()));
		const before = Date.now();
		await runWebhookRetries(env as never);
		const row = sqlite
			.prepare("SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE id = ?")
			.get(id) as { status: string; attempts: number; next_attempt_at: number };
		const ep = sqlite.prepare("SELECT enabled, fail_count FROM webhook_endpoints WHERE id = 'e'").get() as {
			enabled: number;
			fail_count: number;
		};
		return { row, ep, before };
	};

	it.each(["discord"])("%s: reschedules at max(backoff, retry_after), one attempt", async (adapter) => {
		const { row, before } = await run(adapter, 0);
		expect(row.status).toBe("pending");
		expect(row.attempts).toBe(1);
		// backoff[1] (5 min) beats retry_after (2.5 s)
		expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + (RETRY_SCHEDULE_MS[1] as number));
	});

	it.each(["discord"])("%s: a final 429 never raises fail_count", async (adapter) => {
		const { row, ep } = await run(adapter, RETRY_SCHEDULE_MS.length - 1);
		expect(row.status).toBe("giveup");
		expect(ep).toEqual({ enabled: 1, fail_count: 9 });
	});

	it("other adapters still count a final 429", async () => {
		const { ep } = await run("generic", RETRY_SCHEDULE_MS.length - 1);
		expect(ep).toMatchObject({ enabled: 0, fail_count: 10 });
	});

	it("a first-attempt 429 waits for retry_after when it exceeds the first backoff", async () => {
		const { env, sqlite } = adminHarness();
		sqlite
			.prepare(
				`INSERT INTO webhook_endpoints (id, url, adapter, enabled, fail_count, created_at, updated_at)
				 VALUES ('e', 'https://discord.com/api/webhooks/1/x', 'discord', 1, 0, 1, 1)`,
			)
			.run();
		sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)").run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ retry_after: 600 }), { status: 429 })),
		);
		const before = Date.now();
		await dispatchWebhook(env as never, {
			event: "comment.posted",
			comment_id: "c1",
			post_slug: "p",
			user_id: "u1",
			ts: 1,
		});
		const row = sqlite.prepare("SELECT next_attempt_at FROM webhook_deliveries").get() as { next_attempt_at: number };
		expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + 600_000);
	});
});
