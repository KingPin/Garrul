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
	sanitizeForEmail,
	validateBody,
} from "../src/lib/markdown";

const MAX_BODY_CHARS = 10_000;

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
		const long = "a".repeat(MAX_BODY_CHARS * 2);
		const out = renderMarkdown(long);
		// The renderer slices the input to MAX_BODY_CHARS BEFORE parsing,
		// so the count of "a" characters in the output must equal the cap
		// exactly — not "less than what we sent in," which was the old
		// (very weak) assertion.
		const aCount = (out.match(/a/g) ?? []).length;
		expect(aCount).toBe(MAX_BODY_CHARS);
	});

	it("strips vbscript: links", () => {
		const out = renderMarkdown("[x](vbscript:msgbox(1))");
		expect(out).not.toMatch(/href="vbscript:/i);
	});

	it("strips scheme-relative // links (no scheme means not in allowlist)", () => {
		const out = renderMarkdown("[x](//evil.example.com)");
		expect(out).not.toMatch(/href="\/\//);
	});

	it("strips entity-encoded javascript: URLs", () => {
		// marked decodes entities before our scheme check; allowlist must
		// still catch the decoded form.
		const out = renderMarkdown("[x](&#106;avascript:alert(1))");
		expect(out).not.toMatch(/href="[^"]*[jJ]avascript:/i);
	});

	it("ignores raw <img onerror> in markdown source", () => {
		const out = renderMarkdown('<img src=x onerror="alert(1)">');
		expect(out).not.toContain("<img");
		expect(out).not.toContain("onerror");
	});

	it("ignores inline event handlers in raw HTML", () => {
		const out = renderMarkdown('<a href="x" onclick="alert(1)">x</a>');
		expect(out).not.toMatch(/onclick/i);
	});
});

describe("sanitizeForEmail", () => {
	it("preserves allowed tags + escaped href on <a>", () => {
		const out = sanitizeForEmail('<p>hi <a href="https://a.b">x</a></p>');
		expect(out).toContain("<p>");
		expect(out).toContain('href="https://a.b"');
	});

	it("strips style attributes from <p>", () => {
		const out = sanitizeForEmail('<p style="color:red">hi</p>');
		expect(out).not.toContain("style");
		expect(out).toContain("<p>");
	});

	it("strips event handlers from <a>", () => {
		const out = sanitizeForEmail('<a href="https://a.b" onclick="x">y</a>');
		expect(out).not.toMatch(/onclick/i);
		expect(out).toContain('href="https://a.b"');
	});

	it("drops javascript: hrefs entirely", () => {
		const out = sanitizeForEmail('<a href="javascript:alert(1)">x</a>');
		expect(out).not.toMatch(/javascript:/i);
		expect(out).toContain("<a>");
	});

	it("drops tags outside the email allowlist", () => {
		const out = sanitizeForEmail("<script>alert(1)</script><h1>x</h1>");
		expect(out).not.toContain("<script");
		expect(out).not.toContain("<h1");
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
