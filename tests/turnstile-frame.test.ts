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
		// A path component means it isn't a bare origin, so it can never equal
		// the `e.origin` the browser reports — reject rather than normalize.
		const res = await fetchFrame(
			"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fevil.example%2Fpath",
		);
		const body = await res.text();
		expect(body).not.toContain("evil.example");
	});

	it("drops a well-formed parent_origin that isn't allowlisted", async () => {
		// The bypass this closes: any site could frame this page with its own
		// origin and collect a Turnstile token minted against the operator's site
		// key — a harvestable anti-spam bypass for that instance.
		const res = await fetchFrame(
			"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fevil.example",
		);
		const body = await res.text();
		expect(body).not.toContain("evil.example");
		// With no target the script bails before rendering the widget at all.
		expect(body).toContain('var parentOrigin = "";');
	});

	it("accepts the Worker's own origin as parent_origin", async () => {
		// Load-bearing: the widget inside /embed/:slug builds this frame with
		// `parent_origin = window.location.origin`, which there is this Worker,
		// and operators don't list their own instance in ALLOWED_ORIGINS.
		const res = await fetchFrame(
			"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fcomments.test.example",
		);
		const body = await res.text();
		expect(body).toContain('"https://comments.test.example"');
	});

	it("does not fall back to document.referrer", async () => {
		// The referrer fallback was the same bypass without needing the query
		// param: the framing page's origin, unallowlisted, used as the target.
		const res = await fetchFrame("/embed/turnstile-frame");
		const body = await res.text();
		expect(body).not.toContain("document.referrer");
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
	});

	it("pins frame-ancestors to ALLOWED_ORIGINS plus its own origin", async () => {
		// frame-ancestors has no fallback to default-src, so omitting it — as
		// this route used to — left the page framable by anyone regardless of
		// `default-src 'none'`.
		const res = await fetchFrame("/embed/turnstile-frame");
		const directive = (res.headers.get("content-security-policy") ?? "")
			.split(";")
			.map((d) => d.trim())
			.find((d) => d.startsWith("frame-ancestors"));
		expect(directive).toBeDefined();
		expect(directive).toContain("https://blog.example.com");
		expect(directive).toContain("https://comments.test.example");
		expect(directive).not.toContain("*");
	});

	it("keeps every configured origin in frame-ancestors", async () => {
		const res = await fetchFrame("/embed/turnstile-frame", {
			ALLOWED_ORIGINS: "https://a.example, https://b.example",
		});
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("https://a.example");
		expect(csp).toContain("https://b.example");
	});

	it("allows 'self' in connect-src for Turnstile clearance redemption", async () => {
		// api.js posts to /cdn-cgi/challenge-platform/h/b/rc/... on this iframe's
		// origin to redeem clearance. Without 'self' here, Turnstile fails with
		// "Error contacting Turnstile, aborting clearance redemption" and the
		// token callback never fires.
		const res = await fetchFrame("/embed/turnstile-frame");
		const csp = res.headers.get("content-security-policy") ?? "";
		const connectSrc = csp
			.split(";")
			.map((d) => d.trim())
			.find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBeDefined();
		expect(connectSrc).toContain("'self'");
		expect(connectSrc).toContain("https://challenges.cloudflare.com");
	});

	it("does not set X-Frame-Options DENY (so it can be embedded)", async () => {
		const res = await fetchFrame("/embed/turnstile-frame");
		// Global header middleware skips X-Frame-Options for /embed/*. It has to:
		// XFO has no allowlist form, so DENY would break the feature outright.
		// The allowlist lives in frame-ancestors instead, asserted above, and
		// setting both is worse than one — browsers disagree on which wins.
		expect(res.headers.get("x-frame-options")).toBeNull();
	});
});
