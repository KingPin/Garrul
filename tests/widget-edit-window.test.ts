/**
 * The edit-window countdown's arithmetic and wording (src/widget/edit-window.ts).
 *
 * `edit_window_minutes` has been enforced server-side since the setting existed,
 * but the reader got no signal at all that their window was closing — the Edit
 * button simply stopped working. What this module adds is the *display* side,
 * so the things worth pinning are the three boundaries a reader can actually
 * land on (an hour out, a minute out, and zero) and the two inputs that would
 * otherwise be implicit: the clock and the locale.
 *
 * Both are arguments, which is why this file needs no DOM and no fake timers —
 * the same reason `tests/widget-time.test.ts` doesn't. Labels assert against
 * real ICU output rather than a mocked `Intl`: a mock would pin our arithmetic
 * against itself and pass even if the unit handed to `NumberFormat` were wrong.
 */
import { describe, expect, it } from "vitest";
import { WIDGET_TABLES } from "../src/i18n/widget";
import {
	COUNTDOWN_WINDOW_MS,
	type EditWindowState,
	countdownStartsIn,
	editWindowLabel,
	editWindowState,
} from "../src/widget/edit-window";
import { makeS } from "../src/widget/strings";

const MIN = 60_000;
const NOW = Date.UTC(2026, 7, 12, 14, 33, 0);

/** A comment whose window has `left` milliseconds still to run. */
const withLeft = (left: number, windowMs = 15 * MIN): EditWindowState =>
	editWindowState(NOW - (windowMs - left), windowMs, NOW);

const en = makeS().s;
/**
 * The translator the widget would have for `locale`, real table and all — the
 * point of the locale case below is that the wording and the ICU-formatted unit
 * agree, which an English table with a German number would hide.
 */
const label = (state: EditWindowState, locale = "en"): string | null =>
	editWindowLabel(state, locale, makeS(WIDGET_TABLES[locale], locale).s);

describe("editWindowState", () => {
	it("stays quiet while the deadline is more than an hour out", () => {
		// The window can be set to a week. A '6 days left' chip on every comment
		// is noise that trains a reader to ignore the one time it matters.
		expect(withLeft(6 * 24 * 60 * MIN, 7 * 24 * 60 * MIN)).toEqual({
			phase: "open",
		});
		expect(withLeft(COUNTDOWN_WINDOW_MS + 1, 2 * COUNTDOWN_WINDOW_MS)).toEqual({
			phase: "open",
		});
	});

	it("starts counting down exactly at the hour, not just under it", () => {
		expect(withLeft(COUNTDOWN_WINDOW_MS, 2 * COUNTDOWN_WINDOW_MS)).toEqual({
			phase: "closing",
			minutes: 60,
		});
	});

	it("counts the whole of a default 15-minute window", () => {
		// 15 minutes is under the threshold, so a default install shows the
		// countdown from the moment the comment is posted.
		expect(withLeft(15 * MIN)).toEqual({ phase: "closing", minutes: 15 });
		expect(withLeft(4 * MIN)).toEqual({ phase: "closing", minutes: 4 });
	});

	it("floors the minutes rather than rounding them", () => {
		// Understating a deadline is the safe direction: at 4m30s a reader told
		// '4m left' hurries, one told '5m left' may not.
		expect(withLeft(4 * MIN + 30_000)).toEqual({ phase: "closing", minutes: 4 });
		expect(withLeft(4 * MIN + 59_999)).toEqual({ phase: "closing", minutes: 4 });
	});

	it("crosses into the last minute exactly at 60s", () => {
		expect(withLeft(MIN)).toEqual({ phase: "closing", minutes: 1 });
		expect(withLeft(MIN - 1)).toEqual({ phase: "last" });
		expect(withLeft(1)).toEqual({ phase: "last" });
	});

	it("expires the instant the window runs out", () => {
		expect(withLeft(0)).toEqual({ phase: "expired" });
		expect(withLeft(-1)).toEqual({ phase: "expired" });
		expect(withLeft(-99 * MIN)).toEqual({ phase: "expired" });
	});

	it("treats a zero or negative window as editing switched off", () => {
		// `edit_window_minutes: 0` means no editing at all. Making the function
		// total here is what lets the caller drop its separate is-editing-on
		// branch: 'expired' already means 'show no Edit button'.
		expect(editWindowState(NOW, 0, NOW)).toEqual({ phase: "expired" });
		expect(editWindowState(NOW, -1, NOW)).toEqual({ phase: "expired" });
	});

	it("never claims more time than the window is long", () => {
		// A reader whose clock runs slow sees a `created_at` in their own future.
		// Clamping to the window keeps the chip from promising 20 minutes of a
		// 15-minute window; the underlying skew is the server's to judge, and it
		// mis-gated the Edit button this same way long before the chip existed.
		expect(editWindowState(NOW + 5 * MIN, 15 * MIN, NOW)).toEqual({
			phase: "closing",
			minutes: 15,
		});
	});
});

