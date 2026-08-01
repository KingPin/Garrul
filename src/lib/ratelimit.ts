/**
 * Sliding-window rate limiter on the Cloudflare Cache API, keyed by identity
 * (an IP hash, or a Telegram user id on the bot webhook).
 *
 * Why not KV — this is the whole point of the module's design. KV's free tier
 * caps writes at 1,000/day scoped to the operator's ENTIRE Cloudflare account.
 * The limiter necessarily writes on every *allowed* request, and a cold bucket
 * (the first hit from any unseen address) always passes and always writes. So
 * ~500 distinct source addresses used to exhaust the account's daily KV write
 * quota — and a single residential IPv6 /64 supplies 2^64 of them. That is an
 * unauthenticated, account-wide outage primitive sitting in front of every
 * public write endpoint, which is exactly backwards for a defense mechanism.
 * The Cache API has no per-day write limit. See response-cache.ts for the same
 * reasoning applied to response caching.
 *
 * What it costs in accuracy: Cache API storage is PER-COLO, so a bucket is
 * really a fixed-window-per-datacenter. A distributed burst spread across
 * colos under-counts by roughly the number of colos it touches. KV was only
 * marginally better here (eventually consistent, so the same class of
 * under-count) and cost the quota above. Accurate global limiting needs a
 * Durable Object; `RateLimitStore` exists so that can be added later as an
 * opt-in backend without touching a single call site.
 *
 * Two windows per bucket, both enforced from ONE stored stamp list:
 *   - short: N requests in T_short seconds (burst protection)
 *   - long:  M requests in T_long  seconds (sustained rate)
 * Coalescing them into one entry halves the store ops per request versus the
 * old two-key layout, and drops the KV 60s-minimum-TTL clamp entirely.
 *
 * Two buckets are consulted per request: the caller's `scope` (its own budget)
 * and one shared GLOBAL envelope. Scoping alone would multiply an attacker's
 * total budget by the number of endpoints; the envelope re-imposes a per-
 * identity ceiling across all of them.
 */
import { cacheKey, edgeCache } from "./response-cache";
import { log } from "./log";

type LimitConfig = {
	short: { max: number; windowSec: number };
	long: { max: number; windowSec: number };
};

export const DEFAULTS: LimitConfig = {
	short: { max: 1, windowSec: 10 },
	long: { max: 5, windowSec: 600 },
};

/**
 * Per-identity ceiling across every scope combined. Deliberately looser than
 * any single route's budget — it is a backstop against scope multiplication,
 * not the primary limit. It must stay at least as generous as the most
 * generous route config (preview 5/10s, telegram 10/10s) or that route's own
 * config becomes dead code.
 */
export const GLOBAL_ENVELOPE: LimitConfig = {
	short: { max: 20, windowSec: 10 },
	long: { max: 200, windowSec: 600 },
};

/**
 * Storage backend for stamp lists. Backend-agnostic by design: the default is
 * the Cache API, tests inject an in-memory map, and a Durable Object backend
 * (for accurate cross-colo counting) can be dropped in behind the same two
 * methods. Neither method may reject — see `cacheApiStore`.
 */
export type RateLimitStore = {
	read(key: string): Promise<number[]>;
	write(key: string, stamps: number[], ttlSec: number): Promise<void>;
};

export type RateLimitResult = {
	ok: boolean;
	reason?: "short" | "long" | "global";
	/**
	 * True when the store was unreachable and the request was allowed through
	 * unmetered. Callers may surface this in analytics; they must not treat it
	 * as a block.
	 */
	degraded?: boolean;
};

const STORE_UNAVAILABLE = Symbol("rate-limit store unavailable");

/**
 * Cache API store, bound to the handling request's URL.
 *
 * `reqUrl` is load-bearing: `cacheKey` builds the entry on the Worker's OWN
 * origin because Cloudflare only honors a custom cache key for a hostname in
 * your zone — a synthetic host would make `put` a silent production no-op
 * (response-cache.ts documents this in full).
 *
 * Read failures surface as STORE_UNAVAILABLE so a cache outage is reported as
 * degraded rather than silently read as an empty bucket, which would look
 * exactly like "no traffic yet" and disable limiting without a trace. Write
 * failures throw for the same reason. Note `cache.put` rejects non-GET keys
 * and any response carrying `Set-Cookie`; neither applies to what we store
 * here, but the old `.catch(() => {})` would have hidden it if it did.
 */
export const cacheApiStore = (reqUrl: string): RateLimitStore => ({
	read: async (key: string): Promise<number[]> => {
		const cache = edgeCache();
		if (!cache) throw STORE_UNAVAILABLE;
		const hit = await cache.match(cacheKey(reqUrl, "ratelimit", { key }));
		if (!hit) return [];
		const raw = await hit.text();
		try {
			const arr: unknown = JSON.parse(raw);
			if (!Array.isArray(arr)) return [];
			return arr.filter((n): n is number => typeof n === "number");
		} catch {
			// A corrupt entry is not an outage: treat it as an empty bucket and
			// let this request rewrite it cleanly.
			return [];
		}
	},
	write: async (
		key: string,
		stamps: number[],
		ttlSec: number,
	): Promise<void> => {
		const cache = edgeCache();
		if (!cache) throw STORE_UNAVAILABLE;
		// max-age is what expires the entry — the Cache API has no separate TTL
		// and, unlike KV, no minimum, so the true window length works directly.
		await cache.put(
			cacheKey(reqUrl, "ratelimit", { key }),
			new Response(JSON.stringify(stamps), {
				headers: {
					"content-type": "application/json",
					"cache-control": `public, max-age=${ttlSec}`,
				},
			}),
		);
	},
});

