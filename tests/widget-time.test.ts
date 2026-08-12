/**
 * Widget timestamp formatting (src/widget/time.ts).
 *
 * The widget rendered UTC to every reader on earth for its whole life, so the
 * thing worth pinning is not "does Intl work" — it is the bucket boundaries and
 * the two inputs that used to be implicit: the clock and the locale. Both are
 * arguments now, which is the only reason this file needs no DOM and no fake
 * timers.
 *
 * These assert against real ICU output. That is deliberate: a mocked Intl would
 * pin our own arithmetic against itself and pass even if the unit handed to
 * `format` were wrong.
 */
import { describe, it, expect } from "vitest";
import { relativeTime, absoluteTime, isoTime } from "../src/widget/time";

const NOW = Date.UTC(2026, 7, 12, 14, 33, 0);
const ago = (ms: number) => relativeTime(NOW - ms, NOW, "en");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
	it("says 'now' for anything under a minute", () => {
		expect(ago(0)).toBe("now");
		expect(ago(59 * SEC)).toBe("now");
	});

	it("crosses into minutes exactly at 60s, not at 59", () => {
		expect(ago(60 * SEC)).toBe("1 minute ago");
		expect(ago(90 * SEC)).toBe("1 minute ago");
		expect(ago(59 * MIN)).toBe("59 minutes ago");
	});

	it("walks up the units", () => {
		expect(ago(2 * HOUR)).toBe("2 hours ago");
		expect(ago(23 * HOUR)).toBe("23 hours ago");
		expect(ago(3 * DAY)).toBe("3 days ago");
		expect(ago(20 * DAY)).toBe("2 weeks ago");
		expect(ago(200 * DAY)).toBe("6 months ago");
		expect(ago(800 * DAY)).toBe("2 years ago");
	});

	it("uses the words ICU has for one-unit-ago", () => {
		// numeric:"auto" is what buys these; "1 day ago" would be numeric:"always".
		expect(ago(DAY)).toBe("yesterday");
		expect(ago(31 * DAY)).toBe("last month");
		expect(ago(400 * DAY)).toBe("last year");
	});

	it("clamps a future timestamp instead of saying 'in 3 seconds'", () => {
		// Clock skew between a reader's machine and the Worker, not a scheduled
		// comment — nothing in Garrul can post ahead of time.
		expect(relativeTime(NOW + 3 * SEC, NOW, "en")).toBe("now");
		expect(relativeTime(NOW + 5 * DAY, NOW, "en")).toBe("now");
	});

	it("formats in the site's locale, not English", () => {
		expect(relativeTime(NOW - 2 * HOUR, NOW, "de")).toBe("vor 2 Stunden");
		expect(relativeTime(NOW - 3 * DAY, NOW, "fr")).toBe("il y a 3 jours");
	});

	it("degrades to the old ISO format on a locale Intl rejects", () => {
		// A thread that renders a slightly worse timestamp beats one that throws
		// mid-DOM-build. "en_US" (underscore) is a real-world malformed tag.
		expect(relativeTime(NOW - 2 * HOUR, NOW, "en_US")).toBe("2026-08-12 12:33");
	});
});

describe("isoTime", () => {
	it("keeps the exact value for the datetime attribute", () => {
		expect(isoTime(NOW)).toBe("2026-08-12T14:33:00.000Z");
	});
});

describe("absoluteTime", () => {
	it("renders a full local date and time for the tooltip", () => {
		// Not asserting the zone-shifted wall clock: that depends on the runner's
		// TZ. What must hold is that it is a real formatted date, not ISO.
		const out = absoluteTime(NOW, "en");
		expect(out).toMatch(/Aug \d{1,2}, 2026/);
		expect(out).not.toContain("T");
	});

	it("degrades to ISO on a locale Intl rejects", () => {
		expect(absoluteTime(NOW, "en_US")).toBe("2026-08-12 14:33");
	});
});
