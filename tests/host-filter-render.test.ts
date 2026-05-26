/**
 * Render tests for the shared domain-filter dropdown.
 *
 * Catches HTML-escape regressions and selection-state bugs. Adversarial
 * host values are included because the dropdown renders text derived
 * from `posts.url`, which is untrusted input the embed installer
 * controls.
 */
import { describe, it, expect } from "vitest";
import { renderHostFilter } from "../src/admin-ui/components/host-filter";

describe("renderHostFilter", () => {
	it("always includes an 'all domains' default option", () => {
		const html = renderHostFilter({ hosts: [], selected: "" });
		expect(html).toContain('<option value="" selected>all domains</option>');
	});

	it("renders one option per host", () => {
		const html = renderHostFilter({
			hosts: ["blog.example.com", "shop.example.com"],
			selected: "",
		});
		expect(html).toContain('value="blog.example.com"');
		expect(html).toContain('value="shop.example.com"');
	});

	it("marks the matching option as selected", () => {
		const html = renderHostFilter({
			hosts: ["a.com", "b.com"],
			selected: "b.com",
		});
		expect(html).toContain('<option value="b.com" selected>b.com</option>');
		expect(html).toContain('<option value="a.com">a.com</option>');
		expect(html).not.toContain('<option value="" selected>');
	});

	it("escapes hostile host strings in both value and label", () => {
		const evil = `'"><script>alert(1)</script>`;
		const html = renderHostFilter({ hosts: [evil], selected: "" });
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&quot;");
		expect(html).toContain("&#39;");
	});

	it("renders the NO_URL_BUCKET sentinel as a normal option", () => {
		const html = renderHostFilter({
			hosts: ["(no url)", "example.com"],
			selected: "(no url)",
		});
		// Parentheses are not HTML-special, so they render literally.
		expect(html).toContain('value="(no url)" selected>(no url)</option>');
	});
});
