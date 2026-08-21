/**
 * Tests for GET /.well-known/security.txt — RFC 9116 disclosure pointer.
 *
 * Drives the real Hono app via worker.fetch so the mounting + middleware
 * order is part of what's tested (same harness shape as agents-md.test.ts).
 * The settings chain is real: an empty D1 stub makes the env var the
 * resolved value, and a seeded settings row exercises the DB-wins path.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { contactUri } from "../src/routes/well-known";
import { asD1 } from "./helpers/d1";
import { makeKv } from "./helpers/kv";

type SettingsRow = { key: string; value: string };

/** D1 stub serving only `SELECT key, value FROM settings`. */
const makeDb = (rows: SettingsRow[] = []) =>
	asD1({
		prepare: () => ({
			all: async () => ({ results: rows }),
		}),
	});

const fetchSecurityTxt = async (init: {
	host?: string;
	env?: Record<string, unknown>;
	dbRows?: SettingsRow[];
}): Promise<Response> => {
	const url = `https://${init.host ?? "comments.test.example"}/.well-known/security.txt`;
	const env: Record<string, unknown> = {
		ALLOWED_ORIGINS: "https://blog.example.com",
		// src/lib/require-config.ts refuses to serve *any* route without these.
		IP_HASH_SECRET: "test-ip-hash-secret",
		JWT_SECRET: "test-jwt-secret",
		DB: makeDb(init.dbRows),
		TREE_CACHE: makeKv(),
		...init.env,
	};
	return worker.fetch(
		new Request(url),
		env as unknown as Record<string, unknown>,
		{} as ExecutionContext,
	);
};

describe("contactUri", () => {
	it("passes https:// and mailto: URIs through verbatim", () => {
		expect(contactUri("https://example.com/security")).toBe(
			"https://example.com/security",
		);
		expect(contactUri("mailto:sec@example.com")).toBe("mailto:sec@example.com");
	});

	it("wraps a bare email address in mailto:", () => {
		expect(contactUri("security@example.com")).toBe(
			"mailto:security@example.com",
		);
	});

	it("rejects http://, bare words and empty input", () => {
		expect(contactUri("http://example.com/security")).toBeNull();
		expect(contactUri("call me maybe")).toBeNull();
		expect(contactUri("")).toBeNull();
		expect(contactUri("   ")).toBeNull();
	});

	it("rejects degenerate URIs that pass the prefix check alone", () => {
		expect(contactUri("https://")).toBeNull();
		expect(contactUri("mailto:")).toBeNull();
		expect(contactUri("mailto:not-an-address")).toBeNull();
	});

	it("tolerates a query on a mailto: contact", () => {
		expect(contactUri("mailto:sec@example.com?subject=vuln")).toBe(
			"mailto:sec@example.com?subject=vuln",
		);
	});

	it("rejects a value with embedded whitespace (header-injection guard)", () => {
		expect(contactUri("https://example.com/\nContact: mailto:x@evil.com")).toBeNull();
		expect(contactUri("mailto:a@example.com b@example.com")).toBeNull();
	});
});

describe("GET /.well-known/security.txt", () => {
	it("404s when no contact is configured", async () => {
		const res = await fetchSecurityTxt({});
		expect(res.status).toBe(404);
	});

	it("404s when the configured value is not a usable contact", async () => {
		const res = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "just some words" },
		});
		expect(res.status).toBe(404);
	});

	it("serves a bare email from the env var as mailto:", async () => {
		const res = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "security@example.com" },
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("Contact: mailto:security@example.com\n");
	});

	it("serves an https:// contact verbatim", async () => {
		const body = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "https://example.com/security" },
		}).then((r) => r.text());
		expect(body).toContain("Contact: https://example.com/security\n");
	});

	it("a saved setting wins over the env var", async () => {
		const body = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "env@example.com" },
			dbRows: [{ key: "security_contact", value: "db@example.com" }],
		}).then((r) => r.text());
		expect(body).toContain("Contact: mailto:db@example.com\n");
	});

	it("Expires is in the future and inside the RFC's one-year cap", async () => {
		const res = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "security@example.com" },
		});
		const body = await res.text();
		const m = body.match(/^Expires: (.+)$/m);
		expect(m).not.toBeNull();
		const expires = Date.parse(m?.[1] ?? "");
		expect(expires).toBeGreaterThan(Date.now());
		expect(expires).toBeLessThan(Date.now() + 366 * 24 * 60 * 60 * 1000);
	});

	it("Canonical points at the requesting host", async () => {
		const body = await fetchSecurityTxt({
			host: "comments.alice.dev",
			env: { SECURITY_CONTACT: "security@example.com" },
		}).then((r) => r.text());
		expect(body).toContain(
			"Canonical: https://comments.alice.dev/.well-known/security.txt\n",
		);
	});

	it("CANONICAL_URL wins over Host for the Canonical field", async () => {
		const body = await fetchSecurityTxt({
			host: "other.example",
			env: {
				SECURITY_CONTACT: "security@example.com",
				CANONICAL_URL: "https://canonical.example",
			},
		}).then((r) => r.text());
		expect(body).toContain(
			"Canonical: https://canonical.example/.well-known/security.txt\n",
		);
	});

	it("sets plain-text, cache and nosniff headers; body ends in a newline", async () => {
		const res = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "security@example.com" },
		});
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		const body = await res.text();
		expect(body.endsWith("\n")).toBe(true);
		expect(body).toContain("Preferred-Languages: en\n");
	});

	it("does not require an Origin header (route is public, not /api/*)", async () => {
		// fetchSecurityTxt never sets Origin; a 200 here pins the exemption.
		const res = await fetchSecurityTxt({
			env: { SECURITY_CONTACT: "security@example.com" },
		});
		expect(res.status).toBe(200);
	});
});
