/**
 * KV-backed sliding-window rate limiter, keyed by IP hash.
 *
 * Two buckets per key:
 *   - short:  N requests in T_short seconds (burst protection, e.g. 1 / 10s)
 *   - long:   M requests in T_long  seconds (sustained, e.g. 5 / 600s)
 *
 * Each bucket is a single KV value: a JSON-encoded array of UNIX-epoch
 * milliseconds for each request in the current window. The TTL on the
 * key is the window length, so old data evicts automatically.
 *
 * KV writes are eventually consistent across the edge, which means a
 * burst from different regions could under-count. That's acceptable
 * for a comment system — true determinism would need Durable Objects.
 */

type LimitConfig = {
	short: { max: number; windowSec: number };
	long: { max: number; windowSec: number };
};

export const DEFAULTS: LimitConfig = {
	short: { max: 1, windowSec: 10 },
	long: { max: 5, windowSec: 600 },
};

type Env = { RATE_LIMITS: KVNamespace };

const bucketKey = (kind: "short" | "long", ipHash: string): string =>
	`rl:${kind}:${ipHash}`;

const readBucket = async (
	kv: KVNamespace,
	key: string,
): Promise<number[]> => {
	const raw = await kv.get(key);
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return arr.filter((n) => typeof n === "number");
	} catch {
		return [];
	}
};

const writeBucket = async (
	kv: KVNamespace,
	key: string,
	stamps: number[],
	ttlSec: number,
): Promise<void> => {
	await kv.put(key, JSON.stringify(stamps), { expirationTtl: ttlSec });
};

const readWindow = async (
	kv: KVNamespace,
	ipHash: string,
	kind: "short" | "long",
	cfg: { max: number; windowSec: number },
	now: number,
): Promise<{ key: string; stamps: number[]; allowed: boolean }> => {
	const key = bucketKey(kind, ipHash);
	const cutoff = now - cfg.windowSec * 1000;
	const stamps = (await readBucket(kv, key)).filter((t) => t > cutoff);
	return { key, stamps, allowed: stamps.length < cfg.max };
};

export const checkRateLimit = async (
	env: Env,
	ipHash: string,
	cfg: LimitConfig = DEFAULTS,
): Promise<{ ok: boolean; reason?: "short" | "long" }> => {
	const now = Date.now();
	// Check both windows in read-only mode first. If either is over budget,
	// return early without writing — otherwise a long-window block would
	// also burn the short-window budget, and a user fighting the long limit
	// would lose their short budget too.
	const s = await readWindow(env.RATE_LIMITS, ipHash, "short", cfg.short, now);
	if (!s.allowed) return { ok: false, reason: "short" };
	const l = await readWindow(env.RATE_LIMITS, ipHash, "long", cfg.long, now);
	if (!l.allowed) return { ok: false, reason: "long" };
	// Both windows have room — record this request in both.
	s.stamps.push(now);
	l.stamps.push(now);
	await writeBucket(env.RATE_LIMITS, s.key, s.stamps, cfg.short.windowSec);
	await writeBucket(env.RATE_LIMITS, l.key, l.stamps, cfg.long.windowSec);
	return { ok: true };
};
