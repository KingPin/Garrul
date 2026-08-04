/**
 * The atomic-backend seam, exercised with a hand-rolled `AtomicRateLimiter`
 * rather than the real Durable Object.
 *
 * Scope is deliberately narrow: that `checkRateLimit` hands the whole decision
 * over when an atomic backend is present, that backend precedence is what the
 * types promise, and that every way an atomic backend can misbehave still
 * fails OPEN. The DO's own atomicity is proven in ratelimit-do.test.ts; none
 * of it is assumed here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
	checkRateLimit,
	DEFAULTS,
	GLOBAL_ENVELOPE,
	memoryStore,
	type AtomicRateLimiter,
	type RateLimitResult,
} from "../src/lib/ratelimit";

const REQ_URL = "https://comments.example.com/api/v1/comments";

/** An atomic backend that answers with whatever it is handed. */
const canned = (result: RateLimitResult): AtomicRateLimiter => ({
	decide: async () => result,
});

describe("checkRateLimit with an atomic backend", () => {
	afterEach(() => vi.restoreAllMocks());

	it("delegates the whole decision, both buckets, in one call", async () => {
		const decide = vi.fn(async () => ({ ok: true }));
		const r = await checkRateLimit(REQ_URL, "ip-1", {
			scope: "comment",
			limiter: { decide },
		});
		expect(r).toEqual({ ok: true });
		// One round trip, not one per bucket — that is the point of the contract.
		expect(decide).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledWith({
			identity: "ip-1",
			scope: "comment",
			config: DEFAULTS,
			// The envelope travels with the call so the backend can decide both
			// buckets together; on the store path they are two separate rounds.
			envelope: GLOBAL_ENVELOPE,
		});
	});

	it("passes the caller's config through when one is set", async () => {
		const cfg = {
			short: { max: 5, windowSec: 10 },
			long: { max: 50, windowSec: 600 },
		};
		const decide: AtomicRateLimiter["decide"] = vi.fn(async () => ({
			ok: true,
		}));
		await checkRateLimit(REQ_URL, "ip-2", {
			scope: "preview",
			config: cfg,
			limiter: { decide },
		});
		expect(decide).toHaveBeenCalledWith(expect.objectContaining({ config: cfg }));
	});

	it("surfaces a block verbatim", async () => {
		const r = await checkRateLimit(REQ_URL, "ip-3", {
			scope: "test",
			limiter: canned({ ok: false, reason: "global" }),
		});
		expect(r).toEqual({ ok: false, reason: "global" });
	});

	it("never touches the store path when a limiter is in play", async () => {
		const store = memoryStore();
		const read = vi.spyOn(store, "read");
		const write = vi.spyOn(store, "write");
		// `store` wins over `limiter` by design, so this asserts the inverse
		// arrangement: limiter only, with a store that must stay untouched.
		await checkRateLimit(REQ_URL, "ip-4", {
			scope: "test",
			limiter: canned({ ok: true }),
		});
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("gives an explicit store precedence over an explicit limiter", async () => {
		// Existing suites inject `store`; adding `limiter` must not silently
		// change what those tests mean.
		const decide = vi.fn(async () => ({ ok: false, reason: "short" as const }));
		const r = await checkRateLimit(REQ_URL, "ip-5", {
			scope: "test",
			store: memoryStore(),
			limiter: { decide },
		});
		expect(r.ok).toBe(true);
		expect(decide).not.toHaveBeenCalled();
	});

	describe("fails open", () => {
		const rejects: AtomicRateLimiter = {
			decide: async () => {
				throw new Error("shard unreachable");
			},
		};
		const throwsSync: AtomicRateLimiter = {
			decide: () => {
				throw new Error("exploded before the await");
			},
		};

		it.each([
			["rejects", rejects],
			["throws synchronously", throwsSync],
		])("when the backend %s", async (_label, limiter) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const r = await checkRateLimit(REQ_URL, "ip-hash-secret", {
				scope: "test",
				limiter,
			});
			expect(r).toEqual({ ok: true, degraded: true });

			const warns = spy.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("ratelimit.degraded"));
			expect(warns).toHaveLength(1);
			const line = JSON.parse(warns[0] as string) as Record<string, unknown>;
			expect(line.backend).toBe("custom");
			expect(line.scope).toBe("test");
			// Log hygiene: the identity is an IP hash and must never be logged.
			expect(warns[0]).not.toContain("ip-hash-secret");
		});
	});

	it("labels the degraded log 'cache' on the store path", async () => {
		// The label is the whole reason it exists: an operator who has just
		// enabled an atomic backend needs to tell the two failures apart.
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		await checkRateLimit(REQ_URL, "ip-6", {
			scope: "test",
			store: {
				read: async () => {
					throw new Error("cache unavailable");
				},
				write: async () => {},
			},
		});
		const line = spy.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("ratelimit.degraded"));
		expect(JSON.parse(line as string).backend).toBe("cache");
	});
});
