/**
 * Sanitizer critical-path tests. Tightly focused on what an attacker
 * would actually try: raw HTML, javascript: URLs, attribute injection,
 * length DoS. Regressions here are a security incident — keep this
 * suite lean and obvious.
 */
import { describe, it, expect } from "vitest";
import { Marked } from "marked";
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

// The allowlist in src/lib/markdown.ts's docblock is a promise. These assert it
// against the *actual* output rather than against the overrides, so a tag that
// arrives via a marked upgrade (rather than via an edit to this repo) is caught.
describe("renderMarkdown — allowlist contract", () => {
	const ALLOWED = new Set([
		"p", "br", "em", "strong", "del", "code", "pre", "a",
		"blockquote", "ul", "ol", "li",
	]);

	const tagsIn = (html: string): string[] => [
		...new Set(
			[...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) =>
				m[1].toLowerCase(),
			),
		),
	];

	it("emits no tag outside the allowlist across the whole feature surface", () => {
		// One document exercising every construct marked's gfm mode can produce.
		const kitchenSink = [
			"# heading",
			"## another",
			"para with **bold** _em_ `code` ~~struck~~ and ~single~",
			"[link](https://a.example) and <https://b.example>",
			"![img](https://c.example/x.png)",
			"---",
			"> quote",
			"- bullet",
			"- [ ] todo",
			"- [x] done",
			"1. ordered",
			"| a | b |",
			"| - | - |",
			"| 1 | 2 |",
			"```js",
			"code",
			"```",
			"    indented code",
			"term[^1]",
			"",
			"[^1]: footnote",
			"<div onclick='x'>raw</div>",
			"<script>alert(1)</script>",
		].join("\n\n");
		const out = renderMarkdown(kitchenSink);
		const unexpected = tagsIn(out).filter((t) => !ALLOWED.has(t));
		expect(unexpected).toEqual([]);
	});

	it("renders GFM strikethrough as <del> (deliberately allowed)", () => {
		expect(renderMarkdown("~~gone~~")).toBe("<p><del>gone</del></p>");
	});

	it("renders task-list checkboxes as text, not <input>", () => {
		const out = renderMarkdown("- [ ] todo\n- [x] done");
		expect(out).not.toContain("<input");
		expect(out).toContain("<li>[ ] todo</li>");
		expect(out).toContain("<li>[x] done</li>");
	});

	it("keeps a real language label on fenced code", () => {
		expect(renderMarkdown("```js\nx\n```")).toBe(
			'<pre><code class="language-js">x\n</code></pre>',
		);
		// Punctuated labels are real: c++, c#, objective-c, .net.
		expect(renderMarkdown("```c++\nx\n```")).toContain(
			'class="language-c++"',
		);
	});

	it("drops a fence info string that isn't a language label", () => {
		// marked escapes this into the class attribute rather than letting it
		// break out — but an attribute whose safety rests on an escape staying
		// correct forever is one we'd rather not populate from UGC at all.
		for (const label of [
			'js"onmouseover="alert(1)',
			"<script>",
			"a'b",
			"x".repeat(64),
		]) {
			const out = renderMarkdown(`\`\`\`${label}\nx\n\`\`\``);
			expect(out).toBe("<pre><code>x\n</code></pre>");
		}
	});

	it("still escapes code block contents", () => {
		const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
		expect(out).not.toContain("<script");
		expect(out).toContain("&lt;script&gt;");
	});
});

// Canary on a marked internal the sanitizer's core defense rests on.
//
// marked's `use()` wraps each renderer override as roughly
//   `let c = override(...); if (c === false) c = builtin(...); return c || ""`
// so `false` — and only `false` — falls through to the built-in renderer, whose
// `html()` returns the author's raw markup verbatim. Our `html()` returns `""`,
// which is falsy but not `false`, so it wins.
//
// If a future marked relaxed that identity check to a truthiness test, `""`
// would start falling through and every comment would become a raw-HTML
// injection. That change would not touch this repo, so nothing else here would
// notice. This does.
describe("marked renderer-override semantics (dependency canary)", () => {
	it("treats an override returning false as 'use the built-in'", () => {
		const m = new Marked({ gfm: true });
		m.use({ renderer: { paragraph: () => false } });
		// Fell through to the built-in paragraph renderer.
		expect(m.parse("hi", { async: false })).toContain("<p>hi</p>");
	});

	it("treats an override returning an empty string as 'emit nothing'", () => {
		const m = new Marked({ gfm: true });
		m.use({ renderer: { paragraph: () => "" } });
		// If this ever starts containing <p>, the html() override in
		// src/lib/markdown.ts has stopped dropping raw HTML.
		expect(m.parse("hi", { async: false })).toBe("");
	});

	it("rejects an override for a method the renderer doesn't have", () => {
		// Our overrides are only load-bearing if a rename in marked fails loudly
		// rather than silently leaving the built-in in place. It throws.
		const m = new Marked();
		expect(() =>
			// @ts-expect-error deliberately not a renderer method
			m.use({ renderer: { nonexistentMethod: () => "" } }),
		).toThrow();
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
