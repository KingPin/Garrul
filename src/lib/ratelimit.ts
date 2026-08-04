/**
 * Sliding-window rate limiter on the Cloudflare Cache API, keyed by identity
 * (an IP hash, or a Telegram user id on the bot webhook).
 *
 * Why not KV — this is the whole point of the module's design. KV's free tier
 * caps writes at 1,000/day scoped to the operator's ENTIRE Cloudflare account.
 * The limiter necessarily writes on every *allowed* request, and a cold bucket
 * (the first hit from any unseen address) always passes and always writes. So
 * ~500 distinct source addresses used to exhaust the account's daily KV write
 * quota. That is an unauthenticated, account-wide outage primitive sitting in
 * front of every public write endpoint, which is exactly backwards for a
 * defense mechanism. (Hashing the full IPv6 address made it worse still — one
 * household could supply 2^64 of those addresses — but `ip-hash.ts` normalizes
 * to /64 now, so the number above is what an attacker has to actually reach.)
 * The Cache API has no per-day write limit. See response-cache.ts for the same
 * reasoning applied to response caching.
 *
 * What it costs in accuracy: Cache API storage is PER-COLO, so a bucket is
 * really a fixed-window-per-datacenter. A distributed burst spread across
 * colos under-counts by roughly the number of colos it touches. KV was only
 * marginally better here (eventually consistent, so the same class of
 * under-count) and cost the quota above. Accurate global limiting needs a
 * Durable Object, which plugs in as an `AtomicRateLimiter` rather than a
 * `RateLimitStore` — read/decide/write cannot be made atomic no matter what
 * sits behind the two methods, so an atomic backend has to own the decision.
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

export type LimitConfig = {
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
 * Storage backend for stamp lists: the Cache API in production, an in-memory
 * map in tests. Read-then-write with the decision in between, which is exactly
 * why it CANNOT carry an atomic backend — see `AtomicRateLimiter`.
 */
export type RateLimitStore = {
	read(key: string): Promise<number[]>;
	write(key: string, stamps: number[], ttlSec: number): Promise<void>;
};

/**
 * The other kind of backend: one that decides BOTH buckets itself and returns
 * the verdict, rather than handing state back for the caller to decide on.
 *
 * This is a separate contract, not a third method on `RateLimitStore`, because
 * the read/decide/write split *is* the race this exists to close. A backend
 * that can do a genuine compare-and-swap has to own the decision, so the
 * window arithmetic runs on the far side of the wire with nothing able to
 * interleave. Bolting a third method onto `RateLimitStore` would instead leave
 * every existing implementer structurally satisfying a type it only half
 * implements, forcing `checkRateLimit` to duck-type-probe at runtime.
 *
 * Implementations must reject on any failure rather than returning a synthetic
 * block: `checkRateLimit` fails OPEN, and a transport glitch coerced into
 * `{ok:false}` would 429-storm every write endpoint instead.
 */
