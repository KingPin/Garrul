/**
 * `RateLimitShard` in isolation — the class, not the limiter that calls it.
 *
 * It is constructed directly with a stub state. That is honest rather than a
 * shortcut: the shard deliberately never touches `state` (no `storage`, no
 * `blockConcurrencyWhile`), and the point of the classic non-RPC shape is that
 * it stays a plain object with a `fetch`.
 *
 * Atomicity itself is asserted through the limiter in ratelimit-do.test.ts,
 * where concurrency is actually in play. What this file pins is the wire
 * contract, the input validation, and the memory bounding.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimitShard } from "../src/lib/ratelimit-shard";
import { DEFAULTS, GLOBAL_ENVELOPE } from "../src/lib/ratelimit";

const MAX_BUCKETS = 20_000;

const makeShard = () =>
	new RateLimitShard({} as DurableObjectState, {} as unknown);

const post = (shard: RateLimitShard, body: unknown, url = "https://do/decide") =>
	shard.fetch(
		new Request(url, {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);

const decideBody = (
	identity: string,
	scope = "test",
	config = DEFAULTS,
	envelope = GLOBAL_ENVELOPE,
) => ({ identity, scope, config, envelope });

const decide = async (shard: RateLimitShard, ...args: [string, string?]) => {
	const res = await post(shard, decideBody(...args));
	expect(res.status).toBe(200);
	return (await res.json()) as { ok: boolean; reason?: string };
};

describe("RateLimitShard", () => {
	afterEach(() => vi.useRealTimers());

	it("allows the first request and blocks the second in the short window", async () => {
		const shard = makeShard();
		expect(await decide(shard, "ip-1")).toEqual({ ok: true });
		// DEFAULTS is short.max = 1, so the very next one trips.
		expect(await decide(shard, "ip-1")).toEqual({ ok: false, reason: "short" });
	});

	it("keeps identities and scopes independent", async () => {
		const shard = makeShard();
		expect((await decide(shard, "ip-a")).ok).toBe(true);
		expect((await decide(shard, "ip-b")).ok).toBe(true);
		expect((await decide(shard, "ip-a", "other")).ok).toBe(true);
	});

	it("enforces the envelope across scopes within one shard", async () => {
		const shard = makeShard();
		// Fresh scope every time, so only the shared envelope can stop it. This
		// is the property the Cache API backend cannot offer: both buckets are
		// decided against one authority's state.
		let blocked: { ok: boolean; reason?: string } | null = null;
		for (let i = 0; i <= GLOBAL_ENVELOPE.short.max; i++) {
			const r = await decide(shard, "ip-spray", `scope-${i}`);
			if (!r.ok) {
				blocked = r;
				break;
			}
		}
		expect(blocked).toEqual({ ok: false, reason: "global" });
	});

	it("does not spend envelope budget on a request the scope bucket blocked", async () => {
		const shard = makeShard();
		await decide(shard, "ip-2");
		for (let i = 0; i < 5; i++) {
			expect((await decide(shard, "ip-2")).ok).toBe(false);
		}
		// Envelope short.max is 20; if the five blocked calls had each appended,
		// spraying would now be cheaper than it should be. Prove the envelope
		// still has its full remaining budget bar the one allowed request.
		let allowed = 0;
		for (let i = 0; i < GLOBAL_ENVELOPE.short.max; i++) {
			if ((await decide(shard, "ip-2", `fresh-${i}`)).ok) allowed++;
		}
		expect(allowed).toBe(GLOBAL_ENVELOPE.short.max - 1);
	});

	it.each([
		["GET", 405],
		["PUT", 405],
	])("rejects %s with %i", async (method, status) => {
		const shard = makeShard();
		const res = await shard.fetch(
			new Request("https://do/decide", { method }),
		);
		expect(res.status).toBe(status);
	});

	it("404s an unknown path", async () => {
		const shard = makeShard();
		const res = await post(shard, decideBody("ip-3"), "https://do/other");
		expect(res.status).toBe(404);
	});

	it.each([
		["non-JSON body", "not json at all"],
		["a JSON scalar", 42],
		["a missing identity", { scope: "s", config: DEFAULTS, envelope: DEFAULTS }],
		["an empty identity", decideBody("")],
		["a missing config", { identity: "i", scope: "s", envelope: DEFAULTS }],
		[
			"a non-numeric max",
			decideBody("i", "s", {
				short: { max: "lots", windowSec: 10 },
				long: { max: 5, windowSec: 600 },
			} as unknown as typeof DEFAULTS),
		],
		[
			"a zero window",
			decideBody("i", "s", {
				short: { max: 1, windowSec: 0 },
				long: { max: 5, windowSec: 600 },
			}),
		],
		[
			"an absurd window",
			decideBody("i", "s", {
				short: { max: 1, windowSec: 10 },
				long: { max: 5, windowSec: 999_999_999 },
			}),
		],
	])("rejects %s with 400", async (_label, body) => {
		// Non-2xx is the contract: the client turns it into a logged fail-open
		// rather than a synthetic block, so a caller bug degrades to "unmetered"
		// instead of 429ing every write endpoint.
		const res = await post(makeShard(), body);
		expect(res.status).toBe(400);
	});

	it("clamps an implausible max rather than rejecting it", async () => {
		const shard = makeShard();
		const huge = {
			short: { max: 1e9, windowSec: 10 },
			long: { max: 1e9, windowSec: 600 },
		};
		const res = await post(shard, decideBody("ip-4", "test", huge, huge));
		// Structurally coherent, so it is honoured — just capped, which bounds
		// how much memory one identity can make the shard hold.
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("caps memory and resets evicted buckets instead of blocking them", async () => {
		const shard = makeShard();
		const wide = {
			short: { max: 1000, windowSec: 10 },
			long: { max: 1000, windowSec: 600 },
		};
		const first = "identity-0";
		// Each identity writes a scope bucket and shares the envelope, so this
		// drives well past the cap.
		for (let i = 0; i < MAX_BUCKETS + 2_000; i++) {
			await post(shard, decideBody(`identity-${i}`, "test", wide, wide));
		}
		const size = (shard as unknown as { buckets: Map<string, unknown> }).buckets
			.size;
		expect(size).toBeLessThanOrEqual(MAX_BUCKETS);

		// The first identity's bucket is long gone. Eviction must read as a cache
		// miss — allowed, budget reset — never as a block. Loosening on eviction
		// is the same fail-open posture the limiter has everywhere else.
		const res = await post(shard, decideBody(first, "test", wide, wide));
		expect(await res.json()).toEqual({ ok: true });
	});

	it("expires buckets so a shard that only ever sees new identities stays bounded", async () => {
		const shard = makeShard();
		const brief = {
			short: { max: 1, windowSec: 1 },
			long: { max: 1, windowSec: 1 },
		};
		for (let i = 0; i < 200; i++) {
			await post(shard, decideBody(`e-${i}`, "test", brief, brief));
		}
		const buckets = (shard as unknown as { buckets: Map<string, unknown> })
			.buckets;
		const before = buckets.size;
		// Age everything past the 1s window, then keep issuing requests; the
		// amortized sweep has to reclaim faster than new arrivals accumulate.
		// Fake timers rather than a real sleep — the shard reads `Date.now()`
		// and nothing here awaits a timer, so advancing the clock is enough.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 2_000);
		for (let i = 0; i < 40; i++) {
			await post(shard, decideBody(`late-${i}`, "test", brief, brief));
		}
		expect(buckets.size).toBeLessThan(before);
	});
});
