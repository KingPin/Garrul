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
	/**
	 * Never answer, except by honouring the request's `AbortSignal` — a shard
	 * that has gone away without closing the connection, which is the case
	 * `SHARD_TIMEOUT_MS` exists for. Rejecting only on abort is the point: if
	 * the client stops attaching a signal, this hangs forever and the test times
	 * out loudly instead of passing.
	 *
	 * The parked request is rooted in `parked` for the life of the wait. It is
	 * otherwise reachable only from its own abort listener — `req` ->
	 * `req.signal` -> listener closure -> `req` is a cycle with nothing outside
	 * it holding on — and a GC inside the deadline window would collect the
	 * listener, leaving the abort to fire against nothing and this promise to
	 * never settle. That is one of the two weak links that made this suite
	 * order-dependent; the other is the deadline signal itself, rooted on the
	 * test side.
	 */
	hang?: boolean;
};

export const makeMockDoNamespace = (
	opts: MockDoOptions = {},
): MockDoNamespace => {
	const shards = new Map<string, RateLimitShard>();
	const names: string[] = [];
	const state = { fetches: 0 };
	/**
	 * Strong roots for the requests parked by `hang`. Load-bearing: see the
	 * `hang` docblock above for why, and tests/ratelimit-do.test.ts for the
	 * matching root on the deadline signal. Entries are dropped on abort, so
	 * this holds only what is currently parked.
	 */
	const parked = new Set<Request>();

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
					if (opts.hang) {
						return new Promise<Response>((_resolve, reject) => {
							if (req.signal.aborted) return reject(req.signal.reason);
							parked.add(req);
							const settle = () => {
								clearInterval(poll);
								parked.delete(req);
								reject(req.signal.reason);
							};
							req.signal.addEventListener("abort", settle);
							// Poll as well as listen. The assertion is unchanged — this
							// still settles only when the request's OWN signal aborts, so
							// a client that stops attaching one still hangs and still
							// fails the test loudly. What the poll removes is the
							// dependence on the listener surviving to be called: the
							// listener, `req` and `req.signal` form a cycle that nothing
							// outside holds, and node keeps a timeout signal weakly, so
							// delivery was contingent on GC timing. That is what made
							// this suite order-dependent — the hung-shard test passed
							// alone and timed out after the 1000-identity distribution
							// test allocated enough to collect in the deadline window.
							const poll = setInterval(() => {
								if (req.signal.aborted) settle();
							}, 1);
						});
					}
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
