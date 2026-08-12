/**
 * Reader-facing time formatting.
 *
 * The widget used to render `new Date(ts).toISOString()` sliced to minutes:
 * `2026-08-12 14:33`, in UTC, for every reader on earth, with no timezone
 * label. A reader in Berlin looking at a comment posted a minute ago saw a
 * time two hours in their past. CLAUDE.md's "timestamps stay ISO" rule still
 * holds everywhere it was meant to — the API, feeds, email, the `datetime`
 * attribute below — but this one surface was simply wrong.
 *
 * Everything here is pure and takes `now` and `locale` as arguments rather
 * than reading the clock or the module-level locale, so the buckets can be
 * unit-tested without a DOM or a fake timer.
 *
 * `locale` is the **site's** resolved locale, not `navigator.language`: same
 * rule as every other string in the widget (src/i18n/negotiate.ts — a German
 * reader on an English blog gets an English widget). The *timezone* is the
 * reader's, because that one is not a property of the site: it is where they
 * are standing.
 *
 * Labels are computed at render time and do not tick. A page left open for an
 * hour keeps saying "2 minutes ago" until something re-renders the tree, which
 * most interactions do. A timer was considered and left out: it costs bytes and
 * a teardown path on every comment, and the exact time is one hover away in
 * `title` — which is more than the old format offered.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Average lengths, not 30 and 365. A flat 30-day month drifts far enough over
// a year that a comment eleven and a half months old rounds to "11 months ago"
// on one day and "last year" on the next.
const MONTH = DAY * 30.44;
const YEAR = DAY * 365.25;

/** Largest unit first: the first one the elapsed time reaches is the one used. */
const UNITS: [ms: number, unit: Intl.RelativeTimeFormatUnit][] = [
	[YEAR, "year"],
	[MONTH, "month"],
	[WEEK, "week"],
	[DAY, "day"],
	[HOUR, "hour"],
	[MINUTE, "minute"],
];

/**
 * The pre-2.9 format, kept as the degradation path rather than deleted. Every
 * browser Garrul supports has `Intl.RelativeTimeFormat`, but a malformed
 * locale tag makes the constructor throw, and a thread that renders slightly
 * wrong timestamps beats one that throws while building the DOM.
 */
const isoMinutes = (ts: number): string =>
	new Date(ts).toISOString().replace("T", " ").slice(0, 16);

/** Machine-readable exact time for the `datetime` attribute. Always ISO. */
export const isoTime = (ts: number): string => new Date(ts).toISOString();

/**
 * "2 hours ago", "yesterday", "last month" — localized by `Intl`, so no new
 * entries in the widget string table and no fifth translation to review.
 */
export const relativeTime = (
	ts: number,
	now: number,
	locale: string,
): string => {
	// A future timestamp means a skewed clock somewhere, not a scheduled
	// comment: nothing in Garrul can post ahead of time. Clamp to zero rather
	// than render "in 3 seconds", which reads as a bug in the widget.
	const elapsed = Math.max(0, now - ts);
	try {
		const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
		for (const [ms, unit] of UNITS) {
			if (elapsed >= ms) return rtf.format(-Math.floor(elapsed / ms), unit);
		}
		// Under a minute. `format(0, "second")` under numeric:"auto" is what
		// yields "now" / "jetzt" / "ahora"; a hand-written "just now" would be a
		// string to translate in four files for something Intl already knows.
		return rtf.format(0, "second");
	} catch {
		return isoMinutes(ts);
	}
};

/**
 * The exact local time, for the `title` tooltip behind the relative label.
 * `dateStyle`/`timeStyle` cannot be combined with individual component options,
 * so this deliberately carries no timezone name — it is already the reader's
 * own timezone, and `datetime` holds the unambiguous value.
 */
export const absoluteTime = (ts: number, locale: string): string => {
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(ts);
	} catch {
		return isoMinutes(ts);
	}
};
