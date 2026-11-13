/**
 * Remembered author details: keyed per Worker origin, corrupt entries read as
 * empty, and a post that omits a field never erases the stored one.
 */
import { describe, it, expect } from "vitest";
import { authorKey, readAuthor, rememberAuthor } from "../src/widget/author";

const fakeStorage = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init));
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		writes: () => m.size,
	};
};

const K = authorKey("https://c.example");

describe("authorKey", () => {
	it("differs across Worker origins", () => {
		expect(K).toBe("garrul:author:https://c.example");
		expect(authorKey("https://a.example")).not.toBe(K);
	});
});

describe("readAuthor", () => {
	it("reads empty for missing, corrupt, wrongly-typed or unavailable storage", () => {
		const empty = { name: "", email: "" };
		expect(readAuthor(fakeStorage(), K)).toEqual(empty);
		expect(readAuthor(fakeStorage({ [K]: "{not json" }), K)).toEqual(empty);
		expect(readAuthor(fakeStorage({ [K]: "null" }), K)).toEqual(empty);
		expect(readAuthor(fakeStorage({ [K]: '{"name":42,"email":["x"]}' }), K)).toEqual(empty);
		expect(readAuthor(null, K)).toEqual(empty);
	});

	it("trims and clamps what it returns", () => {
		const s = fakeStorage({ [K]: JSON.stringify({ name: "  Ada  ", email: "x".repeat(400) }) });
		const a = readAuthor(s, K);
		expect(a.name).toBe("Ada");
		expect(a.email).toHaveLength(254);
	});
});

describe("rememberAuthor", () => {
	it("round-trips name and email", () => {
		const s = fakeStorage();
		rememberAuthor(s, K, { name: " Ada ", email: "ada@example.com" });
		expect(readAuthor(s, K)).toEqual({ name: "Ada", email: "ada@example.com" });
	});

	it("keeps the stored email when a later post omits it", () => {
		const s = fakeStorage();
		rememberAuthor(s, K, { name: "Ada", email: "ada@example.com" });
		rememberAuthor(s, K, { name: "Ada L", email: "" });
		expect(readAuthor(s, K)).toEqual({ name: "Ada L", email: "ada@example.com" });
	});

	it("writes nothing for an all-empty post (signed-in reader)", () => {
		const s = fakeStorage();
		rememberAuthor(s, K, { name: "", email: "" });
		expect(s.writes()).toBe(0);
	});

	it("swallows a throwing setItem and tolerates null storage", () => {
		const s = {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		expect(() => rememberAuthor(s, K, { name: "Ada" })).not.toThrow();
		expect(() => rememberAuthor(null, K, { name: "Ada" })).not.toThrow();
	});
});
