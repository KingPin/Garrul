/**
 * Sanitizer critical-path tests. Tightly focused on what an attacker
 * would actually try: raw HTML, javascript: URLs, attribute injection,
 * length DoS. Regressions here are a security incident — keep this
 * suite lean and obvious.
 */
import { describe, it, expect } from "vitest";
import {
	CURRENT_RENDERER_VERSION,
	renderMarkdown,
	validateBody,
} from "../src/lib/markdown";

describe("renderMarkdown — output safety", () => {
	it("drops raw HTML tags", () => {
		const out = renderMarkdown("<script>alert(1)</script>");
		expect(out).not.toContain("<script");
	});

	it("drops <img> entirely", () => {
		const out = renderMarkdown("![x](https://evil/x.png)");
		expect(out).not.toContain("<img");
	});

	it("strips javascript: links (renders just the link text)", () => {
		const out = renderMarkdown("[click](javascript:alert(1))");
		expect(out).not.toMatch(/href="javascript:/i);
		expect(out).toContain("click");
	});

	it("strips data: links", () => {
		const out = renderMarkdown("[x](data:text/html,<script>)");
		expect(out).not.toMatch(/href="data:/i);
	});

	it("allows https: links with rel and target attrs", () => {
		const out = renderMarkdown("[hello](https://example.com)");
		expect(out).toContain('href="https://example.com"');
		expect(out).toContain('rel="nofollow ugc noopener"');
		expect(out).toContain('target="_blank"');
	});

	it("allows mailto: links", () => {
		const out = renderMarkdown("[mail](mailto:a@b.c)");
		expect(out).toContain('href="mailto:a@b.c"');
	});

	it("escapes link title attribute", () => {
		const out = renderMarkdown('[x](https://a.b "evil\\"onmouseover=alert(1)")');
		// Title with a quote must end up entity-escaped, not breaking the attr.
		expect(out).not.toMatch(/title="[^"]*"[^>]*onmouseover/);
	});

	it("demotes headings to <p><strong>", () => {
		const out = renderMarkdown("# Heading");
		expect(out).not.toMatch(/<h[1-6]/);
		expect(out).toMatch(/<p><strong>Heading<\/strong><\/p>/);
	});

	it("drops tables", () => {
		const out = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(out).not.toContain("<table");
		expect(out).not.toContain("<td");
	});

	it("converts horizontal rules to <br>", () => {
		const out = renderMarkdown("---");
		expect(out).toContain("<br>");
		expect(out).not.toContain("<hr");
	});

	it("renders inline emphasis and code", () => {
		const out = renderMarkdown("**bold** and `code`");
		expect(out).toContain("<strong>bold</strong>");
		expect(out).toContain("<code>code</code>");
	});

	it("truncates body past MAX_BODY_CHARS", () => {
		const long = "a".repeat(15_000);
		const out = renderMarkdown(long);
		// The output is sanitized + paragraph-wrapped, but it MUST be smaller
		// than the un-truncated input would be.
		expect(out.length).toBeLessThan(15_000);
	});

	it("renderer version is a positive integer", () => {
		expect(Number.isInteger(CURRENT_RENDERER_VERSION)).toBe(true);
		expect(CURRENT_RENDERER_VERSION).toBeGreaterThanOrEqual(1);
	});
});

describe("validateBody", () => {
	it("rejects empty body", () => {
		const v = validateBody("");
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.key).toBe("err.body.required");
	});

	it("rejects whitespace-only body", () => {
		const v = validateBody("   \n  \t ");
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.key).toBe("err.body.required");
	});

	it("rejects body over MAX_BODY_CHARS", () => {
		const v = validateBody("a".repeat(20_000));
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.key).toBe("err.body.too_long");
			expect(typeof v.max).toBe("number");
		}
	});

	it("accepts a normal body", () => {
		const v = validateBody("Hello world.");
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.body).toBe("Hello world.");
	});
});
