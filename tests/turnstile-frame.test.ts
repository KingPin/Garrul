/**
 * Tests for GET /embed/turnstile-frame — the same-origin iframe host that
 * keeps Cloudflare Turnstile out of the widget's Shadow DOM (whose parent
 * chain crashes api.js's `.tagName.toLowerCase()` fingerprinter).
 */
import { describe, it, expect } from "vitest";
import worker from "../src/index";

type Env = Partial<{
	TURNSTILE_SITE_KEY: string;
	ALLOWED_ORIGINS: string;
}>;

const fetchFrame = (path: string, env: Env = {}): Promise<Response> => {
	const merged: Env = {
		TURNSTILE_SITE_KEY: "0x4AAAAAAA_test_key",
		ALLOWED_ORIGINS: "https://blog.example.com",
		...env,
	};
	return worker.fetch(
		new Request(`https://comments.test.example${path}`),
		merged as unknown as Record<string, unknown>,
		{} as ExecutionContext,
	);
};

describe("GET /embed/turnstile-frame", () => {
	it("returns HTML with the configured site key embedded", async () => {
		const res = await fetchFrame("/embed/turnstile-frame");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		);
		const body = await res.text();
		expect(body).toContain("0x4AAAAAAA_test_key");
		expect(body).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
		expect(body).toContain("garrul:turnstile-token");
	});

	it("404s when TURNSTILE_SITE_KEY is not configured", async () => {
		const res = await fetchFrame("/embed/turnstile-frame", {
			TURNSTILE_SITE_KEY: "",
		});
		expect(res.status).toBe(404);
	});

	it("honors parent_origin when it's a valid origin", async () => {
		const res = await fetchFrame(
			"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fblog.example.com",
		);
		const body = await res.text();
		// Parent origin lands as a JSON-quoted literal in the script body.
		expect(body).toContain('"https://blog.example.com"');
	});

	it("drops parent_origin when it isn't a clean origin", async () => {
		// path component → not a bare origin → fall back to "" (referrer-derived).
		const res = await fetchFrame(
			"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fevil.example%2Fpath",
		);
		const body = await res.text();
		expect(body).not.toContain("evil.example");
	});

	it("clamps theme to the allowed set", async () => {
		const ok = await fetchFrame("/embed/turnstile-frame?theme=dark").then(
			(r) => r.text(),
		);
		expect(ok).toContain('"dark"');
		const bad = await fetchFrame(
			"/embed/turnstile-frame?theme=);alert(1);(",
		).then((r) => r.text());
		// Anything outside light|dark|auto collapses to auto.
		expect(bad).toContain('"auto"');
		expect(bad).not.toContain("alert");
	});

	it("sets a restrictive CSP that allows Cloudflare and nothing else", async () => {
		const res = await fetchFrame("/embed/turnstile-frame");
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("https://challenges.cloudflare.com");
		// frame-ancestors is intentionally not pinned — operators choose where
		// this frame gets embedded — but the directive should still be absent
		// (omit means same as default-src, which would be 'none'). We rely on
		// the global X-Frame-Options skip for /embed/* (see src/index.ts).
		expect(csp).not.toContain("frame-ancestors");
	});

	it("does not set X-Frame-Options DENY (so it can be embedded)", async () => {
		const res = await fetchFrame("/embed/turnstile-frame");
		// Global header middleware skips X-Frame-Options for /embed/*.
		expect(res.headers.get("x-frame-options")).toBeNull();
	});
});
