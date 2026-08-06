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
	IP_HASH_SECRET: string;
	JWT_SECRET: string;
}>;

const fetchFrame = async (path: string, env: Env = {}): Promise<Response> => {
	const merged: Env = {
		TURNSTILE_SITE_KEY: "0x4AAAAAAA_test_key",
		ALLOWED_ORIGINS: "https://blog.example.com",
		// src/lib/require-config.ts refuses to serve *any* route without these,
		// so a harness that drives the real app has to supply them.
		IP_HASH_SECRET: "test-ip-hash-secret",
		JWT_SECRET: "test-jwt-secret",
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

	// The parent defers mounting this frame until the visitor focuses the
	// composer, so a submit can end up waiting on a token that hasn't arrived.
	// These two messages are what let it tell "the challenge wants a click" from
	// "the frame never came up" — see the wire-protocol doc comment in
	// src/routes/embed-iframe.ts.
	describe("mount-state protocol", () => {
		it("reports ready once render() has returned", async () => {
			const res = await fetchFrame("/embed/turnstile-frame");
			const body = await res.text();
			expect(body).toContain("garrul:turnstile-ready");
			// Must be posted after the render call, not before it — the whole
			// point is that it proves api.js loaded and the widget painted.
			expect(body.indexOf("turnstile.render")).toBeLessThan(
				body.indexOf("garrul:turnstile-ready"),
			);
		});

		it("reports interactive from both callbacks that mean a human must act", async () => {
			const res = await fetchFrame("/embed/turnstile-frame");
			const body = await res.text();
			// before-interactive-callback: the challenge is about to demand a
			// click. timeout-callback: an interactive challenge went unsolved and
			// Turnstile reset it. Same consequence for the parent, one message.
			expect(body).toContain("before-interactive-callback");
			expect(body).toContain("timeout-callback");
			expect(
				body.match(/garrul:turnstile-interactive/g)?.length,
			).toBeGreaterThanOrEqual(2);
		});

		it("keeps the api.js load watchdog that distinguishes a dead frame", async () => {
			const res = await fetchFrame("/embed/turnstile-frame");
			const body = await res.text();
			// The parent's own cap is set above this deliberately so this more
			// specific verdict wins the race. If this budget moves, so must
			// TURNSTILE_WAIT_MS in src/widget/turnstile-gate.ts.
			expect(body).toContain("8000");
			expect(body).toContain("garrul:turnstile-error");
		});

		it("forwards Turnstile's error code from error-callback", async () => {
			const res = await fetchFrame("/embed/turnstile-frame");
			const body = await res.text();
			// Without the code the parent can only latch, because retrying a
			// misconfigured sitekey (110***) fails forever. See the retry budget
			// in src/widget/turnstile-gate.ts.
			expect(body).toContain('"error-callback": function (code)');
			expect(body).toContain('code: String(code || "")');
		});

		it("leaves the three frame-never-came-up errors code-less", async () => {
			const res = await fetchFrame("/embed/turnstile-frame");
			const body = await res.text();
			// api.js absent, render() throwing, and the load watchdog all mean a
			// reload is genuinely the right advice. Code-less is what tells the
			// parent to latch rather than retry, so it is load-bearing that
			// exactly one of the four error posts carries a code.
			expect(body.match(/garrul:turnstile-error/g)?.length).toBe(4);
			expect(
				body.match(/type: "garrul:turnstile-error" \}/g)?.length,
			).toBe(3);
		});

		it("still never posts any message to a wildcard target", async () => {
			// A token is what makes this frame worth attacking; every post must
			// go to the validated parent origin. New messages must not weaken it.
			const res = await fetchFrame(
				"/embed/turnstile-frame?parent_origin=https%3A%2F%2Fblog.example.com",
			);
			const body = await res.text();
			expect(body).not.toContain('postMessage(msg, "*")');
			expect(body).not.toContain("postMessage(msg, '*')");
			// Every post goes through the single `post` helper, which is bound to
			// the validated origin. Assert that funnel still exists.
			expect(body).toContain("window.parent.postMessage(msg, parentOrigin)");
		});
	});
});
