/**
 * The client-side highlighter (src/widget/highlighter.ts).
 *
 * The loader depends on this module's output being safe HTML and on its
 * null contract: a null means "leave the block as plain text". These tests pin
 * the escaping, the language aliases, the size cap and the round trip.
 */
import { describe, it, expect } from "vitest";
import { highlight } from "../src/widget/highlighter";

const decode = (s: string) =>
	s
		.replace(/<[^>]*>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&");

describe("highlight", () => {
	it("escapes HTML in the source", () => {
		const out = highlight("<script>alert(1)</script> & x", "html");
		expect(out).not.toBeNull();
		expect(out).toContain("&lt;");
		expect(out).toContain("&amp;");
		expect(out).not.toContain("&lt;script");
		expect(out).not.toContain("<script");
	});

	it.each(["js", "JS", "py", "c++", "yml", "toml"])(
		"resolves the language alias %s",
		(lang) => {
			const out = highlight("const a = 1", lang);
			expect(out).not.toBeNull();
			expect(out).toContain("hljs-");
		},
	);

	it("returns null for unknown or empty languages", () => {
		expect(highlight("x", "mermaid")).toBeNull();
		expect(highlight("x", "")).toBeNull();
	});

	it("returns null above 2000 characters", () => {
		const s = "foo bar baz qux ".repeat(200);
		expect(highlight(s.slice(0, 2000), "cpp")).not.toBeNull();
		expect(highlight(s.slice(0, 2001), "cpp")).toBeNull();
	});

	it("round-trips the text after stripping tags and decoding entities", () => {
		const input =
			'function f(a) {\n  if (a < 1 && a > -1) return "x" + \'y\';\n  return a & 2;\n}';
		const out = highlight(input, "js");
		expect(out).not.toBeNull();
		expect(decode(out as string)).toBe(input);
	});
});
