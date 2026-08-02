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
 * cookie partition on a same-site embed — re-checking `/auth/me` when the
 * reader comes back is enough to notice. `src/routes/auth.ts` has claimed this
 * fallback existed since the static-callback branch was written; this is it.
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
	/** Injectable clock so tests don't have to wait out the window. */
	now?: () => number;
	windowMs?: number;
}

/**
 * How long to keep watching after the popup opens. Matches the OAuth state TTL
 * in src/lib/oauth.ts: once the flow's state can no longer be redeemed, a
 * session can no longer show up as a result of *this* attempt, and any later
 * focus is unrelated browsing.
 */
export const OAUTH_RECOVERY_WINDOW_MS = 10 * 60_000;

/**
 * Watch for a session appearing after a popup sign-in. Returns a teardown the
 * caller invokes when the postMessage path wins the race instead.
 */
export const watchForSignIn = ({
	checkSignedIn,
	onSignedIn,
	win,
	doc,
	now = () => Date.now(),
	windowMs = OAUTH_RECOVERY_WINDOW_MS,
}: AuthRecoveryOptions): (() => void) => {
	const deadline = now() + windowMs;
	let done = false;
	let inFlight = false;

	const stop = (): void => {
		if (done) return;
		done = true;
		win.removeEventListener("focus", check);
		doc.removeEventListener("visibilitychange", check);
	};

	const check = (): void => {
		// `focus` and `visibilitychange` routinely arrive back-to-back for one
		// return trip; one /auth/me per trip is plenty.
		if (done || inFlight) return;
		if (now() > deadline) {
			stop();
			return;
		}
		// A focus event that lands while the page is still hidden isn't the
		// reader coming back from the popup — wait for the visible one.
		if (doc.visibilityState === "hidden") return;
		inFlight = true;
		void checkSignedIn()
			.then((signedIn) => {
				if (done || !signedIn) return;
				stop();
				onSignedIn();
			})
			// A failed check is not a signed-out verdict — the network may just
			// be down mid-return. Stay armed for the next focus.
			.catch(() => {})
			.finally(() => {
				inFlight = false;
			});
	};

	win.addEventListener("focus", check);
	doc.addEventListener("visibilitychange", check);
	return stop;
};
