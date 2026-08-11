/**
 * i18n shim tests.
 *
 * The interpolation branch of `t()` had zero call sites and zero tests before
 * this suite — every caller passed a bare key. It is now load-bearing for
 * email subjects and widget templates, so it gets covered properly here.
 *
 * The independence test at the bottom is the regression guard for the deleted
 * module-global `active` locale: a Worker isolate serves concurrent requests,
 * so any shared mutable locale leaks across them at every `await`.
 */
import { describe, it, expect } from "vitest";
import {
	FALLBACK_LOCALE,
	LOCALES,
	isAutoSelectable,
	isLocale,
	t,
	tFor,
	type Translator,
} from "../src/i18n";

describe("tFor", () => {
	it("returns English for the default locale", () => {
		expect(tFor("en")("err.not_found")).toBe("Not found.");
	});

	it("falls back to English for an unregistered locale", () => {
		expect(tFor("zz")("err.not_found")).toBe(t("err.not_found"));
	});

	it("does not throw on hostile locale input", () => {
		for (const hostile of ["../../etc/passwd", "<script>", "", "constructor", "__proto__"]) {
			expect(() => tFor(hostile)("err.not_found")).not.toThrow();
			expect(tFor(hostile)("err.not_found")).toBe(t("err.not_found"));
		}
	});
});

describe("interpolation", () => {
	it("substitutes named placeholders", () => {
		expect(t("err.body.too_long", { max: 5000 })).toBe(
			"Comment is too long (max 5000 characters).",
		);
	});

	it("leaves unknown placeholders intact rather than emitting undefined", () => {
		expect(t("err.body.too_long", {})).toContain("{max}");
	});

	it("leaves the template alone when no vars are passed", () => {
		expect(t("err.body.too_long")).toContain("{max}");
	});

	it("treats $-patterns in a var value as literal text", () => {
		// Author names and post titles are user-supplied. A naive string
		// replacement would let `$&` re-inject the matched placeholder.
		for (const hostile of ["$&", "$`", "$'", "$1", "$$"]) {
			expect(t("err.body.too_long", { max: hostile })).toBe(
				`Comment is too long (max ${hostile} characters).`,
			);
		}
	});

	it("does not recursively expand a placeholder introduced by a var value", () => {
		expect(t("err.body.too_long", { max: "{max}" })).toBe(
			"Comment is too long (max {max} characters).",
		);
	});
});

describe("missing keys", () => {
	it("returns the key itself as a last resort", () => {
		const unknown = "err.does.not.exist" as never;
		expect(tFor("en")(unknown)).toBe("err.does.not.exist");
	});
});

describe("locale registry", () => {
	it("whitelists only registered locales", () => {
		expect(isLocale("en")).toBe(true);
		expect(isLocale("zz")).toBe(false);
		expect(isLocale(null)).toBe(false);
		expect(isLocale(undefined)).toBe(false);
	});

	it("does not treat inherited Object properties as locales", () => {
		// LOCALES is a plain object literal; a bare `LOCALES[v] !== undefined`
		// check would accept "toString" and hand it to Intl.PluralRules.
		expect(isLocale("toString")).toBe(false);
		expect(isLocale("constructor")).toBe(false);
		expect(isLocale("__proto__")).toBe(false);
	});

	it("registers the default locale", () => {
		expect(isLocale(FALLBACK_LOCALE)).toBe(true);
		expect(LOCALES[FALLBACK_LOCALE]?.status).toBe("source");
	});

	it("allows automatic selection of source and reviewed locales only", () => {
		expect(isAutoSelectable("en")).toBe(true);
		expect(isAutoSelectable("zz")).toBe(false);
		for (const [tag, meta] of Object.entries(LOCALES)) {
			expect(isAutoSelectable(tag)).toBe(meta.status !== "machine-seeded");
		}
	});
});

describe("translator independence", () => {
	it("keeps two translators isolated from one another", () => {
		// Regression guard for the removed module-global `active` locale.
		const a: Translator = tFor("en");
		const b: Translator = tFor("zz");
		const before = a("err.not_found");
		b("err.not_found");
		expect(a("err.not_found")).toBe(before);
	});

	it("survives interleaved async use", async () => {
		const translators = ["en", "zz", "en"].map((l) => tFor(l));
		const results = await Promise.all(
			translators.map(async (fn) => {
				const first = fn("err.internal");
				await Promise.resolve();
				return [first, fn("err.internal")] as const;
			}),
		);
		for (const [first, second] of results) expect(second).toBe(first);
	});
});
