/**
 * The global confirmation-email ceiling (issue #64).
 *
 * The endpoint's other two controls both fail against an address-cycling
 * concurrent burst: the IP-keyed rate limiter is a non-atomic read-modify-write
 * on the default Cache API backend (tests/ratelimit.test.ts pins N concurrent
 * requests all getting through), and `PENDING_PER_EMAIL_CAP` binds per address.
 * So the bound has to come from somewhere neither of those reaches.
 *
 * These are the inverse of the racy-limiter test: the same concurrent shape,
 * against a control that is atomic because it is a single D1 statement. Both
 * must keep passing — that one pins what the limiter does NOT give you, and
 * this one pins what makes the endpoint bounded anyway.
 *
 * Real SQLite with the real migrations, so the reserve statement under test is
 * the one that ships, not a re-implementation of it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscriptions } from "../src/routes/api.subscriptions";
import { upsertSubscription } from "../src/db/queries";
import {
	CONFIRM_SEND_BUDGETS,
	reserveConfirmSend,
	type SendBudget,
} from "../src/lib/email-budget";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

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

/**
 * Wraps a D1 stub so every statement yields to the microtask queue before it
 * runs. A real colo's latency hands every in-flight request that gap for free,
 * and it is exactly what breaks the rate limiter's read-then-write. A single
 * atomic statement has no gap to lose, which is what these tests assert.
 */
const withInterleaving = (inner: any): any => ({
	prepare(sql: string) {
		const stmt = inner.prepare(sql);
		return {
			bind(...args: unknown[]) {
				stmt.bind(...args);
				return this;
			},
			async run() {
				await Promise.resolve();
				return stmt.run();
			},
			async first() {
				await Promise.resolve();
				return stmt.first();
			},
			async all() {
				await Promise.resolve();
				return stmt.all();
			},
		};
	},
});

const SLUG = "budget";
const NOW = 1_700_000_000_000;

let sqlite: DatabaseSync;
let env: Bindings;
let sent: string[];

const migrate = (db: DatabaseSync) => {
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
};

beforeEach(() => {
	installMockCaches();
	sent = [];
	vi.stubGlobal("fetch", async (url: string) => {
		sent.push(String(url));
		return new Response("{}", { status: 200 });
	});

	sqlite = new DatabaseSync(":memory:");
	migrate(sqlite);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Budget", null, NOW);

	env = {
		DB: makeD1(sqlite),
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		PUBLIC_BASE_URL: "https://comments.example",
		EMAIL_FROM: "no-reply@example.com",
		EMAIL_PROVIDER: "resend",
		RESEND_API_KEY: "re_test",
	} as unknown as Bindings;
});

afterEach(() => {
	uninstallMockCaches();
	vi.unstubAllGlobals();
});

const subscribe = (body: unknown, ip: string) =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", subscriptions)
		.request(
			"/",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": ip,
				},
				body: JSON.stringify(body),
			},
			env as unknown as Record<string, unknown>,
		);

const readBudget = (scope: string) =>
	sqlite
		.prepare("SELECT window_start, sent FROM email_send_budget WHERE scope = ?")
		.get(scope) as { window_start: number; sent: number } | undefined;

describe("reserveConfirmSend — atomic under concurrency", () => {
	it("lets exactly `max` through when N concurrent callers race one window", async () => {
		// The limiter's failure mode is that all N get through and the bucket
		// advances by one. Here the cap lives in the UPDATE's own WHERE clause, so
		// the N-max losers change zero rows and are told no.
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 3, windowSec: 60 },
		];
		const db = withInterleaving(makeD1(sqlite));
		const N = 12;

		const results = await Promise.all(
			Array.from({ length: N }, () => reserveConfirmSend(db, budgets, NOW)),
		);

		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(results.filter((r) => !r.ok)).toHaveLength(N - 3);
		expect(readBudget("confirm:burst")).toEqual({
			window_start: NOW,
			sent: 3,
		});
	});

	it("names the exhausted scope as the reason", async () => {
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 1, windowSec: 60 },
		];
		const db = makeD1(sqlite);
		expect((await reserveConfirmSend(db, budgets, NOW)).ok).toBe(true);
		const denied = await reserveConfirmSend(db, budgets, NOW);
		expect(denied.ok).toBe(false);
		expect(denied.reason).toBe("confirm:burst");
	});

	it("rolls the window forward once it expires", async () => {
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 2, windowSec: 60 },
		];
		const db = makeD1(sqlite);
		await reserveConfirmSend(db, budgets, NOW);
		await reserveConfirmSend(db, budgets, NOW);
		expect((await reserveConfirmSend(db, budgets, NOW)).ok).toBe(false);

		// One tick past the window: the reserve statement resets the count itself,
		// so nothing has to sweep expired rows.
		const later = NOW + 60_001;
		expect((await reserveConfirmSend(db, budgets, later)).ok).toBe(true);
		expect(readBudget("confirm:burst")).toEqual({
			window_start: later,
			sent: 1,
		});
	});

	it("denies when a later budget is spent even if an earlier one has room", async () => {
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 10, windowSec: 60 },
			{ scope: "confirm:daily", max: 1, windowSec: 86_400 },
		];
		const db = makeD1(sqlite);
		expect((await reserveConfirmSend(db, budgets, NOW)).ok).toBe(true);
		const denied = await reserveConfirmSend(db, budgets, NOW);
		expect(denied.ok).toBe(false);
		expect(denied.reason).toBe("confirm:daily");
		// The burst grant is deliberately not handed back on a denial — see the
		// note on reserveConfirmSend. It over-counts by one, in the strict
		// direction, rather than adding a write to an attacker-driven path.
		expect(readBudget("confirm:burst")?.sent).toBe(2);
	});

	it("release hands the slot back", async () => {
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 1, windowSec: 60 },
		];
		const db = makeD1(sqlite);
		const held = await reserveConfirmSend(db, budgets, NOW);
		expect(held.ok).toBe(true);
		await held.release();
		expect(readBudget("confirm:burst")?.sent).toBe(0);
		expect((await reserveConfirmSend(db, budgets, NOW)).ok).toBe(true);
	});

	it("release declines to decrement a window that has already rolled", async () => {
		const budgets: SendBudget[] = [
			{ scope: "confirm:burst", max: 5, windowSec: 60 },
		];
		const db = makeD1(sqlite);
		const held = await reserveConfirmSend(db, budgets, NOW);
		// A later request rolls the window. The stale release must not spend a
		// slot out of the new one.
		await reserveConfirmSend(db, budgets, NOW + 60_001);
		await held.release();
		expect(readBudget("confirm:burst")?.sent).toBe(1);
	});
});

