/**
 * Turnstile token gate (src/widget/turnstile-gate.ts).
 *
 * Issue #49 defers the Turnstile mount to first composer focus, which means a
 * submit can arrive before a token exists. These cover the two things that are
 * load-bearing: that nothing mounts until something asks (the entire point of the
 * change), and that every way a wait can end maps to the right verdict — because
 * one of those verdicts disables the composer permanently and the others must not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTurnstileGate,
	TURNSTILE_WAIT_MS,
	type TurnstileGate,
	type TurnstileWaitResult,
} from "../src/widget/turnstile-gate";

/** A gate plus the two side effects worth observing. */
const makeGate = (
	waitMs?: number,
): {
	gate: TurnstileGate;
	mounts: () => number;
	failures: () => number;
} => {
	let mounts = 0;
	let failures = 0;
	const gate = createTurnstileGate({
		mount: () => {
			mounts += 1;
		},
		onFailed: () => {
			failures += 1;
		},
		...(waitMs === undefined ? {} : { waitMs }),
	});
	return { gate, mounts: () => mounts, failures: () => failures };
};

/**
 * Whether a promise has settled, without awaiting it. `Promise.race` against an
 * already-resolved sentinel resolves to the sentinel if `p` is still pending.
 */
const settled = async (
	p: Promise<TurnstileWaitResult>,
): Promise<TurnstileWaitResult | "pending"> =>
	Promise.race([p, Promise.resolve("pending" as const)]);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createTurnstileGate", () => {
	describe("mounting", () => {
		it("does not mount until something arms it", () => {
			// The whole issue: a visitor who never touches the composer must never
			// pay for api.js.
			const { mounts } = makeGate();
			expect(mounts()).toBe(0);
		});

		it("mounts once no matter how many times it is armed", () => {
			const { gate, mounts } = makeGate();
			gate.arm();
			gate.arm();
			gate.arm();
			expect(mounts()).toBe(1);
			expect(gate.mounted).toBe(true);
		});

		it("arms from wait(), and repeat waits never re-mount", async () => {
			const { gate, mounts } = makeGate();
			void gate.wait();
			void gate.wait();
			expect(mounts()).toBe(1);
			gate.token("tok");
			void gate.wait();
			expect(mounts()).toBe(1);
		});
	});

	describe("resolving with a token", () => {
		it("resolves immediately when a token is already held", async () => {
			const { gate } = makeGate();
			gate.token("tok-1");
			await expect(gate.wait()).resolves.toEqual({ ok: true, token: "tok-1" });
			// Nothing should be scheduled — a held token needs no timer.
			expect(vi.getTimerCount()).toBe(0);
		});

		it("resolves when the token arrives after the wait starts", async () => {
			const { gate } = makeGate();
			const p = gate.wait();
			expect(await settled(p)).toBe("pending");
			gate.token("tok-2");
			await expect(p).resolves.toEqual({ ok: true, token: "tok-2" });
			expect(vi.getTimerCount()).toBe(0);
		});

		it("keeps waiting through an expiry, then resolves with the refresh", async () => {
			// Focus, walk away past the ~5min token lifetime, come back and post.
			// Turnstile re-challenges on its own, so the right move is to wait for
			// the replacement rather than hand the submit an empty string.
			const { gate } = makeGate();
			gate.token("stale");
			gate.signal("expired");
			const p = gate.wait();
			expect(await settled(p)).toBe("pending");
			gate.signal("expired");
			expect(await settled(p)).toBe("pending");
			gate.token("fresh");
			await expect(p).resolves.toEqual({ ok: true, token: "fresh" });
		});
	});

	describe("Turnstile's own error verdict", () => {
		it("resolves a pending wait as failed and reports it once", async () => {
			const { gate, failures } = makeGate();
			const p = gate.wait();
			gate.signal("error");
			await expect(p).resolves.toEqual({ ok: false, reason: "failed" });
			expect(failures()).toBe(1);
			expect(gate.failed).toBe(true);
		});

		it("reports a failure that arrives with nobody waiting", async () => {
			const { gate, mounts, failures } = makeGate();
			gate.arm();
			gate.signal("error");
			gate.signal("error");
			expect(failures()).toBe(1);
			// A later submit gets the verdict without waiting for anything.
			await expect(gate.wait()).resolves.toEqual({
				ok: false,
				reason: "failed",
			});
			expect(mounts()).toBe(1);
		});

		it("does not mount after failing", () => {
			const { gate, mounts } = makeGate();
			gate.signal("error");
			gate.arm();
			expect(mounts()).toBe(0);
		});
	});

	describe("challenges that need a human", () => {
		it("stops waiting as soon as the frame says it is interactive", async () => {
			const { gate, failures } = makeGate();
			const p = gate.wait();
			gate.signal("ready");
			gate.signal("interactive");
			// Resolves on the signal, not by burning the whole cap.
			await expect(p).resolves.toEqual({ ok: false, reason: "interactive" });
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS * 2);
			expect(failures()).toBe(0);
		});

		it("reads a silent-but-alive frame as interactive at the cap", async () => {
			// `ready` proves api.js loaded and the widget painted, so a missing
			// token means it is waiting on the visitor.
			const { gate, failures } = makeGate();
			const p = gate.wait();
			gate.signal("ready");
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
			await expect(p).resolves.toEqual({ ok: false, reason: "interactive" });
			// A guess must never trip the sticky disabled state.
			expect(failures()).toBe(0);
			expect(gate.failed).toBe(false);
		});

		it("does not make a second submit sit through another full cap", async () => {
			const { gate } = makeGate();
			const first = gate.wait();
			gate.signal("ready");
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
			await expect(first).resolves.toEqual({
				ok: false,
				reason: "interactive",
			});
			await expect(gate.wait()).resolves.toEqual({
				ok: false,
				reason: "interactive",
			});
		});

		it("still prefers a token that lands after the cap expired", async () => {
			const { gate } = makeGate();
			const first = gate.wait();
			gate.signal("ready");
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
			await expect(first).resolves.toEqual({
				ok: false,
				reason: "interactive",
			});
			// Solved late, or merely slow. Either way the token wins over the
			// latched guess.
			gate.token("late");
			await expect(gate.wait()).resolves.toEqual({
				ok: true,
				token: "late",
			});
		});
	});

	describe("a frame that never came up", () => {
		it("reads total silence as a load failure at the cap", async () => {
			const { gate, failures } = makeGate();
			const p = gate.wait();
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
			await expect(p).resolves.toEqual({ ok: false, reason: "timeout" });
			// Version skew: an old cached frame document sends no `ready`, so this
			// path can fire for a perfectly working interactive challenge. It must
			// stay recoverable — never the sticky disabled composer.
			expect(failures()).toBe(0);
			expect(gate.failed).toBe(false);
		});

		it("does not give up before the cap", async () => {
			const { gate } = makeGate();
			const p = gate.wait();
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS - 1);
			expect(await settled(p)).toBe("pending");
		});
	});

	describe("reset after a rejected post", () => {
		it("makes the next wait wait again", async () => {
			// submit() calls reset() on a server rejection, which clears the token
			// and re-challenges. A cached one-shot promise would resolve instantly
			// here with the value that was just cleared.
			const { gate } = makeGate();
			gate.token("used");
			await expect(gate.wait()).resolves.toEqual({ ok: true, token: "used" });
			gate.clear();
			const p = gate.wait();
			expect(await settled(p)).toBe("pending");
			gate.token("re-solved");
			await expect(p).resolves.toEqual({ ok: true, token: "re-solved" });
		});

		it("drops a latched interactive state, since reset re-arms the challenge", async () => {
			const { gate } = makeGate();
			gate.signal("interactive");
			await expect(gate.wait()).resolves.toEqual({
				ok: false,
				reason: "interactive",
			});
			gate.clear();
			const p = gate.wait();
			expect(await settled(p)).toBe("pending");
		});
	});

	describe("concurrent waits", () => {
		it("share one timer and resolve identically", async () => {
			const { gate } = makeGate();
			const a = gate.wait();
			const b = gate.wait();
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS);
			const expected = { ok: false, reason: "timeout" };
			await expect(a).resolves.toEqual(expected);
			await expect(b).resolves.toEqual(expected);
		});

		it("resolve together on a token", async () => {
			const { gate } = makeGate();
			const a = gate.wait();
			const b = gate.wait();
			gate.token("shared");
			await expect(a).resolves.toEqual({ ok: true, token: "shared" });
			await expect(b).resolves.toEqual({ ok: true, token: "shared" });
		});
	});

	describe("dispose", () => {
		it("releases pending waiters and stops the timer", async () => {
			const { gate } = makeGate();
			const p = gate.wait();
			gate.dispose();
			await expect(p).resolves.toEqual({ ok: false, reason: "timeout" });
			expect(vi.getTimerCount()).toBe(0);
		});

		it("ignores everything that arrives afterwards", async () => {
			// The frame outlives the composer on a reload; late messages from a
			// detached iframe must not resurrect anything.
			const { gate, failures } = makeGate();
			gate.arm();
			gate.dispose();
			gate.token("too-late");
			gate.signal("error");
			expect(failures()).toBe(0);
			expect(gate.failed).toBe(false);
			await expect(gate.wait()).resolves.toEqual({
				ok: false,
				reason: "timeout",
			});
		});

		it("does not mount after disposal", () => {
			const { gate, mounts } = makeGate();
			gate.dispose();
			gate.arm();
			void gate.wait();
			expect(mounts()).toBe(0);
		});
	});

	it("honors a waitMs override", async () => {
		const { gate } = makeGate(500);
		const p = gate.wait();
		await vi.advanceTimersByTimeAsync(499);
		expect(await settled(p)).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		await expect(p).resolves.toEqual({ ok: false, reason: "timeout" });
	});

	it("stays above the frame's own api.js watchdog", () => {
		// src/routes/embed-iframe.ts gives api.js 8000ms and then reports an
		// error. That verdict is more specific than this cap's guess, so it has to
		// land first. If either number moves, this is the tripwire.
		expect(TURNSTILE_WAIT_MS).toBeGreaterThan(8000);
	});
});
