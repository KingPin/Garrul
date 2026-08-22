/**
 * How much of the edit window is left, and how to say it.
 *
 * `edit_window_minutes` has been enforced server-side for as long as the setting
 * has existed, but nothing ever told the reader about it. The Edit button was
 * rendered once from `Date.now() - created_at < editWindowMs` and then never
 * re-evaluated, so an author who left the page open came back to a button that
 * looked live, opened an editor that prefilled fine, and got a silent 403 on
 * Save. This module is the display half of that setting: what to show, when to
 * start showing it, and when to stop offering the affordance at all.
 *
 * Two deliberate choices live here rather than in the caller:
 *
 *   - **Nothing is shown until the last hour.** The window is configurable up to
 *     a week, and a "6 days left" chip on every one of your own comments is
 *     noise that teaches a reader to ignore the one time it matters. On the
 *     default 15-minute window the threshold never bites, so the common install
 *     shows the countdown for the whole window.
 *   - **`expired` also covers editing being switched off.** `edit_window_minutes:
 *     0` means no editing, and folding it in here keeps the caller down to one
 *     question ("is this phase `expired`?") instead of two.
 *
 * Everything is pure and takes `now` and `locale` as arguments — the same reason
 * `time.ts` does, and the reason both are testable with no DOM and no fake
 * timers. The clock is the *reader's*, compared against a server timestamp: a
 * skewed clock therefore mis-states the remaining time, exactly as it has always
 * mis-gated the Edit button. Correcting it needs a server `now` on the wire,
 * which the bootstrap payload's byte-identical-sections rule makes a bigger
 * change than this one; the chip surfaces the skew rather than introducing it.
 */
import type { Translate } from "./strings";

/**
 * Only start counting down inside the last hour. Not a user-facing setting:
 * it is a display threshold, and one more knob for operators to get wrong.
 */
export const COUNTDOWN_WINDOW_MS = 60 * 60_000;

/**
 * How often the shared ticker re-reads the clock. Coarse on purpose — the labels
 * are minute-grained, so a faster tick would repaint identical text, and a
 * per-second clock beside your own words is a nagging surface.
 */
export const TICK_MS = 15_000;

const MINUTE_MS = 60_000;

export type EditWindowState =
	/** Editable, but far enough out that saying so would be noise. */
	| { phase: "open" }
	/** Editable, inside the countdown threshold. `minutes` is at least 1. */
	| { phase: "closing"; minutes: number }
	/** Editable, under a minute left. */
	| { phase: "last" }
	/** Not editable: the window has run out, or editing is switched off. */
	| { phase: "expired" };

export const editWindowState = (
	createdAt: number,
	windowMs: number,
	now: number,
): EditWindowState => {
	if (windowMs <= 0) return { phase: "expired" };
	// Clamping to the window matters for a reader whose clock runs slow: they
	// see a `created_at` in their own future, and without this the chip would
	// promise twenty minutes of a fifteen-minute window.
	const remaining = Math.min(windowMs, createdAt + windowMs - now);
	if (remaining <= 0) return { phase: "expired" };
	if (remaining > COUNTDOWN_WINDOW_MS) return { phase: "open" };
	if (remaining < MINUTE_MS) return { phase: "last" };
	// Floor, not round. At 4m30s "4m left" makes a reader hurry and "5m left"
	// may not; understating a deadline is the safe direction to be wrong in.
	return { phase: "closing", minutes: Math.floor(remaining / MINUTE_MS) };
};

/**
 * The number and its unit together, in the site's locale — "4m", "4 Min.",
 * "4min". Free from ICU, so the string table only has to carry the words around
 * it. A malformed locale tag makes the constructor throw, and a chip that reads
 * slightly wrong beats one that takes the actions row down with it.
 */
const minutesUnit = (n: number, locale: string): string => {
	try {
		return new Intl.NumberFormat(locale, {
			style: "unit",
			unit: "minute",
			unitDisplay: "narrow",
		}).format(n);
	} catch {
		return `${n}m`;
	}
};

/** The chip's text, or `null` when there is nothing worth saying. */
export const editWindowLabel = (
	state: EditWindowState,
	locale: string,
	s: Translate,
): string | null => {
	if (state.phase === "closing") {
		// `n` as well as `time`: French and Spanish inflect the wording on the
		// count, and `n` is what selects the plural category.
		return s("w.edit_left", {
			n: state.minutes,
			time: minutesUnit(state.minutes, locale),
		});
	}
	if (state.phase === "last") return s("w.edit_last_minute");
	return null;
};
