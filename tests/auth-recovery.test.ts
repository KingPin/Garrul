/**
 * OAuth popup sign-in recovery (src/widget/auth-recovery.ts).
 *
 * The happy path for popup sign-in is the `garrul:auth` postMessage the
 * callback page sends to `window.opener`. A host page that sets
 * `Cross-Origin-Opener-Policy: same-origin` severs that opener, so the message
 * never arrives and the widget sits signed-out until a manual reload — with no
 * console error, because the popup still reports success (issue #58).
 *
 * watchForSignIn is the recovery path: re-check /auth/me once the popup goes
 * away (or the reader comes back to the page) and reload if a session showed
 * up. These tests pin the behaviour that keeps that watcher from becoming a hot
 * loop, a leak, or a double-reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	watchForSignIn,
	OAUTH_RECOVERY_WINDOW_MS,
	OAUTH_POLL_MS,
} from "../src/widget/auth-recovery";

const eventTarget = () => {
	const listeners = new Map<string, Set<() => void>>();
	return {
		listeners,
		addEventListener(type: string, fn: () => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(fn);
			listeners.set(type, set);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get(type)?.delete(fn);
		},
		count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
		fire: (type: string) => {
			for (const fn of [...(listeners.get(type) ?? [])]) fn();
		},
	};
};

/**
 * Minimal stand-in for `window` + `document`. The node pool has no DOM, and the
 * real thing would give us far more surface than the watcher touches.
 *
 * These are two separate targets on purpose. Sharing one object would let the
 * watcher register `focus` on the document and still pass — and a non-capturing
 * document `focus` listener fires on every input focus, not on window
 * activation.
 */
const harness = (visibilityState: "visible" | "hidden" = "visible") => {
	const win = eventTarget();
	const doc = Object.assign(eventTarget(), { visibilityState });
	return { win, doc, count: () => win.count() + doc.count() };
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
			win: h.win,
			doc: h.doc,
		});
		// Nothing runs until the reader actually comes back.
		expect(checkSignedIn).not.toHaveBeenCalled();

		h.win.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("also recovers via visibilitychange (same-tab popups)", async () => {
		const h = harness();
		const onSignedIn = vi.fn();

		watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(true),
			onSignedIn,
			win: h.win,
			doc: h.doc,
		});

		h.doc.fire("visibilitychange");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("stays quiet when the reader returns still signed out", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi.fn().mockResolvedValue(false);

		watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.win,
			doc: h.doc,
		});

		h.win.fire("focus");
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
			win: h.win,
			doc: h.doc,
		});

		h.win.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

		// Every listener is gone, so later focus/visibility churn is inert.
		expect(h.count()).toBe(0);
		h.win.fire("focus");
		h.doc.fire("visibilitychange");
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
			win: h.win,
			doc: h.doc,
		});

		// focus + visibilitychange commonly arrive back-to-back.
		h.win.fire("focus");
		h.doc.fire("visibilitychange");
		h.win.fire("focus");
		expect(checkSignedIn).toHaveBeenCalledTimes(1);

		release(false);
		await flush();
		h.win.fire("focus");
		expect(checkSignedIn).toHaveBeenCalledTimes(2);
	});

	it("ignores a focus that lands while the page is still hidden", () => {
		const h = harness("hidden");
		const checkSignedIn = vi.fn().mockResolvedValue(true);

		watchForSignIn({
			checkSignedIn,
			onSignedIn: vi.fn(),
			win: h.win,
			doc: h.doc,
		});

		h.win.fire("focus");
		expect(checkSignedIn).not.toHaveBeenCalled();
	});

	it("stops watching once the recovery window has elapsed", () => {
		const h = harness();
		const checkSignedIn = vi.fn().mockResolvedValue(true);
		let clock = 1_000;

		watchForSignIn({
			checkSignedIn,
			onSignedIn: vi.fn(),
			win: h.win,
			doc: h.doc,
			now: () => clock,
		});

		clock += OAUTH_RECOVERY_WINDOW_MS + 1;
		h.win.fire("focus");

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
			win: h.win,
			doc: h.doc,
		});

		h.win.fire("focus");
		await flush();
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
		expect(onSignedIn).not.toHaveBeenCalled();

		h.win.fire("focus");
		await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
	});

	it("can be torn down by the caller when postMessage wins the race", async () => {
		const h = harness();
		const onSignedIn = vi.fn();
		const checkSignedIn = vi.fn().mockResolvedValue(true);

		const stop = watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.win,
			doc: h.doc,
		});

		// The `garrul:auth` message arrived and the widget already reloaded.
		stop();
		expect(h.count()).toBe(0);

		h.win.fire("focus");
		await new Promise((r) => setTimeout(r, 0));
		expect(checkSignedIn).not.toHaveBeenCalled();
		expect(onSignedIn).not.toHaveBeenCalled();
	});

	it("listens for focus on the window and visibilitychange on the document", () => {
		const h = harness();
		watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(false),
			onSignedIn: vi.fn(),
			win: h.win,
			doc: h.doc,
		});

		expect(h.win.listeners.get("focus")?.size).toBe(1);
		expect(h.doc.listeners.get("visibilitychange")?.size).toBe(1);
		// The mirror image would be a silent bug: `focus` doesn't bubble, so a
		// document listener never sees window activation — it sees text inputs.
		expect(h.doc.listeners.get("focus")).toBeUndefined();
		expect(h.win.listeners.get("visibilitychange")).toBeUndefined();
	});

	it("is idempotent when stopped twice", () => {
		const h = harness();
		const stop = watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(false),
			onSignedIn: vi.fn(),
			win: h.win,
			doc: h.doc,
		});

		stop();
		expect(() => stop()).not.toThrow();
		expect(h.count()).toBe(0);
	});
});

