/**
 * Terminal-injection defense for the release body `npm run upgrade` prints.
 *
 * `printReleaseNotes` runs immediately before `printPlan` and well before
 * `confirm("Proceed?")`, and the body it prints is a GitHub API response that
 * nothing has verified against the git tag yet. The manifest's own free-text
 * fields were hardened in f67a034; this covers the larger blob that prints
 * first, and which could therefore rewrite the plan's output after the fact.
 */
import { describe, it, expect } from "vitest";
import { plainText, releaseNotesLines } from "../scripts/upgrade/plain-text";

// Built from char codes so the test file itself stays free of literal control
// bytes — a source file full of raw escapes is unreadable in a diff, which is
// how a broken sanitizer stays broken.
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const CSI8 = String.fromCharCode(0x9b);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

describe("plainText", () => {
	it("strips C0, DEL and C1", () => {
		expect(plainText(`a${NUL}b${ESC}c${DEL}d${CSI8}e`)).toBe("abcde");
	});

	it("strips the ESC that starts every ANSI sequence", () => {
		// Without the ESC there is no escape sequence — the rest is inert text.
		expect(plainText(`safe${ESC}[2K${ESC}[1Aspoofed`)).toBe(
			"safe[2K[1Aspoofed",
		);
	});

	it("leaves ordinary prose and non-ASCII alone", () => {
		expect(plainText("Upgrade — see §3 for details… ✅")).toBe(
			"Upgrade — see §3 for details… ✅",
		);
	});
});

describe("releaseNotesLines", () => {
	it("keeps genuine line structure", () => {
		const { lines, truncated } = releaseNotesLines("one\ntwo\r\nthree");
		expect(lines).toEqual(["one", "two", "three"]);
		expect(truncated).toBe(0);
	});

	it("neutralizes a carriage-return overwrite", () => {
		// The attack: `\r` returns the cursor to column 0 so the text after it
		// paints over the text before it. The operator sees only the second half.
		const { lines } = releaseNotesLines(
			`No breaking changes.${CR}Safe to deploy!!`,
		);
		// Split into two lines, so both halves stay visible and neither can
		// overwrite the other.
		expect(lines).toEqual(["No breaking changes.", "Safe to deploy!!"]);
		// The load-bearing assertion: no line may still contain a bare CR.
		for (const line of lines) expect(line).not.toContain(CR);
	});

	it("strips cursor-movement sequences that would rewrite the plan", () => {
		// ESC[1A moves up a line, ESC[2K erases it: two of these and the
		// "Breaking changes" heading printed later is gone from the screen.
		const { lines } = releaseNotesLines(`${ESC}[1A${ESC}[2Kno manual steps`);
		expect(lines).toEqual(["[1A[2Kno manual steps"]);
		for (const line of lines) expect(line).not.toContain(ESC);
	});

	it("caps a body that would scroll the plan off screen", () => {
		const { lines, truncated } = releaseNotesLines(
			Array.from({ length: 5000 }, () => "flood").join("\n"),
		);
		expect(lines).toHaveLength(200);
		expect(truncated).toBe(4800);
	});

	it("caps a single absurdly long line", () => {
		const { lines } = releaseNotesLines("x".repeat(10_000));
		expect(lines).toHaveLength(1);
		// 500 kept plus the ellipsis marker.
		expect(lines[0]).toHaveLength(501);
		expect(lines[0]?.endsWith("…")).toBe(true);
	});
});
