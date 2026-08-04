/**
 * Durable Object backing the optional atomic rate-limit backend (issue #53).
 *
 * WHY THIS EXISTS. On the Cache API the limiter does a read, then a decision,
 * then a full-overwrite write. N concurrent requests from one identity all
 * observe the same pre-state, all pass, and all write back a bucket grown by
 * exactly one stamp — so the overshoot is a sustained N× multiplier, not a
 * burst. The Cache API has no compare-and-swap, so that is inherent to the
 * backend. Cache entries are also per-colo, so a distributed burst undercounts
 * by roughly the number of datacenters it touches. A Durable Object fixes both
 * at once: one instance is the single authority for an identity, and its
 * decision runs without interleaving.
 *
 * WHY IT IS ATOMIC. Everything after the one `await req.json()` — the sweep,
 * both `decideStamps` calls, the appends, the Map writes — runs with no
 * `await` in it. JavaScript's run-to-completion then forbids any other
 * request's continuation from observing intermediate state. That is a language
 * guarantee, not a workerd one: this deliberately does NOT lean on the input
 * gate, which is why the property is provable in the plain node test pool.
 * Keep it that way — introducing an `await` into `handleDecide` silently
 * reopens the exact race this module exists to close.
 *
 * WHY NO `storage`. Stamps live in memory only. Persisting them would spend
 * the SQLite storage write quota on every allowed request for state that is
 * worthless within a window of itself. The cost is that hibernation and
 * reclamation reset buckets — see the caveat in docs/ANTISPAM.md. Resets only
 * ever loosen the limit, never produce a false 429, which matches the fail-open
 * posture the limiter already has.
 *
 * WHY THE CLASSIC SHAPE. No `cloudflare:workers` import, no RPC, plain
 * `fetch`. `src/index.ts` re-exports this class for wrangler, and two suites
 * (tests/agents-md.test.ts, tests/scheduled.test.ts) import `src/index.ts` at
 * RUNTIME in the node pool — a `cloudflare:workers` import would break both.
 * It also makes the class directly constructible in a unit test, which is not
 * a lie here because it never touches `state`.
 */
import {
	decideStamps,
	type LimitConfig,
	type RateLimitResult,
} from "./ratelimit";

/**
 * Hard ceiling on live identities held by one shard. Worst case is roughly
 * 2.4 KB per identity (a 200-stamp envelope bucket dominates), so 20k buckets
 * lands well inside a 128 MB instance with room for the request itself.
 */
const MAX_BUCKETS = 20_000;

/**
 * Evict in batches rather than one-per-request, so a shard at the cap is not
 * doing an eviction on every single call forever.
 */
const EVICT_BATCH = 2_048;

/**
 * Stamps kept per bucket. Bounds memory against a config that asks for an
 * absurd `long.max`; also the clamp applied to `max` itself.
 */
const MAX_STAMPS = 1_000;

/** Longest window we will honour. A day is far beyond any real config. */
const MAX_WINDOW_SEC = 86_400;

/**
 * Expired entries examined per request. A request adds at most 2 buckets and
 * sweeps 64, so expiry keeps ahead of arrivals under any load.
 */
const SWEEP_SLICE = 64;

type Bucket = { stamps: number[]; expiresAt: number };

type DecideBody = {
	identity: string;
	scope: string;
	config: LimitConfig;
	envelope: LimitConfig;
};

const isWindow = (v: unknown): v is { max: number; windowSec: number } => {
	if (typeof v !== "object" || v === null) return false;
	const w = v as { max?: unknown; windowSec?: unknown };
	return (
		typeof w.max === "number" &&
		Number.isFinite(w.max) &&
		w.max >= 1 &&
		typeof w.windowSec === "number" &&
		Number.isFinite(w.windowSec) &&
		w.windowSec >= 1 &&
		w.windowSec <= MAX_WINDOW_SEC
	);
};

/**
 * Accept the shape, then clamp `max`. The split matters: a structurally wrong
 * config is a bug on the calling side and should be loud (non-2xx, which the
 * client turns into a logged fail-open), whereas an implausibly large `max` is
 * still a coherent instruction and is simply capped rather than rejected.
 */
const parseConfig = (v: unknown): LimitConfig | null => {
	if (typeof v !== "object" || v === null) return null;
	const c = v as { short?: unknown; long?: unknown };
	if (!isWindow(c.short) || !isWindow(c.long)) return null;
	return {
		short: {
			max: Math.min(Math.floor(c.short.max), MAX_STAMPS),
			windowSec: c.short.windowSec,
		},
		long: {
			max: Math.min(Math.floor(c.long.max), MAX_STAMPS),
			windowSec: c.long.windowSec,
		},
	};
};

