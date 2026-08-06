/**
 * Tracks whether a Turnstile token is available, and lets a submit wait for one.
 *
 * The widget mounts its Turnstile iframe on first composer focus rather than at
 * page render, because api.js plus the challenge platform it pulls in is larger
 * than the entire comment widget and almost nobody who loads a page comments
 * (issue #49). That trade costs one thing: the token is no longer guaranteed to
 * be sitting in the form by the time someone posts. A submit therefore has to be
 * able to wait — and to say something useful when the wait doesn't end well.
 *
 * Deciding *what* to say is the whole reason this is a state machine and not a
 * promise. Silence has four causes, and they need four different answers:
 *
 *   - The challenge wants a human to click. Tell them to do that, and leave the
 *     composer usable.
 *   - api.js or the frame never came up. Tell them it didn't load, and leave the
 *     composer usable so a retry is possible.
 *   - Turnstile reported an error it says to retry. Reset the challenge, say so,
 *     and leave the composer usable — once (see RETRYABLE_TURNSTILE_ERROR).
 *   - Turnstile reported an actual error. That verdict is authoritative: say so
 *     and keep the composer disabled.
 *
 * The frame reports `ready` and `interactive` (see the wire protocol in
 * src/routes/embed-iframe.ts) precisely so the first two can be told apart. When
 * those never arrive — an old cached frame document, or a frame that never
 * executed — the cap below is the fallback, and it errs toward the recoverable
 * reading.
 *
 * Everything here is deliberately DOM-free so it can be unit-tested in this
 * repo's plain `node` Vitest pool, the same split `autosize.ts` uses. The iframe,
 * the postMessage plumbing and the hidden input stay in `embed.ts`, which drives
 * this module by calling `token()` / `signal()` as messages arrive.
 */

/**
 * How long a waiting submit gives Turnstile before giving up.
 *
 * Above the frame's own 8000ms api.js watchdog (src/routes/embed-iframe.ts) on
 * purpose: when both are running, that watchdog can tell "api.js never arrived"
 * from "the challenge is waiting on a click" and this cap cannot, so the frame
 * should always win the race and produce the better message. This is only the
 * backstop for a frame that never ran at all. Move one and you must move the
 * other.
 */
export const TURNSTILE_WAIT_MS = 9000;

/**
 * Turnstile error codes whose documented remedy is to reset and try again.
 *
 * `300***` is Turnstile's generic internal/execution error and `600***` is a
 * failed challenge execution; Cloudflare's own guidance for both is
 * `turnstile.reset()`. Everything else is a standing condition a retry cannot
 * fix — `110***` sitekey/domain mismatches and `102***`/`104***`/`106***`
 * invalid parameters would fail identically forever, and retrying them just
 * spends the visitor's time before showing the same message.
 *
 * Matching is deliberately fail-safe in the latching direction: a code shape
 * this doesn't recognize (including a missing code) is treated as permanent, so
 * a future Turnstile code family can never turn into a silent retry loop.
 */
const RETRYABLE_TURNSTILE_ERROR = /^(300|600)\d*$/;

/** Non-token messages the frame can send. */
export type TurnstileSignal = "ready" | "interactive" | "expired" | "error";

export type TurnstileWaitResult =
	| { ok: true; token: string }
	/**
	 * `interactive`, `timeout` and `retrying` are recoverable — show a message
	 * and re-enable the composer. `failed` is not: it means Turnstile said so
	 * itself, about something a retry cannot fix.
	 */
	| { ok: false; reason: "interactive" | "failed" | "timeout" | "retrying" };

export interface TurnstileGate {
	/** Mount the frame if it isn't mounted. Safe to call on every focus event. */
	arm(): void;
	readonly mounted: boolean;
	/** Turnstile reported an error; the caller must not re-enable submit. */
	readonly failed: boolean;
	/** A token arrived. An empty string is treated as "no token". */
	token(token: string): void;
	/**
	 * `code` is Turnstile's error code, and only ever accompanies `"error"`. It
	 * is what decides between a retry and the sticky failure; see
	 * RETRYABLE_TURNSTILE_ERROR.
	 */
	signal(sig: TurnstileSignal, code?: string): void;
	/** Forget the current token, so the next `wait()` really waits. */
	clear(): void;
	/** Arm if needed, then resolve as soon as a usable token exists. */
	wait(): Promise<TurnstileWaitResult>;
	/** Abandon: stop the timer, release waiters, ignore everything after. */
	dispose(): void;
}

