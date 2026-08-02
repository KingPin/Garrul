/**
 * Terminal-safety for the free text `npm run upgrade` prints.
 *
 * Everything here exists for one window: `printReleaseNotes` and `printPlan`
 * both run *before* `applyPlan` cross-checks the fetched manifest against the
 * git tag, and before `confirm("Proceed?")`. At the moment the operator reads
 * that output and decides whether to type "yes", every byte of it is nothing
 * but a network response. A carriage return or a CSI cursor-movement sequence
 * is enough to overwrite a real "Breaking changes — manual steps required"
 * line with a fake "nothing to do" one, and the operator then approves a deploy
 * against text that was never on screen.
 *
 * Two shapes, because the two callers differ:
 *   - manifest free text (descriptions, breaking-change summaries and steps) is
 *     single-line by construction, so `plainText` strips newlines along with
 *     everything else;
 *   - release notes are prose from a GitHub release body and legitimately
 *     multi-line, so `releaseNotesLines` splits first and cleans each line.
 *
 * Deliberately NOT folded into manifest.ts's `requireString`/`optionalString`:
 * `requireMatch` and `optionalSemver` build on those, and silently cleaning
 * their input would turn a value that should be *rejected* into one that passes
 * the pattern.
 */

/**
 * C0, DEL and C1 — code points below 0x20, plus 0x7F through 0x9F. That covers
 * ESC (0x1B, and so every ANSI escape sequence), the 8-bit CSI (0x9B), CR and
 * LF. Nothing legitimate in operator-facing prose needs a control character.
 *
 * An explicit range test rather than a regex character class, because a class
 * spelled with backslash-u escapes is one careless edit away from holding the
 * literal control characters instead of the escapes — which still compiles,
 * still passes a casual read, and is invisible in a diff.
 */
const isControl = (cp: number): boolean =>
	cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

/** Strip every control character. For text that must stay on one line. */
export const plainText = (s: string): string =>
	Array.from(s, (ch) => (isControl(ch.codePointAt(0) ?? 0) ? "" : ch)).join("");

/**
 * Caps on the release body, which is the largest attacker-controlled blob the
 * upgrade prints and the first thing on screen. Stripping escapes stops a line
 * being *overwritten*; it does nothing about 10,000 blank lines scrolling the
 * breaking-changes block out of the terminal before the operator reaches the
 * prompt. Truncation is announced, so a real release that trips the cap reads
 * as truncated rather than as complete.
 */
const MAX_LINES = 200;
const MAX_LINE_LEN = 500;

/**
 * A GitHub release body as terminal-safe lines.
 *
 * Splits on CRLF, LF *and* a lone CR: treating a bare carriage return as a line
 * break rather than stripping it neutralizes the overwrite without silently
 * welding two lines of prose together.
 */
export const releaseNotesLines = (
	notes: string,
): { lines: string[]; truncated: number } => {
	const all = notes.split(/\r\n|\n|\r/).map((line) => {
		const clean = plainText(line);
		return clean.length > MAX_LINE_LEN
			? `${clean.slice(0, MAX_LINE_LEN)}…`
			: clean;
	});
	return {
		lines: all.slice(0, MAX_LINES),
		truncated: Math.max(0, all.length - MAX_LINES),
	};
};
