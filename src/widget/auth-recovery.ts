/**
 * Recovers a popup sign-in whose `garrul:auth` postMessage never arrived.
 *
 * The normal handoff is: the OAuth callback page posts `garrul:auth` to
 * `window.opener`, the widget exchanges the handoff token, then reloads. That
 * depends on the popup still having an opener — and a host page serving
 * `Cross-Origin-Opener-Policy: same-origin` breaks exactly that. COOP puts a
 * cross-origin popup in its own browsing context group, so `window.opener` is
 * null over there and the message is never sent (issue #58).
 *
 * The failure is silent in all three directions: the popup still prints
 * "Signed in. You can close this window.", `window.open()` still returns a
 * non-null WindowProxy (so the popup-blocked fallback doesn't fire either), and
 * nothing lands in the console. The reader is left staring at a signed-out
 * widget that a manual reload would fix.
 *
 * So don't treat postMessage as the only channel. COOP severs the opener, but
 * it does not stop the popup's own `Set-Cookie` from landing in this page's
 * cookie partition on a same-site embed — re-checking `/auth/me` is enough to
 * notice. `src/routes/auth.ts` has claimed this fallback existed since the
 * static-callback branch was written; this is it.
 *
 * Two triggers, deliberately:
 *
 *   1. `popupClosed` polling — the primary. COOP nulls the popup's `opener`,
 *      but the *opener's* handle to the popup keeps reporting `closed`
 *      correctly, so this fires even when nothing else does. Measured against
 *      chromium with all three COOP values; see the probe note below.
 *   2. `focus` / `visibilitychange` — the backstop, for the cases the handle
 *      can't cover: a popup the reader leaves open and returns from, and mobile
 *      browsers that open a tab and may not report it closed.
 *
 * Trigger 1 is load-bearing precisely because trigger 2 is hard to prove. "The
 * opener fires `focus` when the popup closes" is conventional wisdom that
 * headless *and* headed automation refuse to reproduce (CDP never delivers the
 * activation change), so it is carried here as a belt, not as the braces.
 *
 * Scope: this recovers **same-site** embeds (host and Worker sharing an
 * eTLD+1), where the popup's cookie is in the same CHIPS partition. On a
 * genuinely cross-site embed under COOP that cookie is partitioned away and the
 * handoff token is the only way in, so `/auth/me` stays null — those hosts need
 * `Cross-Origin-Opener-Policy: same-origin-allow-popups`. See
 * docs/troubleshooting.md.
 */

/** The slice of `window`/`document` this module touches. */
interface EventTargetLike {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

interface DocumentLike extends EventTargetLike {
	readonly visibilityState: string;
}

export interface AuthRecoveryOptions {
	/** Resolves true once this browsing context holds a signed-in session. */
	checkSignedIn: () => Promise<boolean>;
	/** Called exactly once, the first time a session is observed. */
	onSignedIn: () => void;
	win: EventTargetLike;
	doc: DocumentLike;
	/**
	 * The opener's handle on the sign-in popup, as `() => popup.closed`. Omit
	 * when there is no handle (popup blocked) and only the event triggers arm.
	 */
	popupClosed?: () => boolean;
	/** Injectable clock so tests don't have to wait out the window. */
	now?: () => number;
	windowMs?: number;
	pollMs?: number;
}

/**
 * How long to keep watching after the popup opens. Matches the OAuth state TTL
 * in src/lib/oauth.ts: once the flow's state can no longer be redeemed, a
 * session can no longer show up as a result of *this* attempt, and any later
 * focus is unrelated browsing.
 */
export const OAUTH_RECOVERY_WINDOW_MS = 10 * 60_000;

/**
 * How often to ask whether the popup has closed. Fast enough that the widget
 * updates while the reader is still looking at where the popup was, slow enough
 * to be free — this is a property read, not a network call.
 */
export const OAUTH_POLL_MS = 350;

/**
 * Watch for a session appearing after a popup sign-in. Returns a teardown the
 * caller invokes when the postMessage path wins the race instead.
 */
export const watchForSignIn = ({
	checkSignedIn,
	onSignedIn,
	win,
	doc,
	popupClosed,
	now = () => Date.now(),
	windowMs = OAUTH_RECOVERY_WINDOW_MS,
	pollMs = OAUTH_POLL_MS,
}: AuthRecoveryOptions): (() => void) => {
	const deadline = now() + windowMs;
	let done = false;
	let inFlight = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stop = (): void => {
		if (done) return;
		done = true;
		if (timer !== undefined) clearInterval(timer);
		win.removeEventListener("focus", check);
		doc.removeEventListener("visibilitychange", check);
	};

	/**
	 * Returns whether a check actually started — the poll needs to know, so a
	 * tick that collided with an in-flight check doesn't count as its one shot.
	 */
	const attempt = (opts: { whilePopupGone?: boolean }): boolean => {
		// `focus` and `visibilitychange` routinely arrive back-to-back for one
		// return trip; one /auth/me per trip is plenty.
		if (done || inFlight) return false;
		if (now() > deadline) {
			stop();
			return false;
		}
		// A focus event that lands while the page is still hidden isn't the
		// reader coming back from the popup — wait for the visible one. Doesn't
		// apply once the popup is gone: on mobile the opener can still be the
		// background tab at that moment, and the answer is already knowable.
		if (!opts.whilePopupGone && doc.visibilityState !== "visible") return false;
		inFlight = true;
		void checkSignedIn()
			.then((signedIn) => {
				if (done) return;
				if (signedIn) {
					stop();
					onSignedIn();
					return;
				}
				// Popup gone and still no session: the reader cancelled at the
				// provider, or this is a cross-site embed whose cookie we can
				// never read. Either way nothing more is coming — don't idle.
				if (opts.whilePopupGone) stop();
			})
			// A failed check is not a signed-out verdict — the network may just
			// be down mid-return. Stay armed for the next trigger.
			.catch(() => {})
			.finally(() => {
				inFlight = false;
			});
		return true;
	};

	const check = (): void => {
		attempt({});
	};

	win.addEventListener("focus", check);
	doc.addEventListener("visibilitychange", check);

	if (popupClosed) {
		timer = setInterval(() => {
			if (done) return;
			if (now() > deadline) {
				stop();
				return;
			}
			// A severed-opener handle can throw on property access in some
			// engines; treat that as "can't tell yet" and let the events cover.
			let gone = false;
			try {
				gone = popupClosed();
			} catch {
				return;
			}
			if (!gone) return;
			// The popup's Set-Cookie landed before the page it rendered, so by
			// the time it reports closed the jar is already settled.
			if (attempt({ whilePopupGone: true }) && timer !== undefined) {
				clearInterval(timer);
				timer = undefined;
			}
		}, pollMs);
	}

	return stop;
};
