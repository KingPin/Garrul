import { describe, expect, it } from "vitest";
import {
	MAX_TERM_CHARS,
	MAX_TERMS,
	MAX_WILDCARDS,
	checkBlocklist,
	compileBlocklist,
	normalizeForMatch,
	parseBlocklist,
} from "../src/lib/spam/blocklist";

const hit = (list: string, body: string) =>
	checkBlocklist(parseBlocklist(list), { body_md: body, author_name: "Ada" });

describe("normalizeForMatch", () => {
	it("folds case and NFKC compatibility forms", () => {
		expect(normalizeForMatch("\uFF36\uFF29\uFF21\uFF27\uFF32\uFF21")).toBe("viagra");
	});

	it("strips zero-width and soft-hyphen evasion", () => {
		expect(normalizeForMatch("v\u200Bia\u00ADg\uFEFFra")).toBe("viagra");
	});
});

describe("parseBlocklist", () => {
	it("ignores blank lines and # comments", () => {
		const terms = parseBlocklist("# spam words\n\nviagra\n   \ncasino\n");
		expect(terms.map((t) => t.source)).toEqual(["viagra", "casino"]);
	});

	it("keeps the operator's original casing in `source` for display", () => {
		expect(parseBlocklist("ViAgRa")[0]?.source).toBe("ViAgRa");
	});

	it("drops terms over the per-term length cap", () => {
		expect(parseBlocklist("a".repeat(MAX_TERM_CHARS + 1))).toHaveLength(0);
		expect(parseBlocklist("a".repeat(MAX_TERM_CHARS))).toHaveLength(1);
	});

	it("drops terms with too many wildcards", () => {
		expect(parseBlocklist(`${"a*".repeat(MAX_WILDCARDS)}a`)).toHaveLength(1);
		expect(parseBlocklist(`${"a*".repeat(MAX_WILDCARDS + 1)}a`)).toHaveLength(0);
	});

	it("caps the total number of terms", () => {
		const list = Array.from({ length: MAX_TERMS + 50 }, (_, i) => `t${i}`);
		expect(parseBlocklist(list.join("\n"))).toHaveLength(MAX_TERMS);
	});

	it("refuses a term that would match everything", () => {
		expect(parseBlocklist("*")).toHaveLength(0);
		expect(parseBlocklist("**")).toHaveLength(0);
		expect(parseBlocklist("\u200B")).toHaveLength(0);
	});
});

describe("checkBlocklist — anchoring", () => {
	it("matches a bare term on word boundaries only", () => {
		expect(hit("viagra", "buy viagra now")).toMatchObject({ term: "viagra" });
		expect(hit("viagra", "VIAGRA!")).not.toBeNull();
	});

	it("does not match inside a longer word (Scunthorpe)", () => {
		expect(hit("ass", "a class assessment")).toBeNull();
		expect(hit("cial", "a specialist wrote this")).toBeNull();
	});

	it("respects boundaries for non-Latin scripts", () => {
		// The reason WORD_CHAR uses \p{L} rather than \b: with an ASCII-only word
		// class every Cyrillic letter looks like a boundary, so this would match.
		expect(hit("спам", "неспамный текст")).toBeNull();
		expect(hit("спам", "это спам")).not.toBeNull();
	});

	it("treats a leading/trailing * as unanchored", () => {
		expect(hit("*ass*", "a class assessment")).not.toBeNull();
		expect(hit("casino*", "casinos are spam")).not.toBeNull();
		expect(hit("casino*", "the microcasino")).toBeNull();
	});
});

