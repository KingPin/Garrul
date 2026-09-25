/**
 * makeS — the widget translator's fallbacks. A community translation is
 * often incomplete, so every gap must degrade to English rather than to a
 * raw key or a thrown error on first render.
 */
import { describe, it, expect } from "vitest";
import { makeS } from "../src/widget/strings";

describe("makeS", () => {
	it("splits a sentence around its slot, keeping vars on both sides", () => {
		const { sAround } = makeS({ "w.posting_as": "{who}: posting as {name} ({who})" });
		expect(sAround("w.posting_as", "name", { who: "you" })).toEqual(["you: posting as ", " (you)"]);
	});

	it("puts the whole sentence first when a translation dropped the slot", () => {
		const { sAround } = makeS({ "w.powered_by": "Propulsé" });
		expect(sAround("w.powered_by", "link")).toEqual(["Propulsé", ""]);
	});

	it("falls back to English plurals when a plural entry has no usable form", () => {
		const { s } = makeS({ "w.replies": { few: "unused" } }, "en");
		expect(s("w.replies", { n: 3 })).toBe("3 replies");
	});

	it("uses English plural rules for an unregistered locale tag instead of throwing", () => {
		const { s } = makeS({ "w.replies": { one: "{n} uno", other: "{n} muchos" } }, "not a locale!");
		expect(s("w.replies", { n: 1 })).toBe("1 uno");
		expect(s("w.replies", { n: 2 })).toBe("2 muchos");
	});
});
