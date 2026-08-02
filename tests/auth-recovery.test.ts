/**
 * OAuth popup sign-in recovery (src/widget/auth-recovery.ts).
 *
 * The happy path for popup sign-in is the `garrul:auth` postMessage the
 * callback page sends to `window.opener`. A host page that sets
 * `Cross-Origin-Opener-Policy: same-origin` severs that opener, so the message
 * never arrives and the widget sits signed-out until a manual reload — with no
 * console error, because the popup still reports success (issue #58).
 *
 * watchForSignIn is the recovery path: when the reader comes back to the host
 * page, re-check /auth/me and reload if a session showed up. These tests pin
 * the behaviour that keeps that watcher from becoming a hot loop, a leak, or a
 * double-reload.
 */
import { describe, it, expect, vi } from "vitest";
import {
	watchForSignIn,
	OAUTH_RECOVERY_WINDOW_MS,
} from "../src/widget/auth-recovery";

/**
 * Minimal stand-in for `window` + `document`. The node pool has no DOM, and
 * the real thing would give us far more surface than the watcher touches.
 */
const harness = (visibilityState: "visible" | "hidden" = "visible") => {
	const listeners = new Map<string, Set<() => void>>();
	const target = {
		visibilityState,
		addEventListener(type: string, fn: () => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(fn);
			listeners.set(type, set);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get(type)?.delete(fn);
		},
	};
	return {
		target,
		listeners,
		count: () =>
			[...listeners.values()].reduce((n, set) => n + set.size, 0),
		fire: (type: string) => {
			for (const fn of [...(listeners.get(type) ?? [])]) fn();
		},
	};
};

/**
 * Let the watcher's promise chain — including the `finally` that clears its
 * in-flight flag — settle. Real focus events are macrotasks, so this gap always
 * exists in the browser; the tests have to reproduce it explicitly.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watchForSignIn", () => {
	it("reloads when a session appears after the reader returns", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi.fn().mockResolvedValue(true);

		watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.target,
			doc: h.target,
		});
		// Nothing runs until the reader actually comes back.
		expect(checkSignedIn).not.toHaveBeenCalled();

		h.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("also recovers via visibilitychange (same-tab popups)", async () => {
		const h = harness();
		const onSignedIn = vi.fn();

		watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(true),
			onSignedIn,
			win: h.target,
			doc: h.target,
		});

		h.fire("visibilitychange");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("stays quiet when the reader returns still signed out", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi.fn().mockResolvedValue(false);

		watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.target,
			doc: h.target,
		});

		h.fire("focus");
		await vi.waitFor(() => expect(checkSignedIn).toHaveBeenCalled());
		expect(onSignedIn).not.toHaveBeenCalled();
		// Still armed — the reader may just have cancelled the first attempt.
		expect(h.count()).toBeGreaterThan(0);
	});

	it("fires onSignedIn at most once and unsubscribes after it wins", async () => {
		const h = harness();
		const onSignedIn = vi.fn();

		watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(true),
			onSignedIn,
			win: h.target,
			doc: h.target,
		});

		h.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

		// Every listener is gone, so later focus/visibility churn is inert.
		expect(h.count()).toBe(0);
		h.fire("focus");
		h.fire("visibilitychange");
		await new Promise((r) => setTimeout(r, 0));
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it("does not stack overlapping checks while one is in flight", async () => {
		const h = harness();
		let release: (v: boolean) => void = () => {};
		const checkSignedIn = vi.fn(
			() => new Promise<boolean>((res) => (release = res)),
		);

		watchForSignIn({
			checkSignedIn,
			onSignedIn: vi.fn(),
			win: h.target,
			doc: h.target,
		});

		// focus + visibilitychange commonly arrive back-to-back.
		h.fire("focus");
		h.fire("visibilitychange");
		h.fire("focus");
		expect(checkSignedIn).toHaveBeenCalledTimes(1);

		release(false);
		await flush();
		h.fire("focus");
		expect(checkSignedIn).toHaveBeenCalledTimes(2);
	});

	it("ignores a focus that lands while the page is still hidden", () => {
		const h = harness("hidden");
		const checkSignedIn = vi.fn().mockResolvedValue(true);

		watchForSignIn({
			checkSignedIn,
			onSignedIn: vi.fn(),
			win: h.target,
			doc: h.target,
		});

		h.fire("focus");
		expect(checkSignedIn).not.toHaveBeenCalled();
	});

	it("stops watching once the recovery window has elapsed", () => {
		const h = harness();
		const checkSignedIn = vi.fn().mockResolvedValue(true);
		let clock = 1_000;

		watchForSignIn({
			checkSignedIn,
			onSignedIn: vi.fn(),
			win: h.target,
			doc: h.target,
			now: () => clock,
		});

		clock += OAUTH_RECOVERY_WINDOW_MS + 1;
		h.fire("focus");

		expect(checkSignedIn).not.toHaveBeenCalled();
		expect(h.count()).toBe(0);
	});

	it("survives a rejected check and stays armed", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(true);

		watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.target,
			doc: h.target,
		});

		h.fire("focus");
		await flush();
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
		expect(onSignedIn).not.toHaveBeenCalled();

		h.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("can be torn down by the caller when postMessage wins the race", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi.fn().mockResolvedValue(true);

		const stop = watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.target,
			doc: h.target,
		});

		// The `garrul:auth` message arrived and the widget already reloaded.
		stop();
		expect(h.count()).toBe(0);

		h.fire("focus");
		await new Promise((r) => setTimeout(r, 0));
		expect(checkSignedIn).not.toHaveBeenCalled();
		expect(onSignedIn).not.toHaveBeenCalled();
	});

	it("is idempotent when stopped twice", () => {
		const h = harness();
		const stop = watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(false),
			onSignedIn: vi.fn(),
			win: h.target,
			doc: h.target,
		});

		stop();
		expect(() => stop()).not.toThrow();
		expect(h.count()).toBe(0);
	});
});