/**
 * The COOP case, which is the whole point of the module.
 *
 * Under `Cross-Origin-Opener-Policy: same-origin` the popup's `window.opener`
 * is null, so no message ever arrives — but the *opener's* handle to the popup
 * still reports `closed` accurately (verified against chromium with COOP unset,
 * `same-origin`, and `same-origin-allow-popups`). None of these tests fire a
 * focus event: the popup handle alone has to carry the recovery.
 */
describe("watchForSignIn — popup-closed polling", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const arm = (
		opts: Partial<Parameters<typeof watchForSignIn>[0]> & {
			popupClosed: () => boolean;
		},
	) => {
		const h = harness();
		const onSignedIn = opts.onSignedIn ?? vi.fn();
		const checkSignedIn = opts.checkSignedIn ?? vi.fn().mockResolvedValue(true);
		const stop = watchForSignIn({
			win: h.win,
			doc: h.doc,
			...opts,
			checkSignedIn,
			onSignedIn,
		});
		return { h, onSignedIn, checkSignedIn, stop };
	};

	it("recovers on popup close with no focus event at all", async () => {
		let closed = false;
		const { h, onSignedIn, checkSignedIn } = arm({ popupClosed: () => closed });

		// While the reader is still at the provider, nothing should be polled
		// over the network — only the (free) `closed` property.
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 10);
		expect(checkSignedIn).not.toHaveBeenCalled();

		closed = true;
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);

		expect(onSignedIn).toHaveBeenCalledTimes(1);
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
		expect(h.count()).toBe(0);

		// And the interval is gone with it — no lingering timer.
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 20);
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
	});

	it("checks even when the opener is still hidden (mobile opens a tab)", async () => {
		const h = harness("hidden");
		const onSignedIn = vi.fn();
		watchForSignIn({
			checkSignedIn: vi.fn().mockResolvedValue(true),
			onSignedIn,
			win: h.win,
			doc: h.doc,
			popupClosed: () => true,
		});

		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it("gives up once the popup closed without producing a session", async () => {
		const { h, onSignedIn, checkSignedIn } = arm({
			checkSignedIn: vi.fn().mockResolvedValue(false),
			popupClosed: () => true,
		});

		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
		expect(onSignedIn).not.toHaveBeenCalled();
		// The reader cancelled, or this is a cross-site partition we can never
		// read. Nothing else is coming, so don't sit armed for ten minutes.
		expect(h.count()).toBe(0);
	});

	it("treats a throwing popup handle as 'can't tell yet' and stays armed", async () => {
		let closed = false;
		const { h, onSignedIn, checkSignedIn } = arm({
			popupClosed: () => {
				if (!closed) throw new Error("detached");
				return true;
			},
		});

		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 5);
		expect(checkSignedIn).not.toHaveBeenCalled();
		expect(h.count()).toBeGreaterThan(0);

		closed = true;
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it("does not spend its one close-check on a tick that collided with a focus check", async () => {
		let release: (v: boolean) => void = () => {};
		const checkSignedIn = vi
			.fn()
			.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)))
			.mockResolvedValue(true);
		const h = harness();
		const onSignedIn = vi.fn();
		watchForSignIn({
			checkSignedIn,
			onSignedIn,
			win: h.win,
			doc: h.doc,
			popupClosed: () => true,
		});

		// A focus check is already in flight (started before the cookie landed)
		// when the poll notices the popup is gone.
		h.win.fire("focus");
		expect(checkSignedIn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);
		expect(checkSignedIn).toHaveBeenCalledTimes(1);

		// That stale check comes back signed-out; the poll must still be alive
		// to take its own turn, or the COOP recovery is lost.
		release(false);
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 2);
		expect(onSignedIn).toHaveBeenCalledTimes(1);
	});

	it("stops polling when the caller tears it down", async () => {
		const { checkSignedIn, stop } = arm({ popupClosed: () => true });

		stop();
		await vi.advanceTimersByTimeAsync(OAUTH_POLL_MS * 20);
		expect(checkSignedIn).not.toHaveBeenCalled();
	});

	it("stops polling once the recovery window has elapsed", async () => {
		const { h, checkSignedIn } = arm({ popupClosed: () => false });

		await vi.advanceTimersByTimeAsync(OAUTH_RECOVERY_WINDOW_MS + OAUTH_POLL_MS);
		expect(h.count()).toBe(0);
		expect(checkSignedIn).not.toHaveBeenCalled();
	});
});