describe("reserveConfirmSend — fails open on infrastructure trouble", () => {
	it("allows the send when the budget table is missing", async () => {
		// An install that somehow never applied 0018 must degrade to the old
		// behaviour, not refuse every subscription.
		sqlite.exec("DROP TABLE email_send_budget");
		const warn = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await reserveConfirmSend(makeD1(sqlite), CONFIRM_SEND_BUDGETS, NOW);
		expect(r.ok).toBe(true);
		warn.mockRestore();
	});

	it("allows the send when a budget row was never seeded", async () => {
		sqlite.exec("DELETE FROM email_send_budget WHERE scope = 'confirm:burst'");
		const warn = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await reserveConfirmSend(makeD1(sqlite), CONFIRM_SEND_BUDGETS, NOW);
		expect(r.ok).toBe(true);
		warn.mockRestore();
	});

	it("allows the send when D1 throws", async () => {
		const broken: any = {
			prepare() {
				throw new Error("D1_ERROR: no connection");
			},
		};
		const warn = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await reserveConfirmSend(broken, CONFIRM_SEND_BUDGETS, NOW);
		expect(r.ok).toBe(true);
		warn.mockRestore();
	});
});

describe("POST /subscribe — the burst is bounded end to end", () => {
	it("caps confirmation email under an address-cycling distributed burst", async () => {
		// The worst case the issue describes, and then some: every request gets a
		// fresh email address AND a fresh source address, so neither the per-email
		// cap nor the IP-keyed limiter binds at all. Whatever bound survives here
		// is the one the endpoint actually has on a default install.
		const burst = CONFIRM_SEND_BUDGETS.find((b) => b.scope === "confirm:burst");
		const max = burst?.max ?? 0;
		expect(max).toBeGreaterThan(0);

		const N = max * 2 + 5;
		const responses = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				subscribe({ post_slug: SLUG, email: `a${i}@example.com` }, `10.0.${i}.1`),
			),
		);

		expect(sent).toHaveLength(max);
		expect(responses.filter((r) => r.status === 429)).toHaveLength(N - max);
		expect(readBudget("confirm:burst")?.sent).toBe(max);
	});

	it("leaves no unconfirmable pending row behind when it denies", async () => {
		// Denying after the upsert would recreate the bug the PUBLIC_BASE_URL /
		// EMAIL_FROM guard exists to prevent: a pending row whose confirmation
		// email never went out, still consuming the reader's per-email cap.
		sqlite
			.prepare(
				"UPDATE email_send_budget SET window_start = ?, sent = ? WHERE scope = 'confirm:burst'",
			)
			.run(Date.now(), 999);

		const res = await subscribe(
			{ post_slug: SLUG, email: "denied@example.com" },
			"10.9.9.9",
		);
		expect(res.status).toBe(429);
		expect((await res.json()) as { reason?: string }).toMatchObject({
			reason: "send_budget_exhausted",
		});
		expect(sent).toHaveLength(0);

		const rows = sqlite
			.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE email = ?")
			.get("denied@example.com") as { n: number };
		expect(rows.n).toBe(0);
	});

	it("spends no budget re-subscribing an already-confirmed address", async () => {
		// No mail goes out on this path, so the reservation is handed back. Without
		// the release a reader clicking subscribe twice would quietly burn global
		// budget on an email nobody sent.
		const sub = await upsertSubscription(
			env.DB,
			SLUG,
			"already@example.com",
			"tok",
			"confirm-tok",
			false,
		);
		sqlite
			.prepare("UPDATE subscriptions SET confirmed_at = ? WHERE id = ?")
			.run(NOW, sub.id);
		sqlite
			.prepare(
				"UPDATE email_send_budget SET window_start = 0, sent = 0 WHERE scope = 'confirm:burst'",
			)
			.run();

		const res = await subscribe(
			{ post_slug: SLUG, email: "already@example.com" },
			"10.4.4.4",
		);
		expect(res.status).toBe(200);
		expect(sent).toHaveLength(0);
		expect(readBudget("confirm:burst")?.sent).toBe(0);
	});
});
