/**
 * Identicon must be:
 *   - deterministic per seed (same seed → byte-identical SVG)
 *   - distinct for different seeds (overwhelmingly likely; not a hash guarantee)
 *   - symmetric on the vertical axis (the user-visible point of the design)
 */
import { describe, it, expect } from "vitest";
import { identiconSvg } from "../src/lib/identicon";

describe("identiconSvg", () => {
	it("is deterministic for the same seed", () => {
		expect(identiconSvg("abc")).toBe(identiconSvg("abc"));
	});

	it("differs across seeds", () => {
		const a = identiconSvg("01JEXAMPLEAAAAAAAAAAAAAAAA");
		const b = identiconSvg("01JEXAMPLEBBBBBBBBBBBBBBBB");
		expect(a).not.toBe(b);
	});

	it("emits a self-contained <svg> with no external refs", () => {
		const svg = identiconSvg("seed");
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg.endsWith("</svg>")).toBe(true);
		expect(svg).not.toMatch(/href=|src=|url\(/);
	});

	it("is vertically symmetric — col 0 mirrors col 4, col 1 mirrors col 3", () => {
		// Each visible cell is a <rect x="…" y="…">. Count rects at x=0 vs
		// x=4*cell — they should match (mirrors). Same for x=cell vs x=3*cell.
		const size = 50;
		const cell = size / 5;
		const svg = identiconSvg("symcheck", size);

		const countAtX = (x: number) =>
			(svg.match(new RegExp(`<rect x="${x}" `, "g")) || []).length;

		expect(countAtX(0)).toBe(countAtX(4 * cell));
		expect(countAtX(cell)).toBe(countAtX(3 * cell));
	});
});
