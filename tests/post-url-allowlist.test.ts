/**
 * allowedPostUrl — the single gate a caller-supplied page URL passes before it
 * is stored in posts.url (POST /api/v1/comments) or followed by /c/:id.
 *
 * The write path accepts `post_url` from an unauthenticated request and the
 * permalink route redirects to whatever is stored, so both ends call this.
 * The property under test is "http(s) on an ALLOWED_ORIGINS origin, nothing
 * else", with the bypass shapes that beat a scheme-only or substring check.
 */
import { describe, expect, it } from "vitest";
import { allowedPostUrl } from "../src/lib/cors";

const ALLOWED = "https://blog.example.com, http://localhost:4321";

describe("allowedPostUrl", () => {
	it("accepts an absolute URL on an allowlisted origin and returns it normalised", () => {
		expect(allowedPostUrl("https://blog.example.com/p/1?x=1#s", ALLOWED)).toBe(
			"https://blog.example.com/p/1?x=1#s",
		);
		expect(allowedPostUrl("HTTPS://BLOG.example.com/P", ALLOWED)).toBe(
			"https://blog.example.com/P",
		);
		expect(allowedPostUrl("http://localhost:4321/dev", ALLOWED)).toBe(
			"http://localhost:4321/dev",
		);
	});

	it.each([
		["other host", "https://evil.example.com/"],
		["allowlisted host as a subdomain of another", "https://blog.example.com.evil.example/"],
		["allowlisted host in userinfo", "https://blog.example.com@evil.example/"],
		["scheme mismatch", "http://blog.example.com/"],
		["port mismatch", "https://blog.example.com:8443/"],
		["scheme-relative", "//blog.example.com/"],
		["path-relative", "/post/"],
		["javascript:", "javascript:alert(1)"],
		["data:", "data:text/html,<script>"],
		["empty", ""],
		["garbage", "not a url"],
	])("rejects %s", (_label, raw) => {
		expect(allowedPostUrl(raw, ALLOWED)).toBeNull();
	});

	it("keeps a backslash trick on the allowlisted origin (WHATWG parses it as a path)", () => {
		// `https://blog.example.com\@evil.example/` is host blog.example.com,
		// path `/@evil.example/` — the origin comparison is on the parsed URL,
		// so the redirect stays on the operator's site.
		expect(allowedPostUrl("https://blog.example.com\\@evil.example/", ALLOWED)).toBe(
			"https://blog.example.com/@evil.example/",
		);
	});

	it("rejects everything when ALLOWED_ORIGINS is unset or empty", () => {
		expect(allowedPostUrl("https://blog.example.com/", undefined)).toBeNull();
		expect(allowedPostUrl("https://blog.example.com/", "")).toBeNull();
		expect(allowedPostUrl("https://blog.example.com/", " , ")).toBeNull();
	});

	it("ignores non-string input", () => {
		expect(allowedPostUrl(null, ALLOWED)).toBeNull();
		expect(allowedPostUrl(undefined, ALLOWED)).toBeNull();
	});

	it("rejects an over-long URL before parsing it", () => {
		expect(allowedPostUrl(`https://blog.example.com/${"a".repeat(2100)}`, ALLOWED)).toBeNull();
	});
});