const parseBody = (v: unknown): DecideBody | null => {
	if (typeof v !== "object" || v === null) return null;
	const b = v as Record<string, unknown>;
	if (typeof b.identity !== "string" || !b.identity) return null;
	if (typeof b.scope !== "string" || !b.scope) return null;
	const config = parseConfig(b.config);
	const envelope = parseConfig(b.envelope);
	if (!config || !envelope) return null;
	return { identity: b.identity, scope: b.scope, config, envelope };
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export class RateLimitShard {
	private readonly buckets = new Map<string, Bucket>();

	/**
	 * Live key iterator, so the expiry sweep resumes where it left off instead
	 * of rescanning from the front. Map iterators tolerate deletion of the
	 * current key and pick up entries appended behind them, which is exactly
	 * the behaviour an amortized sweep wants.
	 */
	private sweepIter: IterableIterator<string> | null = null;

	// biome-ignore lint/complexity/noUselessConstructor: not useless — it is the
	// Durable Object contract. workerd constructs the class with (state, env),
	// and declaring it keeps the signature visible and lets the unit tests
	// construct one directly. Deleting it makes `new RateLimitShard(a, b)` a
	// TS error ("Expected 0 arguments") in tests/ratelimit-shard.test.ts.
	constructor(_state: DurableObjectState, _env: unknown) {}

	async fetch(req: Request): Promise<Response> {
		if (req.method !== "POST") return json({ error: "method" }, 405);
		if (!new URL(req.url).pathname.endsWith("/decide")) {
			return json({ error: "not_found" }, 404);
		}
		let raw: unknown;
		try {
			raw = await req.json();
		} catch {
			return json({ error: "bad_json" }, 400);
		}
		const body = parseBody(raw);
		if (!body) return json({ error: "bad_request" }, 400);

		// ---- critical section: no `await` past this point ----
		return json(this.handleDecide(body));
	}

	/**
	 * Synchronous by contract. See the module header — this being free of
	 * `await` is the entire atomicity argument.
	 */
	private handleDecide(body: DecideBody): RateLimitResult {
		// The shard's own clock, never a caller-supplied timestamp. One authority
		// per identity means one timeline; stamps written against a skewed colo
		// clock would either never age out of the short window (false blocks) or
		// arrive already pruned (free requests). It also keeps a value an
		// attacker could eventually reach from entering the arithmetic at all.
		const now = Date.now();
		this.sweep(now);

		const scopeKey = `${body.scope}:${body.identity}`;
		const globalKey = `global:${body.identity}`;

		const scoped = decideStamps(this.read(scopeKey, now), body.config, now);
		if (scoped.reason) return { ok: false, reason: scoped.reason };

		const global = decideStamps(this.read(globalKey, now), body.envelope, now);
		// Both buckets are decided against one shard's state in one pass, which
		// is what makes the global envelope a real backstop rather than a second
		// racing counter that multiplies with the first.
		if (global.reason) return { ok: false, reason: "global" };

		// Only now does anything get spent — a request blocked by the scope
		// bucket must not also burn envelope budget.
		this.write(scopeKey, scoped.stamps, now, body.config.long.windowSec);
		this.write(globalKey, global.stamps, now, body.envelope.long.windowSec);
		this.evict();
		return { ok: true };
	}

	private read(key: string, now: number): number[] {
		const e = this.buckets.get(key);
		if (!e) return [];
		if (e.expiresAt <= now) {
			this.buckets.delete(key);
			return [];
		}
		return e.stamps;
	}

	private write(
		key: string,
		stamps: number[],
		now: number,
		windowSec: number,
	): void {
		stamps.push(now);
		// delete-then-set moves the key to the end of the Map's insertion order,
		// which is what makes iteration order LRU order for `evict`.
		this.buckets.delete(key);
		this.buckets.set(key, {
			stamps: stamps.length > MAX_STAMPS ? stamps.slice(-MAX_STAMPS) : stamps,
			expiresAt: now + windowSec * 1000,
		});
	}

	private sweep(now: number): void {
		for (let i = 0; i < SWEEP_SLICE; i++) {
			if (!this.sweepIter) this.sweepIter = this.buckets.keys();
			const next = this.sweepIter.next();
			if (next.done) {
				// One full pass per call at most, so a small shard doesn't spin.
				this.sweepIter = null;
				return;
			}
			const e = this.buckets.get(next.value);
			if (e && e.expiresAt <= now) this.buckets.delete(next.value);
		}
	}

	private evict(): void {
		if (this.buckets.size <= MAX_BUCKETS) return;
		const target = MAX_BUCKETS - EVICT_BATCH;
		for (const key of this.buckets.keys()) {
			if (this.buckets.size <= target) break;
			this.buckets.delete(key);
		}
		// The iterator is now positioned inside a range that no longer exists;
		// restart the sweep rather than trust it.
		this.sweepIter = null;
	}
}