export const createTurnstileGate = (opts: {
	/** Creates the iframe. Called at most once, synchronously, from `arm()`. */
	mount: () => void;
	/** Fired once, the first time the frame reports an unrecoverable error. */
	onFailed: () => void;
	/**
	 * Fired once, when a retryable error is spending the retry budget: re-arm
	 * the challenge (the frame's `garrul:turnstile-reset`). Runs after waiters
	 * have been settled, so a throwing implementation can't strand a submit.
	 */
	onRetry: () => void;
	/** Override for tests. */
	waitMs?: number;
}): TurnstileGate => {
	const waitMs = opts.waitMs ?? TURNSTILE_WAIT_MS;

	let mounted = false;
	let failed = false;
	let notifiedFailure = false;
	/**
	 * One reset, per gate. A blip is indistinguishable from an outage after the
	 * second identical error, and a visitor watching "retrying…" loop is worse
	 * served than one told to reload.
	 */
	let retriesLeft = 1;
	let disposed = false;
	/** Any message at all proves the frame document is executing. */
	let alive = false;
	/** Latched: a human has to act before a token can exist. */
	let interactive = false;
	let held = "";
	let waiters: ((r: TurnstileWaitResult) => void)[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;

	const settle = (result: TurnstileWaitResult): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		// Swap before calling out: a resolve handler that starts another wait
		// must not append to the list we're mid-way through draining.
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve(result);
	};

	const onCapExpired = (): void => {
		timer = undefined;
		// The frame answered at some point, so something is rendered and the most
		// likely explanation for a missing token is that it's waiting on the
		// visitor. Latch it, so a second submit doesn't sit through another full
		// cap — a token arriving late still wins, because `wait()` checks for a
		// held token before this flag.
		if (alive) interactive = true;
		settle({
			ok: false,
			reason: alive ? "interactive" : "timeout",
		});
		// Deliberately not onFailed(): a cap expiring is a guess, and the sticky
		// disabled composer is reserved for Turnstile's own verdict. An old cached
		// frame that never sends `ready` must not be able to brick the composer.
	};

	const arm = (): void => {
		if (disposed || failed || mounted) return;
		mounted = true;
		opts.mount();
	};

	return {
		arm,
		get mounted() {
			return mounted;
		},
		get failed() {
			return failed;
		},

		token: (t) => {
			if (disposed) return;
			alive = true;
			if (!t) {
				held = "";
				return;
			}
			// A token means nothing is waiting on the visitor any more.
			interactive = false;
			held = t;
			settle({ ok: true, token: t });
		},

		signal: (sig, code) => {
			if (disposed) return;
			if (sig !== "error") alive = true;
			switch (sig) {
				case "ready":
					return;
				case "interactive":
					interactive = true;
					settle({ ok: false, reason: "interactive" });
					return;
				case "expired":
					// Turnstile re-challenges on its own, so a fresh token is coming.
					// Drop the stale one but leave waiters pending — resolving here
					// would hand a submit the empty string it's trying to avoid.
					held = "";
					return;
				case "error":
					if (
						retriesLeft > 0 &&
						code &&
						RETRYABLE_TURNSTILE_ERROR.test(code)
					) {
						retriesLeft -= 1;
						// A code can only come from `error-callback`, which only exists
						// once render() has run — so unlike a code-less error, this one
						// proves the frame document executed. That matters if the reset
						// then produces nothing: the cap should read as "waiting on the
						// visitor", not as "never loaded".
						alive = true;
						held = "";
						// The reset re-arms the challenge, so whatever the old one was
						// waiting on says nothing about the new one (same reasoning as
						// `clear()`).
						interactive = false;
						settle({ ok: false, reason: "retrying" });
						opts.onRetry();
						return;
					}
					failed = true;
					settle({ ok: false, reason: "failed" });
					if (!notifiedFailure) {
						notifiedFailure = true;
						opts.onFailed();
					}
					return;
			}
		},

		clear: () => {
			held = "";
			// reset() re-arms the challenge, so a previously-latched interactive
			// state says nothing about the new one.
			interactive = false;
		},

		wait: () => {
			if (disposed) {
				return Promise.resolve({
					ok: false as const,
					reason: "timeout" as const,
				});
			}
			if (failed) {
				return Promise.resolve({
					ok: false as const,
					reason: "failed" as const,
				});
			}
			arm();
			// Held token first: it outranks a stale interactive latch.
			if (held) return Promise.resolve({ ok: true as const, token: held });
			if (interactive) {
				return Promise.resolve({
					ok: false as const,
					reason: "interactive" as const,
				});
			}
			return new Promise<TurnstileWaitResult>((resolve) => {
				waiters.push(resolve);
				// One timer for all waiters — a second submit can't extend the
				// budget the first one is already spending.
				if (timer === undefined) timer = setTimeout(onCapExpired, waitMs);
			});
		},

		dispose: () => {
			disposed = true;
			settle({ ok: false, reason: "timeout" });
		},
	};
};
