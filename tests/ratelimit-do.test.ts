/**
 * The Durable Object backend end to end: `checkRateLimit` -> namespace stub ->
 * a real `RateLimitShard`.
 *
 * The headline assertion is the inverse of the one pinned in
 * ratelimit.test.ts ("lets N concurrent requests through while advancing the
 * bucket by one"). That test reproduces the production race in the node pool
 * with nothing but `await Promise.resolve()` standing in for colo latency —
 * which works because the mechanism is the same in node as in workerd: an
 * `await` separates the decision from the write, and the event loop runs
 * another request in the gap.
 *
 * The shard removes the gap rather than guarding it, so run-to-completion — a
 * LANGUAGE guarantee — forbids interleaving. Node cannot reproduce workerd's
 * cross-request input gate, and the design deliberately does not depend on it,
 * which makes proving the property here the stronger claim rather than a
 * weaker approximation of it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
	checkRateLimit,
	DEFAULTS,
	GLOBAL_ENVELOPE,
	type RateLimitEnv,
} from "../src/lib/ratelimit";
import { makeMockDoNamespace, type MockDoOptions } from "./helpers/do";

const REQ_URL = "https://comments.example.com/api/v1/comments";

const envWith = (opts: MockDoOptions = {}) => {
	const mock = makeMockDoNamespace(opts);
	return { mock, env: { RATE_LIMIT_DO: mock.namespace } satisfies RateLimitEnv };
};

describe("checkRateLimit on the Durable Object backend", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lets exactly ONE of N concurrent requests through", async () => {
		// The acceptance criterion for issue #53. On the Cache API all N pass and
		// the bucket advances by one stamp, so the overshoot is a sustained N×
		// multiplier. Here the cap is the cap.
		const { env } = envWith({ yieldFirst: true });
		const N = 25;
		const results = await Promise.all(
			Array.from({ length: N }, () =>
				checkRateLimit(REQ_URL, "ip-race", {
					scope: "test",
					config: DEFAULTS, // short.max = 1
					env,
				}),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => r.reason === "short")).toHaveLength(N - 1);
		// Nothing may have passed by failing open — that would make the count
		// above accidentally right for entirely the wrong reason.
		expect(results.some((r) => r.degraded)).toBe(false);
	});

	it("makes the global envelope a real backstop under concurrency", async () => {
		// Every request uses a distinct scope, so only the envelope can stop it,
		// and they all run at once. On the Cache API the envelope races exactly
		// like the scope bucket and multiplies with it instead of bounding it.
		const { env } = envWith({ yieldFirst: true });
		const N = GLOBAL_ENVELOPE.short.max + 5;
		const results = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				checkRateLimit(REQ_URL, "ip-spray", { scope: `scope-${i}`, env }),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(GLOBAL_ENVELOPE.short.max);
		expect(results.filter((r) => r.reason === "global")).toHaveLength(5);
	});

	it("costs one hop and decides both buckets there", async () => {
		const { mock, env } = envWith();
		const r = await checkRateLimit(REQ_URL, "ip-1", { scope: "test", env });
		expect(r).toEqual({ ok: true });
		expect(mock.fetches).toBe(1);
		// One shard, one instance — both buckets landed together.
		expect(mock.shards.size).toBe(1);
	});

	it("shards on the identity, not the bucket key", async () => {
		// If sharding used `${scope}:${identity}`, the scope bucket and the
		// envelope would live on different instances: two hops, and an envelope
		// decided against state the scope bucket never saw.
		const { mock, env } = envWith();
		await checkRateLimit(REQ_URL, "ip-2", { scope: "comment", env });
		await checkRateLimit(REQ_URL, "ip-2", { scope: "preview", env });
		expect(new Set(mock.names).size).toBe(1);
	});

	it("keeps distinct identities independent", async () => {
		const { env } = envWith();
		expect((await checkRateLimit(REQ_URL, "ip-a", { scope: "t", env })).ok).toBe(
			true,
		);
		expect((await checkRateLimit(REQ_URL, "ip-b", { scope: "t", env })).ok).toBe(
			true,
		);
	});

	it("spreads identities across all shards without a hot one", async () => {
		const { mock, env } = envWith();
		const N = 1_000;
		for (let i = 0; i < N; i++) {
			await checkRateLimit(REQ_URL, `ip-hash-${i}`, { scope: "t", env });
		}
		const counts = new Map<string, number>();
		for (const n of mock.names) counts.set(n, (counts.get(n) ?? 0) + 1);
		expect(counts.size).toBe(8);
		// No shard may take a wildly disproportionate share — a skewed hash would
		// concentrate load and defeat the point of having more than one.
		for (const c of counts.values()) expect(c).toBeLessThan(N * 0.25);
	});

	describe("fails open", () => {
		const cases: Array<[string, MockDoOptions | "absent" | "wrong-type"]> = [
			["the namespace is absent", "absent"],
			["the binding is not a namespace", "wrong-type"],
			[
				"the stub fetch rejects",
				{
					fail: () => {
						throw new Error("no route to colo");
					},
				},
			],
			["the shard 500s", { respond: () => new Response("boom", { status: 500 }) }],
			["the shard 400s", { respond: () => new Response("bad", { status: 400 }) }],
			["the body is not JSON", { respond: () => new Response("not json") }],
			[
				"the body is a scalar",
				{ respond: () => Response.json(7) },
			],
			["the body has no verdict", { respond: () => Response.json({}) }],
			[
				"the verdict is not a boolean",
				{ respond: () => Response.json({ ok: "yes" }) },
			],
			[
				"the reason is unrecognised",
				{ respond: () => Response.json({ ok: false, reason: "weird" }) },
			],
		];

		it.each(cases)("when %s", async (_label, mode) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const env: RateLimitEnv =
				mode === "absent"
					? {}
					: mode === "wrong-type"
						? ({ RATE_LIMIT_DO: { notANamespace: true } } as unknown as RateLimitEnv)
						: { RATE_LIMIT_DO: makeMockDoNamespace(mode).namespace };

			const r = await checkRateLimit(REQ_URL, "ip-hash-secret", {
				scope: "test",
				env,
			});

			const warns = spy.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("ratelimit.degraded"));

			if (mode === "absent" || mode === "wrong-type") {
				// No usable binding is not a failure — it falls back to the Cache
				// API, which in the node pool has no `caches` global and degrades
				// from there. What matters is that it never throws and never
				// silently reports itself as the DO backend.
				expect(r.ok).toBe(true);
				for (const w of warns) {
					expect(JSON.parse(w).backend).toBe("cache");
				}
			} else {
				expect(r).toEqual({ ok: true, degraded: true });
				expect(warns).toHaveLength(1);
				expect(JSON.parse(warns[0] as string).backend).toBe("do");
			}
			// Log hygiene: the identity is an IP hash and never belongs in a log
			// line, on any path.
			for (const w of warns) expect(w).not.toContain("ip-hash-secret");
		});

		it("when the shard hangs, on the timeout it actually attaches", async () => {
			// The one property that cannot be proven in the node pool is whether
			// workerd honors `AbortSignal.timeout` on a DO stub fetch; that was
			// checked by hand against `wrangler dev` with a genuinely hung shard.
			// What IS provable here, and what a refactor could silently break, is
			// the half Garrul owns: that a signal is attached at all, and that the
			// abort surfaces as a throw rather than a synthetic block.
			//
			// Substituting a short deadline for the real one keeps this in
			// milliseconds while still running the production call — the spy's
			// argument pins the 2s value, so shortening it here cannot hide a
			// change to it. Fake timers are not an option: vitest's do not drive
			// `AbortSignal.timeout`, which is a host timer.
			//
			// `deadlines` is load-bearing, not debug residue. Node holds a
			// timeout signal WEAKLY — the docs are explicit that a caller must
			// keep a strong reference or the timer may be collected before it
			// elapses — and production hands the signal straight to `new
			// Request(...)`, which does not root it either, so without this
			// array nothing in the chain roots it at all. That is one of the two
			// weak references that made this test order-dependent, and it timed
			// out at 5s whenever the 1000-identity distribution test above had
			// allocated enough to collect inside the deadline window. The other
			// weak reference is the parked request itself, rooted in
			// tests/helpers/do.ts. Both are node object-lifetime artifacts of the
			// harness; neither was a node-vs-workerd semantic gap, which is what
			// this failure was previously recorded as.
			const real = AbortSignal.timeout.bind(AbortSignal);
			const deadlines: AbortSignal[] = [];
			const timeout = vi
				.spyOn(AbortSignal, "timeout")
				.mockImplementation(() => {
					const signal = real(5);
					deadlines.push(signal);
					return signal;
				});
			vi.spyOn(console, "log").mockImplementation(() => {});

			const { env } = envWith({ hang: true });
			const r = await checkRateLimit(REQ_URL, "ip-hung", { scope: "test", env });

			expect(r).toEqual({ ok: true, degraded: true });
			expect(timeout).toHaveBeenCalledWith(2_000);
			// Reads `deadlines` after the await so the reference is live across
			// it and cannot be optimised away.
			expect(deadlines).toHaveLength(1);
			expect(deadlines[0]?.aborted).toBe(true);
		});

		it("never fails CLOSED on a wrong-shaped verdict", async () => {
			// Coercing garbage to `{ok:false}` would turn one transport glitch
			// into a 429 storm across every write endpoint.
			const { env } = envWith({
				respond: () => Response.json({ blocked: true }),
			});
			vi.spyOn(console, "log").mockImplementation(() => {});
			const r = await checkRateLimit(REQ_URL, "ip-3", { scope: "test", env });
			expect(r.ok).toBe(true);
		});
	});

	it("prefers an injected store over the bound namespace", async () => {
		// Precedence exists so the store-injecting suites keep their meaning even
		// once routes start passing `c.env`.
		const { mock, env } = envWith();
		const { memoryStore } = await import("../src/lib/ratelimit");
		const r = await checkRateLimit(REQ_URL, "ip-4", {
			scope: "test",
			store: memoryStore(),
			env,
		});
		expect(r.ok).toBe(true);
		expect(mock.fetches).toBe(0);
	});
});

describe("route wiring", () => {
	it("passes env at every checkRateLimit call site", async () => {
		// A route that forgets `env` silently lands on the Cache API while the
		// operator believes the Durable Object is enforcing — a limiter quietly
		// weaker than its configuration, with nothing in the logs to say so.
		// Types cannot catch it: `env` is optional so existing tests compile.
		const { readdir, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		// `.href` rather than the URL object: the global `URL` here is
		// workers-types', which node's typings don't accept.
		const dir = fileURLToPath(new URL("../src/routes/", import.meta.url).href);
		const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));

		/** Argument list of the call starting at `open`, paren-balanced. */
		const argsAt = (src: string, open: number): string => {
			let depth = 0;
			for (let i = open; i < src.length; i++) {
				if (src[i] === "(") depth++;
				else if (src[i] === ")" && --depth === 0) return src.slice(open, i);
			}
			return src.slice(open);
		};

		const missing: string[] = [];
		let found = 0;
		for (const f of files) {
			const src = await readFile(join(dir, f), "utf8");
			// Balanced scan rather than a regex: the calls are a mix of one-line
			// and multi-line, and a shape-sensitive pattern would rot the first
			// time one is reformatted.
			for (const m of src.matchAll(/checkRateLimit\s*\(/g)) {
				found++;
				const args = argsAt(src, m.index + m[0].length - 1);
				if (!args.includes("env: c.env")) missing.push(`${f} @${m.index}`);
			}
		}
		expect(missing).toEqual([]);
		// Guards the guard: a regex that stopped matching would otherwise pass
		// vacuously and this test would quietly stop protecting anything.
		expect(found).toBe(13);
	});
});

describe("the wrangler contract", () => {
	it("re-exports RateLimitShard from the worker entry module", async () => {
		// `class_name` in [[durable_objects.bindings]] resolves against the entry
		// module's exports. This also fails loudly the moment someone adds a
		// `cloudflare:workers` import to the shard, which would break the two
		// suites that import src/index.ts at runtime in the node pool.
		const mod = await import("../src/index");
		expect(typeof mod.RateLimitShard).toBe("function");
	});
});
