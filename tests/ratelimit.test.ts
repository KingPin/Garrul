/**
 * Rate-limit logic test.
 *
 * The real backend is the Cloudflare Cache API, which the node pool has no
 * `caches` global for — so these drive the limiter through the injectable
 * `memoryStore`. That injection point exists precisely so tests assert real
 * limiting instead of silently exercising the fail-open path.
 *
 * What matters here: the short window trips on a burst, the long window trips
 * on sustained traffic, scopes don't leak into each other, the global envelope
 * still caps an identity spraying across scopes, a blocked request doesn't
 * spend budget, and a broken store fails OPEN rather than 500ing every write
 * endpoint.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	checkRateLimit,
	DEFAULTS,
	GLOBAL_ENVELOPE,
	memoryStore,
	type RateLimitStore,
} from "../src/lib/ratelimit";

// Only the origin is read (cache keys must live on the Worker's own host), so
// any absolute URL on one host works.
const REQ_URL = "https://comments.example.com/api/v1/comments";

describe("checkRateLimit", () => {
	let store: RateLimitStore;

	beforeEach(() => {
		store = memoryStore();
	});

	const check = (identity: string, scope = "test", config = DEFAULTS) =>
		checkRateLimit(REQ_URL, identity, { scope, config, store });

	it("allows the first request through", async () => {
		expect((await check("ip-1")).ok).toBe(true);
	});

	it("blocks a burst (short window trips on the 2nd req within 10s)", async () => {
		expect((await check("ip-2")).ok).toBe(true);
		const b = await check("ip-2");
		expect(b.ok).toBe(false);
		expect(b.reason).toBe("short");
	});

	it("allows distinct identities independently", async () => {
		expect((await check("ip-A")).ok).toBe(true);
		expect((await check("ip-B")).ok).toBe(true);
	});

	it("blocks the 6th request when the long window allows 5", async () => {
		// Widen the short window so the long one is what trips.
		const cfg = {
			short: { max: 100, windowSec: 10 },
			long: { max: 5, windowSec: 600 },
		};
		for (let i = 0; i < 5; i++) {
			expect((await check("ip-3", "test", cfg)).ok).toBe(true);
		}
		const sixth = await check("ip-3", "test", cfg);
		expect(sixth.ok).toBe(false);
		expect(sixth.reason).toBe("long");
	});

	it("keeps scopes independent, so a route's own config actually applies", async () => {
		// The bug this closes: /api/v1/preview used to read and write the shared
		// bucket with its own looser caps, so one comment post 429'd the next
		// preview.
		expect((await check("ip-4", "comment")).ok).toBe(true);
		expect((await check("ip-4", "preview")).ok).toBe(true);
	});

	it("caps an identity spraying across many scopes via the global envelope", async () => {
		// Each scope is fresh, so the per-scope budget never trips; only the
		// shared envelope can stop this.
		let blocked: Awaited<ReturnType<typeof check>> | null = null;
		for (let i = 0; i < GLOBAL_ENVELOPE.short.max + 1; i++) {
			const r = await check("ip-5", `scope-${i}`);
			if (!r.ok) {
				blocked = r;
				break;
			}
		}
		expect(blocked).not.toBeNull();
		expect(blocked?.reason).toBe("global");
	});

	it("does not spend budget on a blocked request", async () => {
		// A request denied by the scope bucket must not append to the envelope —
		// otherwise an identity fighting one limit would drain the other and
		// never recover.
		await check("ip-6");
		for (let i = 0; i < 5; i++) expect((await check("ip-6")).ok).toBe(false);
		expect(await store.read("global:ip-6")).toHaveLength(1);
	});

	it("costs two reads and two writes per allowed request", async () => {
		// The old KV layout used separate short/long keys: 2 reads + 2 writes
		// per bucket. Coalescing the windows into one entry halves that, which
		// is what made a cold bucket affordable.
		let reads = 0;
		let writes = 0;
		const counting: RateLimitStore = {
			read: async (k) => {
				reads++;
				return store.read(k);
			},
			write: async (k, s, t) => {
				writes++;
				return store.write(k, s, t);
			},
		};
		const r = await checkRateLimit(REQ_URL, "ip-7", {
			scope: "test",
			store: counting,
		});
		expect(r.ok).toBe(true);
		// One scope bucket + one global envelope.
		expect(reads).toBe(2);
		expect(writes).toBe(2);
	});

	it("lets N concurrent requests through while advancing the bucket by one", async () => {
		// Pins the documented bound on the non-atomic read-modify-write, which
		// used to be described as "briefly exceeding the cap by the
		// concurrent-request count". It is worse than that: the write is a full
		// overwrite, not an append, so the N-1 losing writers leave no trace and
		// the bucket advances by a single stamp however many got through. That
		// makes the overshoot a sustained multiplier rather than a one-off burst.
		//
		// The trade-off itself is settled (the Cache API has no CAS) — this is
		// here so the comment above can't drift back to understating it.
		const slow = memoryStore();
		const concurrent: RateLimitStore = {
			// A tick between read and write is what a real colo's latency gives
			// every in-flight request for free.
			read: async (k) => {
				await Promise.resolve();
				return slow.read(k);
			},
			write: (k, s, t) => slow.write(k, s, t),
		};
		const N = 5;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				checkRateLimit(REQ_URL, "ip-race", {
					scope: "test",
					// short.max = 1: serially, only the first would be allowed.
					config: DEFAULTS,
					store: concurrent,
				}),
			),
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(await slow.read("test:ip-race")).toHaveLength(1);
	});

	it("fails open and flags degraded when the store is unavailable", async () => {
		// A cache outage must not take every write endpoint down with it. The
		// limiter has no write quota of its own to protect anymore, so allowing
		// unmetered traffic is the strictly better failure mode.
		const broken: RateLimitStore = {
			read: async () => {
				throw new Error("cache unavailable");
			},
			write: async () => {
				throw new Error("cache unavailable");
			},
		};
		const r = await checkRateLimit(REQ_URL, "ip-8", {
			scope: "test",
			store: broken,
		});
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
	});

	it("fails open when only the write side breaks", async () => {
		const writeOnlyBroken: RateLimitStore = {
			read: (k) => store.read(k),
			write: async () => {
				throw new Error("put rejected");
			},
		};
		const r = await checkRateLimit(REQ_URL, "ip-9", {
			scope: "test",
			store: writeOnlyBroken,
		});
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(true);
	});
});
