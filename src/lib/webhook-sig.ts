/**
 * HMAC-SHA-256 signing for outbound webhooks. Stripe-style header:
 *   X-Garrul-Signature: t=<ts>,v1=<hex(hmac_sha256(secret, ts + "." + body))>
 *
 * The timestamp is the (ms-epoch) moment we minted the signature, NOT
 * the event timestamp. Receivers must reject signatures whose `t` is
 * outside a small window relative to their own clock (we suggest ±5min)
 * — without this check a captured request can be replayed indefinitely
 * even though the HMAC is valid. Retries re-sign with a fresh `t` so a
 * delivery hours after the event still passes the window check.
 *
 * Verification is exported for tests + future Garrul-receives-from-self
 * scenarios; consumers in other languages implement the same algorithm
 * (see docs/webhooks.md for the recipe).
 */
import { constantTimeEqual } from "./oauth";

const encoder = new TextEncoder();

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);

const hexEncode = (buf: ArrayBuffer): string => {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		if (b === undefined) continue;
		out += b.toString(16).padStart(2, "0");
	}
	return out;
};

export const signWebhookBody = async (
	secret: string,
	body: string,
	tsMs: number = Date.now(),
): Promise<{ header: string; ts: number; signature: string }> => {
	const key = await importHmacKey(secret);
	const signed = `${tsMs}.${body}`;
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signed));
	const signature = hexEncode(sig);
	return {
		header: `t=${tsMs},v1=${signature}`,
		ts: tsMs,
		signature,
	};
};

type ParsedSig = { ts: number; v1: string };

const parseSignatureHeader = (header: string): ParsedSig | null => {
	let ts: number | null = null;
	let v1: string | null = null;
	for (const part of header.split(",")) {
		const eq = part.indexOf("=");
		if (eq < 1) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k === "t") {
			const n = Number(v);
			if (Number.isFinite(n)) ts = n;
		} else if (k === "v1") {
			// HMAC-SHA-256 hex output is exactly 64 chars. Reject obvious garbage
			// to avoid feeding the constant-time compare arbitrary-length input.
			if (/^[0-9a-f]{64}$/i.test(v)) v1 = v.toLowerCase();
		}
	}
	if (ts == null || v1 == null) return null;
	return { ts, v1 };
};

export const verifyWebhookSignature = async (
	secret: string,
	body: string,
	header: string,
	options: { toleranceMs?: number; now?: number } = {},
): Promise<boolean> => {
	const parsed = parseSignatureHeader(header);
	if (!parsed) return false;
	const tolerance = options.toleranceMs ?? 5 * 60 * 1000;
	const now = options.now ?? Date.now();
	if (Math.abs(now - parsed.ts) > tolerance) return false;
	const expected = await signWebhookBody(secret, body, parsed.ts);
	return constantTimeEqual(expected.signature, parsed.v1);
};
