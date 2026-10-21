/**
 * frameConfig: the iframe embed's query → mount attributes. The Worker route
 * and the static shell (src/widget/frame.ts) both call it, so these rules are
 * the whole contract for both.
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "../src/i18n";
import { matchLocale } from "../src/i18n/negotiate";
import { frameConfig } from "../src/widget/frame-config";

const SELF = "https://comments.example.com";
const env = { allowed: ["https://blog.example.com"], locales: Object.keys(LOCALES), dev: false };
const cfg = (query: string, slug = "post", e = env) =>
	frameConfig(slug, new URLSearchParams(query), SELF, e);

describe("frameConfig", () => {
	it("refuses a missing or overlong slug", () => {
		expect(cfg("", "")).toBeNull();
		expect(cfg("", "x".repeat(201))).toBeNull();
		expect(cfg("", "x".repeat(200))).not.toBeNull();
	});

	it("honors ?api= only for an allowlisted origin", () => {
		expect(cfg("api=https://blog.example.com/x")?.apiBase).toBe("https://blog.example.com");
		expect(cfg("api=https://evil.example")?.apiBase).toBe(SELF);
		expect(cfg("api=javascript:alert(1)")?.apiBase).toBe(SELF);
	});

	it("accepts a parent origin only when bare and allowlisted, or self", () => {
		expect(cfg("parent_origin=https://blog.example.com")?.parentOrigin).toBe("https://blog.example.com");
		expect(cfg(`parent_origin=${SELF}`)?.parentOrigin).toBe(SELF);
		expect(cfg("parent_origin=https://blog.example.com/")?.parentOrigin).toBe("");
		expect(cfg("parent_origin=https://evil.example")?.parentOrigin).toBe("");
		expect(cfg("parent_origin=https://evil.example", "post", { ...env, dev: true })?.parentOrigin).toBe(
			"https://evil.example",
		);
	});

	it("closes theme, preset and mode over their vocabularies", () => {
		expect(cfg("theme=dark")?.theme).toBe("dark");
		expect(cfg("theme=red;x")?.theme).toBe("auto");
		const data = (q: string) => Object.fromEntries(cfg(q)?.data ?? []);
		expect(data("preset=soft").preset).toBe("soft");
		expect(data("preset=bogus")).not.toHaveProperty("preset");
		expect(data("mode=reactions").mode).toBe("reactions");
		expect(data("mode=x")).not.toHaveProperty("mode");
		expect(data("")).not.toHaveProperty("published");
	});

	it("claims the same <html lang> the server's matcher would", () => {
		for (const tag of ["de-AT", "no", "zh-TW", "zh-Hans-TW", "PT-br", "xx", ""]) {
			expect(cfg(`lang=${encodeURIComponent(tag)}`)?.docLang).toBe(matchLocale(tag) ?? "en");
		}
		// data-lang stays the raw request.
		expect(Object.fromEntries(cfg("lang=de-AT")?.data ?? []).lang).toBe("de-AT");
	});
});
