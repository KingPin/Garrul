/**
 * Locale negotiation.
 *
 * The two properties worth guarding here are (a) the precedence order, which
 * is the whole design, and (b) that a raw tag off the wire can never become
 * anything except a key that is already in LOCALES. Negotiation is the only
 * place a request-controlled string chooses a code path, so it whitelists
 * rather than sanitizes — these tests are what keeps it that way.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_LOCALE } from "../src/i18n";
import { AUTO_LOCALE, matchLocale, resolveLocale } from "../src/i18n/negotiate";

// Built, not written literally. A raw NUL in the source made git classify this
// whole file as binary, so none of these tests showed up in a diff — the same
// reason tests/post-title.test.ts constructs its control characters.
const NUL = String.fromCharCode(0);

describe("matchLocale", () => {
	it("matches a registered tag exactly", () => {
		expect(matchLocale("en")).toBe("en");
	});

	it("is case-insensitive and trims", () => {
		expect(matchLocale("  EN  ")).toBe("en");
	});

	it("falls back from a region subtag to the primary subtag", () => {
		// en-GB / en-US must not 404 into English-by-default — they must
		// *match* English, so the caller can tell a hit from a miss.
		expect(matchLocale("en-GB")).toBe("en");
		expect(matchLocale("EN-us")).toBe("en");
	});

	it("routes the Norwegian macrolanguage tag to Bokmål", () => {
		// `no` and `nb` are sibling primary subtags, so the region-to-primary
		// hop above can't reach `nb` from `no`; the alias table has to.
		expect(matchLocale("no")).toBe("nb");
		expect(matchLocale("no-NO")).toBe("nb");
		expect(matchLocale("nb-NO")).toBe("nb");
	});

	it("routes Traditional Chinese script and region tags to zh-Hant", () => {
		for (const tag of ["zh-Hant", "zh-Hant-TW", "zh-TW", "zh-HK", "zh-MO"]) {
			expect(matchLocale(tag), tag).toBe("zh-Hant");
		}
	});

	it("does not guess a Chinese script from ambiguous or Simplified tags", () => {
		for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN"]) {
			expect(matchLocale(tag), tag).toBeUndefined();
		}
	});

	it("returns undefined for anything unregistered", () => {
		expect(matchLocale("zz")).toBeUndefined();
		expect(matchLocale("klingon")).toBeUndefined();
	});

	it("returns undefined rather than a default, so callers can fall through", () => {
		expect(matchLocale(undefined)).toBeUndefined();
		expect(matchLocale(null)).toBeUndefined();
		expect(matchLocale("")).toBeUndefined();
		expect(matchLocale("   ")).toBeUndefined();
	});

	it("rejects non-strings defensively", () => {
		expect(matchLocale(42 as unknown as string)).toBeUndefined();
		expect(matchLocale({} as unknown as string)).toBeUndefined();
	});

	it("rejects hostile input instead of escaping it", () => {
		// The point is that none of these can ever reach a table lookup or a
		// file path: the only values that survive are keys already in LOCALES.
		for (const hostile of [
			"../../etc/passwd",
			"<script>alert(1)</script>",
			"en'; DROP TABLE comments;--",
			"__proto__",
			"constructor",
			"toString",
			`en${NUL}`,
			"..%2f..%2fen",
		]) {
			expect(matchLocale(hostile)).toBeUndefined();
		}
	});

	it("rejects an over-long tag without walking it", () => {
		expect(matchLocale(`en-${"x".repeat(500)}`)).toBeUndefined();
	});

	it("does not treat the auto sentinel as a locale", () => {
		// This is what makes "never configured" distinguishable from
		// "deliberately set to English" in resolveLocale.
		expect(matchLocale(AUTO_LOCALE)).toBeUndefined();
	});
});

describe("resolveLocale", () => {
	it("falls back to English when nothing is supplied", () => {
		expect(resolveLocale({})).toBe(FALLBACK_LOCALE);
	});

	it("prefers the explicit request over everything else", () => {
		expect(
			resolveLocale({
				requested: "en-GB",
				operatorDefault: AUTO_LOCALE,
				hostPage: "zz",
			}),
		).toBe("en");
	});

	it("uses the operator default when no explicit request is made", () => {
		expect(resolveLocale({ operatorDefault: "en" })).toBe("en");
	});

	it("falls through the auto sentinel to the host-page hint", () => {
		expect(resolveLocale({ operatorDefault: AUTO_LOCALE, hostPage: "en" })).toBe("en");
	});

	it("ignores an unmatched source and keeps negotiating", () => {
		expect(resolveLocale({ requested: "zz", hostPage: "en" })).toBe("en");
		expect(resolveLocale({ requested: "zz", operatorDefault: "en" })).toBe("en");
	});

	it("resolves hostile input to English rather than propagating it", () => {
		expect(resolveLocale({ requested: "../../etc" })).toBe(FALLBACK_LOCALE);
		expect(resolveLocale({ requested: "<script>" })).toBe(FALLBACK_LOCALE);
		expect(resolveLocale({ hostPage: "__proto__" })).toBe(FALLBACK_LOCALE);
	});

	it("only ever returns a key that exists in the registry", () => {
		for (const raw of ["en", "en-GB", "zz", "", "../x", AUTO_LOCALE]) {
			const resolved = resolveLocale({ requested: raw, hostPage: raw });
			expect(matchLocale(resolved)).toBe(resolved);
		}
	});
});
