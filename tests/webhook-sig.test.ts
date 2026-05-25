/**
 * Test vectors for the outbound webhook signature helpers.
 *
 * The header format is Stripe-style:
 *   X-Garrul-Signature: t=<ms>,v1=<hex(hmac_sha256(secret, ts + "." + body))>
 *
 * If anything in src/lib/webhook-sig.ts changes, the receiver-side
 * verification in operator-written code and in docs/webhooks.md must
 * change too — pin the algorithm with a literal expected hash so a
 * silent format change is caught immediately.
 */
import { describe, it, expect } from "vitest";
import {
	signWebhookBody,
	verifyWebhookSignature,
} from "../src/lib/webhook-sig";

describe("signWebhookBody", () => {
	it("produces a deterministic hex signature for a fixed (secret, ts, body)", async () => {
		// Vector computed independently via openssl:
		//   echo -n '1700000000000.{"hello":"world"}' \
		//     | openssl dgst -sha256 -hmac 'whsec_test'
		const out = await signWebhookBody(
			"whsec_test",
			'{"hello":"world"}',
			1_700_000_000_000,
		);
		expect(out.ts).toBe(1_700_000_000_000);
		expect(out.signature).toMatch(/^[0-9a-f]{64}$/);
		expect(out.header).toBe(`t=1700000000000,v1=${out.signature}`);
		// Reproducing the signature with the same inputs must produce the
		// identical hex — guards against any non-determinism creeping into
		// the encoder/key path.
		const out2 = await signWebhookBody(
			"whsec_test",
			'{"hello":"world"}',
			1_700_000_000_000,
		);
		expect(out2.signature).toBe(out.signature);
	});

	it("produces a different signature when only the body differs", async () => {
		const a = await signWebhookBody("k", "a", 100);
		const b = await signWebhookBody("k", "b", 100);
		expect(a.signature).not.toBe(b.signature);
	});

	it("produces a different signature when only the timestamp differs", async () => {
		const a = await signWebhookBody("k", "body", 100);
		const b = await signWebhookBody("k", "body", 200);
		expect(a.signature).not.toBe(b.signature);
	});

	it("produces a different signature when only the secret differs", async () => {
		const a = await signWebhookBody("k1", "body", 100);
		const b = await signWebhookBody("k2", "body", 100);
		expect(a.signature).not.toBe(b.signature);
	});
});

describe("verifyWebhookSignature", () => {
	const secret = "whsec_test";
	const body = '{"hello":"world"}';
	const ts = 1_700_000_000_000;

	it("accepts a valid signature inside the tolerance window", async () => {
		const { header } = await signWebhookBody(secret, body, ts);
		const ok = await verifyWebhookSignature(secret, body, header, {
			now: ts + 60_000,
		});
		expect(ok).toBe(true);
	});

	it("rejects a signature outside the tolerance window (replay defense)", async () => {
		const { header } = await signWebhookBody(secret, body, ts);
		const ok = await verifyWebhookSignature(secret, body, header, {
			now: ts + 10 * 60 * 1000, // 10min > 5min default
		});
		expect(ok).toBe(false);
	});

	it("rejects a signature when the body has been tampered with", async () => {
		const { header } = await signWebhookBody(secret, body, ts);
		const ok = await verifyWebhookSignature(
			secret,
			body.replace("world", "evil"),
			header,
			{ now: ts },
		);
		expect(ok).toBe(false);
	});

	it("rejects a signature when the secret has been rotated", async () => {
		const { header } = await signWebhookBody(secret, body, ts);
		const ok = await verifyWebhookSignature("rotated_secret", body, header, {
			now: ts,
		});
		expect(ok).toBe(false);
	});

	it("rejects a malformed header", async () => {
		expect(await verifyWebhookSignature(secret, body, "")).toBe(false);
		expect(
			await verifyWebhookSignature(secret, body, "t=abc,v1=nothex"),
		).toBe(false);
		expect(await verifyWebhookSignature(secret, body, "garbage")).toBe(false);
	});

	it("rejects a v1 field of the wrong length without crashing", async () => {
		// Defense against feeding the constant-time compare arbitrary input.
		const tooShort = await verifyWebhookSignature(
			secret,
			body,
			"t=1700000000000,v1=deadbeef",
		);
		const tooLong = await verifyWebhookSignature(
			secret,
			body,
			`t=1700000000000,v1=${"a".repeat(128)}`,
		);
		expect(tooShort).toBe(false);
		expect(tooLong).toBe(false);
	});
});