type Bucket = { key: string; stamps: number[]; reason?: "short" | "long" };

/**
 * Read a bucket and decide it against both windows. Returns `reason` set when
 * over budget, and the surviving stamps (pruned to the long window) either way
 * so an allowed request can append and write back without a second read.
 */
const decide = async (
	store: RateLimitStore,
	key: string,
	cfg: LimitConfig,
	now: number,
): Promise<Bucket> => {
	const longCutoff = now - cfg.long.windowSec * 1000;
	const shortCutoff = now - cfg.short.windowSec * 1000;
	const stamps = (await store.read(key)).filter((t) => t > longCutoff);
	// Short window checked first so a burst reports "short" rather than the
	// sustained reason, which is what the operator-facing analytics expect.
	if (stamps.filter((t) => t > shortCutoff).length >= cfg.short.max) {
		return { key, stamps, reason: "short" };
	}
	if (stamps.length >= cfg.long.max) return { key, stamps, reason: "long" };
	return { key, stamps };
};

export type RateLimitOptions = {
	/**
	 * Bucket namespace. Two routes that share a scope share a budget, so any
	 * route with its own `config` MUST have its own scope — otherwise its
	 * window/max are applied to stamps written under a different budget and
	 * both routes limit incoherently. (That was a live bug: /api/v1/preview
	 * read and wrote the shared bucket with its own looser caps.)
	 */
	scope: string;
	config?: LimitConfig;
	/** Override the backend. Tests inject in-memory; production omits it. */
	store?: RateLimitStore;
};

/**
 * Consult the scope bucket and the global envelope, and record the request in
 * both when allowed.
 *
 * Failure posture is FAIL-OPEN, explicit and logged. The limiter no longer has
 * a write quota of its own to exhaust, so a cache outage degrading into "no
 * limiting" is strictly better than degrading into "every write endpoint 500s"
 * — which is what the old code did on a KV write error while a parse error
 * silently failed open, an inconsistency in itself. Every degraded decision
 * carries `degraded: true` and emits a `log.warn` so it is visible in
 * `wrangler tail` rather than inferred from a traffic spike.
 */
export const checkRateLimit = async (
	reqUrl: string,
	identity: string,
	opts: RateLimitOptions,
): Promise<RateLimitResult> => {
	const cfg = opts.config ?? DEFAULTS;
	const store = opts.store ?? cacheApiStore(reqUrl);
	const now = Date.now();

	try {
		// Read-only pass over both buckets first. Returning before any write
		// means a blocked request doesn't spend budget it was denied — without
		// this, an identity fighting the long window would also burn its short
		// window and never recover.
		const scoped = await decide(store, `${opts.scope}:${identity}`, cfg, now);
		if (scoped.reason) return { ok: false, reason: scoped.reason };

		const global = await decide(
			store,
			`global:${identity}`,
			GLOBAL_ENVELOPE,
			now,
		);
		if (global.reason) return { ok: false, reason: "global" };

		// Non-atomic read-modify-write. Concurrent requests from one identity
		// can each observe room and each append, briefly exceeding the cap by
		// the concurrent-request count. The Cache API has no compare-and-swap,
		// so this is inherent to the backend; bounded burst slop is an
		// acceptable trade for a comment system. A Durable Object backend would
		// close it.
		scoped.stamps.push(now);
		global.stamps.push(now);
		await Promise.all([
			store.write(scoped.key, scoped.stamps, cfg.long.windowSec),
			store.write(
				global.key,
				global.stamps,
				GLOBAL_ENVELOPE.long.windowSec,
			),
		]);
		return { ok: true };
	} catch (err) {
		log.warn("ratelimit.degraded", {
			scope: opts.scope,
			// Never the identity itself: it's an IP hash, and log hygiene keeps
			// per-user identifiers out of log lines.
			error: err === STORE_UNAVAILABLE ? "store_unavailable" : String(err),
		});
		return { ok: true, degraded: true };
	}
};

/**
 * In-memory store. Exported for tests, which run in the plain node pool with
 * no `caches` global — without an injectable backend every assertion would hit
 * the fail-open path and the limiter would appear to allow everything.
 */
export const memoryStore = (): RateLimitStore => {
	const map = new Map<string, { stamps: number[]; expiresAt: number }>();
	return {
		read: async (key) => {
			const e = map.get(key);
			if (!e) return [];
			if (e.expiresAt <= Date.now()) {
				map.delete(key);
				return [];
			}
			return e.stamps;
		},
		write: async (key, stamps, ttlSec) => {
			map.set(key, { stamps, expiresAt: Date.now() + ttlSec * 1000 });
		},
	};
};