describe("countdownStartsIn", () => {
	/** ms until `left`-of-`windowMs` has the countdown anything to say. */
	const startsIn = (left: number, windowMs = 15 * MIN): number =>
		countdownStartsIn(NOW - (windowMs - left), windowMs, NOW);

	it("waits out the whole of a long window before ticking", () => {
		// The reason this function exists: without it the shared 15-second ticker
		// starts at mount and re-reads the clock for six days to keep concluding
		// that the phase is still 'open'.
		expect(startsIn(6 * 24 * 60 * MIN, 7 * 24 * 60 * MIN)).toBe(
			6 * 24 * 60 * MIN - COUNTDOWN_WINDOW_MS,
		);
	});

	it("starts immediately once the threshold is reached or passed", () => {
		expect(startsIn(COUNTDOWN_WINDOW_MS, 2 * COUNTDOWN_WINDOW_MS)).toBe(0);
		expect(startsIn(1 * MIN)).toBe(0);
		// Never negative: a caller that hands this to setTimeout as a delay would
		// otherwise be relying on the browser to clamp it for them.
		expect(startsIn(-5 * MIN)).toBe(0);
	});

	it("hands back a delay that agrees with the phase it is waiting for", () => {
		// The two functions read the same clock, so the boundary has to be the
		// same one: a delay of 0 must mean the phase is no longer 'open', and a
		// positive delay must mean it still is.
		for (const left of [
			COUNTDOWN_WINDOW_MS - 1,
			COUNTDOWN_WINDOW_MS,
			COUNTDOWN_WINDOW_MS + 1,
		]) {
			const window = 2 * COUNTDOWN_WINDOW_MS;
			const open = withLeft(left, window).phase === "open";
			expect(startsIn(left, window) > 0).toBe(open);
		}
	});

	it("does not defer when editing is switched off", () => {
		// `expired` is the phase either way, so the tick has to run and strip the
		// affordance rather than sit on a timeout that never comes.
		expect(countdownStartsIn(NOW, 0, NOW)).toBe(0);
		expect(countdownStartsIn(NOW, -1, NOW)).toBe(0);
	});

	it("clamps a slow reader's clock the same way the phase does", () => {
		// A `created_at` in the reader's own future must not push the first tick
		// past the end of the window it is counting.
		expect(countdownStartsIn(NOW + 5 * MIN, 15 * MIN, NOW)).toBe(0);
		expect(
			countdownStartsIn(NOW + 60 * MIN, 2 * COUNTDOWN_WINDOW_MS, NOW),
		).toBe(COUNTDOWN_WINDOW_MS);
	});
});

describe("editWindowLabel", () => {
	it("says nothing when there is nothing to say", () => {
		expect(label({ phase: "open" })).toBeNull();
		expect(label({ phase: "expired" })).toBeNull();
	});

	it("renders minutes with the compact unit ICU already knows", () => {
		expect(label({ phase: "closing", minutes: 4 })).toBe("4m left");
		expect(label({ phase: "closing", minutes: 1 })).toBe("1m left");
		expect(label({ phase: "closing", minutes: 60 })).toBe("60m left");
	});

	it("spells out the last minute instead of counting seconds", () => {
		expect(label({ phase: "last" })).toBe("less than a minute left");
	});

	it("formats in the site's locale, unit and wording together", () => {
		// The number and its unit come from ICU, so `de` gets 'Min.' without a
		// fourth translation to review; only the surrounding words are ours.
		expect(label({ phase: "closing", minutes: 4 }, "de")).toBe("noch 4 Min.");
		expect(label({ phase: "closing", minutes: 4 }, "fr")).toBe("4min restantes");
		expect(label({ phase: "closing", minutes: 4 }, "es")).toBe("quedan 4min");
		expect(label({ phase: "last" }, "de")).toBe("weniger als eine Minute übrig");
	});

	it("agrees the verb with the count where the language needs it", () => {
		// `es` and `fr` inflect on the number of minutes; `en` and `de` don't, so
		// the plural forms exist only where they earn their place.
		expect(label({ phase: "closing", minutes: 1 }, "es")).toBe("queda 1min");
		expect(label({ phase: "closing", minutes: 1 }, "fr")).toBe("1min restante");
	});

	it("degrades to a bare figure rather than throwing on a bad tag", () => {
		// A malformed locale makes the NumberFormat constructor throw, and a chip
		// that renders slightly wrong beats one that takes the row down with it.
		expect(editWindowLabel({ phase: "closing", minutes: 4 }, "!!", en)).toBe(
			"4m left",
		);
	});
});
