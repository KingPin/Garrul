/**
 * Shared HMAC primitives. The signed-token pair is what replaces the
 * unauthenticated KV write in the OAuth /start path, so its failure modes
 * matter more than its happy path — every rejection below is a case where
 * accepting the token would be a real vulnerability.
 */
import { describe, expect, it } from "vitest";
import {
	base64UrlDecode,
	base64UrlEncode,
	constantTimeEqual,
	hmacHex,
	signPayload,
	verifyPayload,
} from "../src/lib/hmac";

const SECRET = "test-secret-do-not-use";

describe("hmacHex", () => {
	it("is deterministic and 64 hex chars", async () => {
		const a = await hmacHex(SECRET, "message");
		const b = await hmacHex(SECRET, "message");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("changes with the key and with the message", async () => {
		const base = await hmacHex(SECRET, "message");
		expect(await hmacHex("other-secret", "message")).not.toBe(base);
		expect(await hmacHex(SECRET, "message!")).not.toBe(base);
	});
});

describe("constantTimeEqual", () => {
	it("matches identical strings and rejects differing ones", () => {
		expect(constantTimeEqual("abc", "abc")).toBe(true);
		expect(constantTimeEqual("abc", "abd")).toBe(false);
		expect(constantTimeEqual("abc", "ab")).toBe(false);
		expect(constantTimeEqual("", "")).toBe(true);
	});
});

describe("base64url", () => {
	it("round-trips ASCII and is unpadded / URL-safe", () => {
		const enc = base64UrlEncode("hello world??");
		expect(enc).not.toContain("=");
		expect(enc).not.toContain("+");
		expect(enc).not.toContain("/");
		expect(base64UrlDecode(enc)).toBe("hello world??");
	});

	it("round-trips non-ASCII, which plain btoa cannot", () => {
		// btoa("é") throws. A post title or display name can absolutely
		// contain this, so the TextEncoder path is load-bearing.
		const s = '{"name":"José 日本語 🎉"}';
		expect(base64UrlDecode(base64UrlEncode(s))).toBe(s);
	});

	it("returns null on non-base64url input rather than throwing", () => {
		expect(base64UrlDecode("not valid!")).toBeNull();
		expect(base64UrlDecode("a+b/c=")).toBeNull();
	});
});

describe("signPayload / verifyPayload", () => {
	const now = 1_700_000_000_000;
	const payload = { created_at: now, provider: "github", nonce: "abc" };

	it("round-trips a payload", async () => {
		const token = await signPayload(SECRET, payload);
		expect(await verifyPayload(SECRET, token, { maxAgeMs: 600_000, now })).toEqual(
			payload,
		);
	});

	it("rejects a token signed with a different secret", async () => {
		const token = await signPayload("attacker-secret", payload);
		expect(
			await verifyPayload(SECRET, token, { maxAgeMs: 600_000, now }),
		).toBeNull();
	});

	it("rejects a tampered payload", async () => {
		const token = await signPayload(SECRET, payload);
		const [body, sig] = token.split(".");
		expect(body).toBeDefined();
		// Re-encode a payload the attacker wants, keep the original signature.
		const forged = `${base64UrlEncode(
			JSON.stringify({ ...payload, provider: "google" }),
		)}.${sig}`;
		expect(forged).not.toBe(token);
		expect(
			await verifyPayload(SECRET, forged, { maxAgeMs: 600_000, now }),
		).toBeNull();
	});

	it("rejects a flipped signature bit", async () => {
		const token = await signPayload(SECRET, payload);
		const flipped = `${token.slice(0, -1)}${token.at(-1) === "0" ? "1" : "0"}`;
		expect(
			await verifyPayload(SECRET, flipped, { maxAgeMs: 600_000, now }),
		).toBeNull();
	});

	it("rejects malformed tokens without throwing", async () => {
		for (const bad of [
			"",
			".",
			"nodot",
			"body.",
			".sig",
			"body.tooshort",
			`body.${"z".repeat(64)}`, // right length, not hex
		]) {
			expect(
				await verifyPayload(SECRET, bad, { maxAgeMs: 600_000, now }),
			).toBeNull();
		}
	});

	it("expires a token past maxAgeMs", async () => {
		const token = await signPayload(SECRET, payload);
		expect(
			await verifyPayload(SECRET, token, {
				maxAgeMs: 600_000,
				now: now + 600_001,
			}),
		).toBeNull();
		// Still valid one ms inside the window.
		expect(
			await verifyPayload(SECRET, token, {
				maxAgeMs: 600_000,
				now: now + 599_999,
			}),
		).not.toBeNull();
	});

	it("rejects a future-dated token beyond the clock-skew allowance", async () => {
		const token = await signPayload(SECRET, { ...payload, created_at: now });
		// Verifier's clock is far behind the claimed mint time.
		expect(
			await verifyPayload(SECRET, token, {
				maxAgeMs: 600_000,
				now: now - 120_000,
				clockSkewMs: 60_000,
			}),
		).toBeNull();
		// Small skew is tolerated.
		expect(
			await verifyPayload(SECRET, token, {
				maxAgeMs: 600_000,
				now: now - 30_000,
				clockSkewMs: 60_000,
			}),
		).not.toBeNull();
	});

	it("rejects a validly-signed token with a missing or bad created_at", async () => {
		// A caller could otherwise mint a signature-valid token that never ages
		// out by simply omitting the field.
		for (const bad of [{}, { created_at: "soon" }, { created_at: null }]) {
			const body = base64UrlEncode(JSON.stringify(bad));
			const token = `${body}.${await hmacHex(SECRET, body)}`;
			expect(
				await verifyPayload(SECRET, token, { maxAgeMs: 600_000, now }),
			).toBeNull();
		}
	});

	it("rejects a validly-signed non-object payload", async () => {
		for (const bad of ["null", '"a string"', "42", "[1,2]"]) {
			const body = base64UrlEncode(bad);
			const token = `${body}.${await hmacHex(SECRET, body)}`;
			expect(
				await verifyPayload(SECRET, token, { maxAgeMs: 600_000, now }),
			).toBeNull();
		}
	});
});
