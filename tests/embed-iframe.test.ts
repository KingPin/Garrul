/**
 * Tests for GET /embed/:slug — the iframe-variant comment page.
 *
 * Two things here are security-relevant and were previously unguarded: which
 * origins may frame the page (frame-ancestors, absent before, and it does not
 * fall back to default-src), and which origin receives its postMessage height
 * reports (`parent_origin`, previously accepted from anyone).
 */
import { describe, it, expect } from "vitest";
import worker from "../src/index";

type Env = Partial<{
	TURNSTILE_SITE_KEY: string;
	ALLOWED_ORIGINS: string;
	ENV: string;
	IP_HASH_SECRET: string;
	JWT_SECRET: string;
}>;

const SELF = "https://comments.test.example";

// src/lib/require-config.ts refuses to serve *any* route without these, so a
// harness that drives the real app has to supply them.
const REQUIRED_SECRETS = {
	IP_HASH_SECRET: "test-ip-hash-secret",
	JWT_SECRET: "test-jwt-secret",
} as const;

const fetchPage = async (path: string, env: Env = {}): Promise<Response> => {
	const merged: Env = {
		ALLOWED_ORIGINS: "https://blog.example.com",
		...REQUIRED_SECRETS,
		...env,
	};
	return worker.fetch(
		new Request(`${SELF}${path}`),
		merged as unknown as Record<string, unknown>,
		{} as ExecutionContext,
	);
};

const directive = (res: Response, name: string): string | undefined =>
	(res.headers.get("content-security-policy") ?? "")
		.split(";")
		.map((d) => d.trim())
		.find((d) => d.startsWith(name));

describe("GET /embed/:slug", () => {
	it("renders the widget mount with the slug", async () => {
		const res = await fetchPage("/embed/hello");
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('data-slug="hello"');
		expect(body).toContain("/embed.js");
	});

	it("rejects an over-long slug", async () => {
		const res = await fetchPage(`/embed/${"x".repeat(201)}`);
		expect(res.status).toBe(400);
	});

	describe("parent_origin allowlist", () => {
		it("honors an allowlisted origin", async () => {
			const res = await fetchPage(
				"/embed/hello?parent_origin=https%3A%2F%2Fblog.example.com",
			);
			expect(await res.text()).toContain('"https://blog.example.com"');
		});

		it("drops an origin that isn't allowlisted", async () => {
			// Before this, any site could frame the page with its own origin and
			// receive the height stream; the same unvalidated value is what made
			// the sibling Turnstile frame a token-harvesting primitive.
			const res = await fetchPage(
				"/embed/hello?parent_origin=https%3A%2F%2Fevil.example",
			);
			const body = await res.text();
			expect(body).not.toContain("evil.example");
			expect(body).toContain('var parentOrigin = "";');
		});

		it("drops a value that isn't a bare origin", async () => {
			const res = await fetchPage(
				"/embed/hello?parent_origin=https%3A%2F%2Fblog.example.com%2Fpath",
			);
			expect(await res.text()).toContain('var parentOrigin = "";');
		});

		it("accepts the Worker's own origin", async () => {
			const res = await fetchPage(
				`/embed/hello?parent_origin=${encodeURIComponent(SELF)}`,
			);
			expect(await res.text()).toContain(`"${SELF}"`);
		});

		it("does not fall back to document.referrer", async () => {
			const res = await fetchPage("/embed/hello");
			expect(await res.text()).not.toContain("document.referrer");
		});

		it("never posts to a wildcard target", async () => {
			const body = await fetchPage("/embed/hello").then((r) => r.text());
			expect(body).not.toContain('postMessage(msg, "*")');
			expect(body).not.toContain(', "*")');
		});
	});

	describe("frame-ancestors", () => {
		it("pins framing to ALLOWED_ORIGINS plus its own origin", async () => {
			const res = await fetchPage("/embed/hello");
			const fa = directive(res, "frame-ancestors");
			expect(fa).toBeDefined();
			expect(fa).toContain("https://blog.example.com");
			expect(fa).toContain(SELF);
		});

		it("does not name an unlisted origin", async () => {
			const res = await fetchPage("/embed/hello", {
				ALLOWED_ORIGINS: "https://only.example",
			});
			const fa = directive(res, "frame-ancestors") ?? "";
			expect(fa).toContain("https://only.example");
			expect(fa).not.toContain("blog.example.com");
		});

		it("relaxes to * under ENV=dev, matching the CORS gate", async () => {
			// A local instance normally has no ALLOWED_ORIGINS at all, and
			// lib/cors.ts waives the origin check under the same flag. Requested
			// over localhost because index.ts refuses to serve ENV=dev on any
			// other host.
			const res = await worker.fetch(
				new Request("http://localhost:8787/embed/hello"),
				{
					ENV: "dev",
					ALLOWED_ORIGINS: "",
					...REQUIRED_SECRETS,
				} as unknown as Record<string, unknown>,
				{} as ExecutionContext,
			);
			expect(res.status).toBe(200);
			expect(directive(res, "frame-ancestors")).toBe("frame-ancestors *");
		});
	});

	describe("?lang=", () => {
		it("lands on both <html lang> and data-lang", async () => {
			// Two consumers, not one: <html lang> is what assistive tech and the
			// browser's own UI read, data-lang is what the widget negotiates with.
			const res = await fetchPage("/embed/hello?lang=de");
			const body = await res.text();
			expect(body).toContain('<html lang="de">');
			expect(body).toContain('data-lang="de"');
		});

		it("defaults <html lang> to en when absent", async () => {
			const body = await fetchPage("/embed/hello").then((r) => r.text());
			expect(body).toContain('<html lang="en">');
			expect(body).toContain('data-lang=""');
		});

		it("narrows a regional tag to the locale that will render", async () => {
			const body = await fetchPage("/embed/hello?lang=de-AT").then((r) =>
				r.text(),
			);
			expect(body).toContain('<html lang="de">');
			// The raw request still goes to the widget — the server matches it
			// again, and a future de-AT registry entry should reach it intact.
			expect(body).toContain('data-lang="de-AT"');
		});

		it("claims English in <html lang> for a tag that has no strings", async () => {
			// Otherwise ?lang=xx tells a screen reader to switch voice for a frame
			// that came back in English.
			const body = await fetchPage("/embed/hello?lang=xx").then((r) => r.text());
			expect(body).toContain('<html lang="en">');
			expect(body).toContain('data-lang="xx"');
		});

		it("cannot break out of either attribute", async () => {
			// <html lang> can only be a registry key now, so the payload can only
			// reach data-lang — where the route's job is keeping it in its quotes.
			const res = await fetchPage(
				`/embed/hello?lang=${encodeURIComponent('"><script>alert(1)</script>')}`,
			);
			const body = await res.text();
			expect(body).not.toContain("<script>alert(1)</script>");
			expect(body).toContain('<html lang="en">');
			expect(body).toContain("&quot;&gt;&lt;script&gt;");
		});
	});

	it("keeps the ?api= override gated on the allowlist", async () => {
		// Regression guard on the pattern parent_origin was modelled after: an
		// unlisted override would load attacker-controlled JS into the frame,
		// which the CSP built from the same value would then permit.
		const res = await fetchPage("/embed/hello?api=https%3A%2F%2Fevil.example");
		const body = await res.text();
		expect(body).not.toContain("evil.example");
		expect(body).toContain(`data-api="${SELF}"`);
	});
});
