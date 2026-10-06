/**
 * The multi-release notes section `npm run upgrade` prints: which releases an
 * upgrade spans, and the caps that keep a long span from scrolling the drift
 * plan out of the terminal before `confirm("Proceed?")`.
 */
import { describe, it, expect } from "vitest";
import {
	headline,
	releaseNotesSection,
	releasesInRange,
	type Release,
} from "../scripts/upgrade/release-notes";

const ESC = String.fromCharCode(0x1b);
const COMPARE = "https://github.com/o/r/compare/v2.16.0...v2.40.0";
const RELEASES = "https://github.com/o/r/releases";

const rel = (minor: number, notes: string | null = "## Highlights\n- a\n- b"): Release => ({
	tag: `v2.${minor}.0`,
	title: `v2.${minor}.0 — change ${minor}`,
	url: `https://github.com/o/r/releases/tag/v2.${minor}.0`,
	notes,
});

describe("releasesInRange", () => {
	it("keeps (installed, target], newest first", () => {
		const all = [rel(30), rel(34), rel(31), rel(32), rel(35), rel(33)];
		expect(releasesInRange(all, "2.31.0", "v2.34.0").map((r) => r.tag)).toEqual([
			"v2.34.0",
			"v2.33.0",
			"v2.32.0",
		]);
	});

	it("drops tags that aren't semver", () => {
		const odd = { ...rel(32), tag: "nightly" };
		expect(releasesInRange([odd, rel(33)], "2.31.0", "2.33.0")).toHaveLength(1);
	});
});

describe("headline", () => {
	it("uses the release title", () => {
		expect(headline(rel(34))).toBe("v2.34.0 — change 34");
	});

	it("falls back to the first non-heading body line for a bare-tag title", () => {
		const r = {
			...rel(4, "## Highlights\n\n- **Reply boxes are themed again.** More."),
			title: "v2.4.0",
		};
		expect(headline(r)).toBe("v2.4.0 — Reply boxes are themed again. More.");
	});

	it("is the bare tag when there is nothing to summarize", () => {
		expect(headline({ ...rel(4, null), title: null })).toBe("v2.4.0");
	});

	it("strips escapes and clamps length", () => {
		const r = { ...rel(4), title: `${ESC}[2Kv2.4.0 — ${"x".repeat(500)}` };
		const h = headline(r);
		expect(h).not.toContain(ESC);
		expect(h.length).toBe(161);
	});
});

describe("releaseNotesSection", () => {
	it("prints the newest three bodies in full and titles for the rest", () => {
		const out = releaseNotesSection(
			releasesInRange([rel(31), rel(32), rel(33), rel(34)], "2.30.0", "2.34.0"),
			COMPARE,
			RELEASES,
		).join("\n");
		expect(out).toContain(`Compare: ${COMPARE}`);
		for (const m of [34, 33, 32]) expect(out).toContain(`change ${m}\n  https://`);
		expect(out).toContain("Earlier releases in this upgrade:\n    v2.31.0 — change 31");
		expect(out.match(/- a/g)).toHaveLength(3);
	});

	it("lists at most 20 titles and points at the releases page for the rest", () => {
		const all = Array.from({ length: 24 }, (_, i) => rel(17 + i));
		const lines = releaseNotesSection(releasesInRange(all, "2.16.0", "2.40.0"), COMPARE, RELEASES);
		expect(lines.filter((l) => /^ {4}v2\.\d+\.0 — change/.test(l))).toHaveLength(20);
		expect(lines).toContain(`    … 1 earlier release(s) — see ${RELEASES}`);
	});

	it("caps the whole section even when bodies are huge", () => {
		const flood = Array.from({ length: 200 }, () => "flood").join("\n");
		const lines = releaseNotesSection([rel(34, flood), rel(33, flood)], COMPARE, RELEASES);
		expect(lines).toHaveLength(102);
		expect(lines.at(-1)).toMatch(/more line\(s\) not shown — read the full notes at/);
		expect(lines.at(-1)?.endsWith(RELEASES)).toBe(true);
	});

	it("shows a single release without a compare line", () => {
		const out = releaseNotesSection([rel(34)], COMPARE, RELEASES).join("\n");
		expect(out).not.toContain("Compare:");
		expect(out).toContain("- a");
	});

	it("says so when the range has no published release", () => {
		expect(releaseNotesSection([], COMPARE, RELEASES)).toEqual([
			"  (no GitHub release published for this range)",
		]);
	});

	it("marks a release with an empty body", () => {
		expect(releaseNotesSection([rel(34, null)], COMPARE, RELEASES)).toContain(
			"  (release has no description)",
		);
	});
});
