/**
 * Render/security tests for the shared admin control + chart helpers.
 *
 * renderTabs interpolates `stateVar` and each tab `id` raw into Alpine
 * *expression* strings (:class / @click), where HTML-escaping is not enough
 * (the parser decodes entities before Alpine evaluates). The identifier
 * allowlist must therefore reject anything that isn't a plain identifier.
 *
 * barChartSvg renders `point.day`, which derives from stored data, into an
 * SVG <title>; it must be HTML-escaped, and the empty-data path must degrade
 * to a plain message rather than an empty/again broken SVG.
 */
import { describe, it, expect } from "vitest";
import { renderTabs } from "../src/admin-ui/controls";
import { barChartSvg, sparklineSvg } from "../src/admin-ui/charts";

describe("renderTabs", () => {
	it("renders a tab strip bound to the state var", () => {
		const html = renderTabs("tab", [
			{ id: "features", label: "Features" },
			{ id: "display", label: "Display" },
		]);
		expect(html).toContain('role="tablist"');
		expect(html).toContain("tab === 'features'");
		expect(html).toContain("tab = 'display'");
		expect(html).toContain(">Features</button>");
	});

	it("escapes the human-facing tab label", () => {
		const html = renderTabs("tab", [
			{ id: "x", label: `<script>alert(1)</script>` },
		]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("throws on a tab id that is not a plain identifier", () => {
		expect(() =>
			renderTabs("tab", [{ id: "x'); alert(1); //", label: "Evil" }]),
		).toThrow(/unsafe tab id/);
	});

	it("throws on a state var that is not a plain identifier", () => {
		expect(() =>
			renderTabs("tab'); alert(1); //", [{ id: "x", label: "X" }]),
		).toThrow(/unsafe stateVar/);
	});

	it("accepts dotted state-var paths but rejects spaces/quotes", () => {
		expect(() => renderTabs("settings.tab", [{ id: "a", label: "A" }])).not.toThrow();
		expect(() => renderTabs("a b", [{ id: "a", label: "A" }])).toThrow(
			/unsafe stateVar/,
		);
	});

	it("rejects malformed dotted paths (empty segments)", () => {
		for (const bad of ["a..b", "a.", ".a", "a.b.", ".", "a..b.c"]) {
			expect(() => renderTabs(bad, [{ id: "a", label: "A" }])).toThrow(
				/unsafe stateVar/,
			);
		}
	});
});

describe("barChartSvg", () => {
	it("renders one bar per point with an SVG chart", () => {
		const html = barChartSvg([
			{ day: "2026-01-01", count: 3 },
			{ day: "2026-01-02", count: 5 },
		]);
		expect(html).toContain("<svg");
		expect((html.match(/<rect /g) ?? []).length).toBe(2);
		expect(html).toContain("peak 5/day");
	});

	it("escapes hostile day strings in the bar <title>", () => {
		const html = barChartSvg([
			{ day: `"><script>alert(1)</script>`, count: 1 },
		]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});

	it("degrades to a plain message on empty data", () => {
		const html = barChartSvg([]);
		expect(html).not.toContain("<svg");
		expect(html).toContain("No activity in this range.");
	});
});

describe("sparklineSvg", () => {
	it("degrades to a plain message on empty data", () => {
		const html = sparklineSvg([]);
		expect(html).not.toContain("<svg");
		expect(html).toContain("No activity in this range.");
	});

	it("escapes hostile day strings in the caption", () => {
		const html = sparklineSvg([
			{ day: `"><script>alert(1)</script>`, count: 2 },
		]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