describe("checkBlocklist — literals and wildcards", () => {
	it("treats regex metacharacters as literal text", () => {
		expect(hit("a.c", "abc")).toBeNull();
		expect(hit("a.c", "a.c")).not.toBeNull();
		expect(hit("(x)", "x")).toBeNull();
		expect(hit("(x)", "(x)")).not.toBeNull();
	});

	it("cannot be used to inject a quantifier", () => {
		// The whole point of the restricted grammar: this is inert text, not a
		// catastrophic-backtracking pattern.
		const terms = parseBlocklist("(a+)+$");
		expect(terms).toHaveLength(1);
		const start = Date.now();
		expect(
			checkBlocklist(terms, {
				body_md: `${"a".repeat(40)}!`,
				author_name: "Ada",
			}),
		).toBeNull();
		expect(Date.now() - start).toBeLessThan(100);
	});

	it("matches a mid-term wildcard across arbitrary text", () => {
		expect(hit("buy*now", "buy cheap pills now")).not.toBeNull();
		expect(hit("buy*now", "buy cheap pills later")).toBeNull();
	});

	it("matches a URL-shaped prefix term", () => {
		expect(hit("t.me/*", "ping me at t.me/spammer")).not.toBeNull();
		expect(hit("t.me/*", "ping me at telegram")).toBeNull();
	});

	it("stays fast on the genuine worst case: every candidate start explored", () => {
		// The path that matters. `*a*z` is unanchored, so every one of the ~10k
		// "a" positions is a candidate start, and the trailing "b" means the end
		// boundary fails at each of them — no early exit anywhere. The body has
		// to stay under MAX_MATCH_CHARS or the "z" gets sliced off and the
		// fast-reject short-circuits, which is exactly the mistake that let an
		// earlier version of this test pass while the matcher was quadratic
		// enough to burn 12 seconds on a 2000-char body.
		const terms = parseBlocklist("*a*z");
		const body = `${"a".repeat(9_990)}zb`;
		const start = Date.now();
		expect(checkBlocklist(terms, { body_md: body, author_name: "Ada" })).toBeNull();
		expect(Date.now() - start).toBeLessThan(250);
	});

	it("stays bounded when a hostile list repeats the worst term", () => {
		const terms = parseBlocklist(Array.from({ length: MAX_TERMS }, () => "*a*z").join("\n"));
		expect(terms).toHaveLength(MAX_TERMS);
		const start = Date.now();
		checkBlocklist(terms, { body_md: `${"a".repeat(9_990)}zb`, author_name: "Ada" });
		// Measured ~130ms. The bound is MAX_TERMS x MAX_MATCH_CHARS^2 with a
		// native indexOf inner loop; this guards the order of magnitude, not the
		// exact figure.
		expect(Date.now() - start).toBeLessThan(2_000);
	});

	it("caps the text any single term is matched against", () => {
		// Past MAX_MATCH_CHARS the haystack is truncated, so a term cannot be
		// made to scan an arbitrarily long field.
		const terms = parseBlocklist("*casino*");
		expect(
			checkBlocklist(terms, {
				body_md: `${"a".repeat(10_000)}casino`,
				author_name: "Ada",
			}),
		).toBeNull();
		expect(
			checkBlocklist(terms, {
				body_md: `${"a".repeat(9_000)}casino`,
				author_name: "Ada",
			}),
		).not.toBeNull();
	});
});

describe("checkBlocklist — fields", () => {
	const terms = parseBlocklist("casino");

	it("matches the author name", () => {
		expect(
			checkBlocklist(terms, { body_md: "hello", author_name: "Casino Bot" }),
		).toEqual({ term: "casino", field: "name" });
	});

	it("matches the post URL", () => {
		expect(
			checkBlocklist(terms, {
				body_md: "hello",
				author_name: "Ada",
				post_url: "https://example.com/casino",
			}),
		).toEqual({ term: "casino", field: "url" });
	});

	it("reports the body first when several fields match", () => {
		expect(
			checkBlocklist(terms, { body_md: "casino", author_name: "Casino Bot" }),
		).toEqual({ term: "casino", field: "body" });
	});

	it("returns null for an empty list without touching the input", () => {
		expect(checkBlocklist([], { body_md: "casino", author_name: "Casino" })).toBeNull();
	});

	it("tolerates a null post_url", () => {
		expect(
			checkBlocklist(terms, {
				body_md: "hi",
				author_name: "Ada",
				post_url: null,
			}),
		).toBeNull();
	});
});

describe("compileBlocklist", () => {
	it("returns an identical result to parseBlocklist", () => {
		const raw = "viagra\ncasino";
		expect(compileBlocklist(raw).map((t) => t.source)).toEqual(
			parseBlocklist(raw).map((t) => t.source),
		);
	});

	it("memoizes on the raw string and re-parses when it changes", () => {
		const first = compileBlocklist("viagra");
		expect(compileBlocklist("viagra")).toBe(first);
		const second = compileBlocklist("casino");
		expect(second).not.toBe(first);
		expect(second.map((t) => t.source)).toEqual(["casino"]);
	});
});
