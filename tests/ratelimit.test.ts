/**
 * Rate-limit logic test. The real KVNamespace is bound on the edge; here
 * we drive checkRateLimit through an in-memory stub that implements only
 * the get/put surface the limiter uses.
 *
 * The semantic we care about: short-bucket trips first when bursting,
 * long-bucket trips when sustained traffic exceeds the long window cap.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, DEFAULTS } from "../src/lib/ratelimit";

// Minimal KV stub. TTL is informational only — we don't simulate expiry
// because the tests run faster than the shortest configured window.
class StubKV {
	private map = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.map.get(key) ?? null;
	}
	async put(key: string, value: string): Promise<void> {
		this.map.set(key, value);
	}
}

const makeEnv = () =>
	({ RATE_LIMITS: new StubKV() as unknown as KVNamespace });

describe("checkRateLimit", () => {
	let env: { RATE_LIMITS: KVNamespace };

	beforeEach(() => {
		env = makeEnv();
	});

	it("allows the first request through", async () => {
		const r = await checkRateLimit(env, "ip-1");
		expect(r.ok).toBe(true);
	});

	it("blocks a burst (short bucket trips on the 2nd req within 10s)", async () => {
		const cfg = { ...DEFAULTS };
		const a = await checkRateLimit(env, "ip-2", cfg);
		const b = await checkRateLimit(env, "ip-2", cfg);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(false);
		if (!b.ok) expect(b.reason).toBe("short");
	});

	it("allows distinct IP hashes independently", async () => {
		const a = await checkRateLimit(env, "ip-A");
		const b = await checkRateLimit(env, "ip-B");
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
	});

	it("blocks the 6th request when long-bucket allows 5", async () => {
		// Bypass the short bucket by widening it for this test.
		const cfg = {
			short: { max: 100, windowSec: 10 },
			long: { max: 5, windowSec: 600 },
		};
		for (let i = 0; i < 5; i++) {
			const r = await checkRateLimit(env, "ip-3", cfg);
			expect(r.ok).toBe(true);
		}
		const sixth = await checkRateLimit(env, "ip-3", cfg);
		expect(sixth.ok).toBe(false);
		if (!sixth.ok) expect(sixth.reason).toBe("long");
	});
});
