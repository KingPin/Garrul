/**
 * In-memory stand-in for a `DurableObjectNamespace`, routing `idFromName` /
 * `get().fetch()` to REAL `RateLimitShard` instances.
 *
 * Real instances, not fakes: the whole claim under test is that the shard's
 * decide cannot interleave, and a fake that answers from a script would assert
 * the harness rather than the code. What this helper stands in for is only the
 * plumbing — name-to-instance routing and the stub `fetch` — which is exactly
 * the part workerd would otherwise provide.
 *
 * The cast is deliberate and named, for the same reason as `asD1` in
 * tests/helpers/d1.ts: the real namespace also declares `newUniqueId`,
 * `idFromString` and `jurisdiction`, and a stub that lied about supporting
 * them would be worse than one that visibly doesn't. If the code under test
 * starts calling one, it throws `is not a function` and the test fails loudly.
 */
import { RateLimitShard } from "../../src/lib/ratelimit-shard";

export type MockDoNamespace = {
	namespace: DurableObjectNamespace;
	/** Live shards, keyed by the name `idFromName` was called with. */
	shards: Map<string, RateLimitShard>;
	/** Every name routed through, in call order — including repeats. */
	names: string[];
	/** Stub fetches issued. */
	fetches: number;
};

export type MockDoOptions = {
	/** Throw from the stub `fetch` instead of delegating. */
	fail?: () => never;
	/** Answer with this instead of delegating to a real shard. */
	respond?: () => Response;
	/**
	 * Yield to the event loop before delegating, so concurrent callers are
	 * genuinely interleaved rather than accidentally serialised by the
	 * microtask ordering of a synchronous mock. Without this, an atomicity
	 * assertion could pass for the wrong reason.
	 */
	yieldFirst?: boolean;
};

export const makeMockDoNamespace = (
	opts: MockDoOptions = {},
): MockDoNamespace => {
	const shards = new Map<string, RateLimitShard>();
	const names: string[] = [];
	const state = { fetches: 0 };

	const namespace = {
		idFromName(name: string) {
			names.push(name);
			// The "id" is just the name — this harness has no id semantics beyond
			// routing, and carrying the name through keeps `shards` inspectable.
			return { name, toString: () => name };
		},
		get(id: { name: string }) {
			return {
				fetch: async (req: Request): Promise<Response> => {
					state.fetches++;
					if (opts.yieldFirst) await Promise.resolve();
					if (opts.fail) opts.fail();
					if (opts.respond) return opts.respond();
					let shard = shards.get(id.name);
					if (!shard) {
						shard = new RateLimitShard({} as DurableObjectState, {} as unknown);
						shards.set(id.name, shard);
					}
					return shard.fetch(req);
				},
			};
		},
	} as unknown as DurableObjectNamespace;

	return {
		namespace,
		shards,
		names,
		get fetches() {
			return state.fetches;
		},
	};
};