export type AtomicRateLimiter = {
	decide(input: {
		identity: string;
		scope: string;
		config: LimitConfig;
		envelope: LimitConfig;
	}): Promise<RateLimitResult>;
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
 * Decide a stamp list against both windows. Pure, and deliberately
 * SYNCHRONOUS: any future backend that needs an atomic read-modify-write has
 * to run its decide with no `await` between reading its state and writing it
 * back, which is only possible if this function never yields. Returns the
 * surviving stamps (pruned to the long window) either way, so an allowed
 * request can append and write back without a second read.
 */
export const decideStamps = (
	stamps: number[],
	cfg: LimitConfig,
	now: number,
): { stamps: number[]; reason?: "short" | "long" } => {
	const longCutoff = now - cfg.long.windowSec * 1000;
	const shortCutoff = now - cfg.short.windowSec * 1000;
	const live = stamps.filter((t) => t > longCutoff);
	// Short window checked first so a burst reports "short" rather than the
	// sustained reason, which is what the operator-facing analytics expect.
	if (live.filter((t) => t > shortCutoff).length >= cfg.short.max) {
		return { stamps: live, reason: "short" };
	}
	if (live.length >= cfg.long.max) return { stamps: live, reason: "long" };
	return { stamps: live };
};

/** Read a bucket from the store and decide it. */
const decide = async (
	store: RateLimitStore,
	key: string,
	cfg: LimitConfig,
	now: number,
): Promise<Bucket> => {
	const d = decideStamps(await store.read(key), cfg, now);
	// `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
	// property, so the reason is spread in only when present.
	return d.reason
		? { key, stamps: d.stamps, reason: d.reason }
		: { key, stamps: d.stamps };
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
	/** Override with an atomic backend. Tests only — production resolves one
	 *  from the environment. Ignored when `store` is also set. */
	limiter?: AtomicRateLimiter;
};

/**
 * Which backend a call ended up on. `label` exists so the degraded log line
 * distinguishes "the edge cache is down" from "my atomic backend is
 * unreachable" — two very different things for an operator to chase.
 */
type Backend =
	| { kind: "atomic"; limiter: AtomicRateLimiter; label: "custom" }
	| { kind: "store"; store: RateLimitStore; label: "cache" };

/**
 * An explicit `store` wins over an explicit `limiter` so the existing
 * store-injecting tests keep their meaning verbatim; otherwise the Cache API.
 */
const resolveBackend = (reqUrl: string, opts: RateLimitOptions): Backend => {
	if (opts.store) return { kind: "store", store: opts.store, label: "cache" };
	if (opts.limiter) {
		return { kind: "atomic", limiter: opts.limiter, label: "custom" };
	}
	return { kind: "store", store: cacheApiStore(reqUrl), label: "cache" };
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
	const backend = resolveBackend(reqUrl, opts);
	const now = Date.now();

	try {
		if (backend.kind === "atomic") {
			// The backend owns the whole decision, so everything below — the
			// two-pass read, the append, the race it documents — is not on this
			// path at all. It answers for both buckets in one round trip.
			return await backend.limiter.decide({
				identity,
				scope: opts.scope,
				config: cfg,
				envelope: GLOBAL_ENVELOPE,
			});
		}
		const store = backend.store;

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

		// Non-atomic read-modify-write, and the write is a full overwrite rather
		// than an append: `decide` hands back the stamps it read, this pushes
		// one, and `store.write` replaces the whole entry. So N concurrent
		// requests from one identity all observe the same pre-state, all pass
		// the gate, and all write back a bucket grown by exactly one stamp —
		// last writer wins, and the other N-1 leave no trace.
		//
		// The overshoot is therefore a MULTIPLIER, not a one-off burst: a client
		// keeping N requests in flight sustains roughly N× the configured cap
		// indefinitely, because the bucket only ever advances one stamp per
		// round no matter how many got through. The global envelope races the
		// same way and multiplies with it, so it is not a backstop against this.
		//
		// The Cache API has no compare-and-swap, so this is inherent to the
		// backend: a Durable Object behind `RateLimitStore` is what closes it
		// (tracked in #53, and it would fix the per-colo undercount above too).
		//
		// Accepted for now, and the reason is not "it's only a burst" — it isn't
		// one. It is that the limiter is deliberately not the sole control on any
		// endpoint taking an unauthenticated caller: Turnstile on anonymous
		// comment POST, UNIQUE(comment_id, reporter_ip_hash) on reports,
		// idempotent toggles on votes and reactions, PENDING_PER_EMAIL_CAP on
		// subscribe. None of those is racy, so what this loosens is a *rate*, not
		// an action — it cannot buy a second report on one comment or a
		// double-counted vote.
		//
		// It is NOT excused by "IPv6 rotation defeats per-IP limiting anyway".
		// That held while `ip-hash.ts` hashed the full address, and stopped
		// holding in the same release this note ships in: IPv6 is now normalized
		// to its /64, so a household is one identity rather than 2^64. The race
		// is therefore the cheapest remaining bypass on the IP-keyed buckets,
		// not a rounding error beside a larger one. That raises what #53 is
		// worth; it does not change the fact that the Cache API cannot close it.
		// It is also the only bypass on the `user:`-keyed buckets and the
		// Telegram route, which cost an attacker a bannable account.
		//
		// This is an operator-visible property, not just an internal caveat:
		// docs/ANTISPAM.md § "Rate-limit accuracy" states it, and points
		// operators who need a hard ceiling at Cloudflare WAF rate-limiting
		// rules. Keep the two in sync.
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
			backend: backend.label,
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
