/**
 * Shared HMAC-SHA-256 primitives.
 *
 * Before this module existed the same three helpers — key import, hex encode,
 * constant-time compare — were reimplemented in `webhook-sig.ts`, `ip-hash.ts`
 * and `spam/heuristics.ts` (the last with its own *inlined* compare loop).
 * Three copies of security-critical code is three chances to fix a bug in only
 * two places, so they all now delegate here.
 *
 * Also provides the signed-token primitive used for stateless OAuth state:
 * `signPayload` / `verifyPayload`. That pair replaces a KV round-trip with a
 * signature, which matters because Cloudflare's free-tier KV write quota is
 * 1000/day scoped to the operator's *entire account* — an unauthenticated
 * endpoint that writes KV per request is an account-wide outage primitive.
 *
 * Not a JWT. No `alg` header, so there is no algorithm-confusion surface: the
 * algorithm is fixed by this code, not declared by the token.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const importHmacKey = (
	secret: string,
	usages: ("sign" | "verify")[] = ["sign"],
): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		usages,
	);

export const hexEncode = (buf: ArrayBuffer): string =>
	Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);

/** HMAC-SHA-256 of `message` under `secret`, hex-encoded (64 chars). */
export const hmacHex = async (
	secret: string,
	message: string,
): Promise<string> => {
	const key = await importHmacKey(secret);
	return hexEncode(
		await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
	);
};

/**
 * Length-independent constant-time string compare. The tokens we mint are
 * fixed-length, so the early length branch doesn't leak anything useful. A
 * naive `===` short-circuits at the first mismatched byte and is observable
 * via response timing — over enough requests an attacker recovers the token
 * byte-by-byte. Use this for every secret comparison.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
};

/**
 * base64url (RFC 4648 §5), unpadded. Goes through TextEncoder rather than
 * `btoa(str)` directly so non-ASCII payload content survives — `btoa` throws
 * on any code point above U+00FF.
 */
export const base64UrlEncode = (s: string): string => {
	let bin = "";
	for (const b of encoder.encode(s)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Inverse of `base64UrlEncode`. Returns null on anything malformed. */
export const base64UrlDecode = (s: string): string | null => {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return decoder.decode(bytes);
	} catch {
		return null;
	}
};

/** Payloads must carry their own mint time so `verifyPayload` can age them out. */
export type SignedPayload = { created_at: number };

/**
 * Sign a JSON payload into a compact `<base64url(json)>.<hex-sig>` token.
 *
 * The signature covers the *encoded* payload, not the object, so verification
 * never has to re-serialize (which would make the result depend on key order
 * and let a re-encode mismatch reject a genuine token).
 */
export const signPayload = async <T extends SignedPayload>(
	secret: string,
	payload: T,
): Promise<string> => {
	const body = base64UrlEncode(JSON.stringify(payload));
	return `${body}.${await hmacHex(secret, body)}`;
};

/**
 * Verify and decode a `signPayload` token.
 *
 * Returns null — never throws, never distinguishes the failure mode — on: a
 * malformed token, a bad signature, unparseable JSON, a missing/non-numeric
 * `created_at`, an expired token, or one minted in the future beyond the
 * allowed clock skew.
 *
 * `maxAgeMs` is mandatory: without it a signed token is valid forever, and the
 * caller almost always wants the freshness bound rather than remembering to
 * add it. A future-dated token is rejected too, so a client can't extend its
 * own token's life by post-dating the payload it never controlled anyway.
 */
export const verifyPayload = async <T extends SignedPayload>(
	secret: string,
	token: string,
	opts: { maxAgeMs: number; now?: number; clockSkewMs?: number },
): Promise<T | null> => {
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	// HMAC-SHA-256 hex is exactly 64 chars. Reject obvious garbage before
	// feeding arbitrary-length input to the compare.
	if (!/^[0-9a-f]{64}$/i.test(sig)) return null;

	const expected = await hmacHex(secret, body);
	if (!constantTimeEqual(expected, sig.toLowerCase())) return null;

	const json = base64UrlDecode(body);
	if (json === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;

	const createdAt = (parsed as { created_at?: unknown }).created_at;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;

	const now = opts.now ?? Date.now();
	const skew = opts.clockSkewMs ?? 60_000;
	const age = now - createdAt;
	if (age > opts.maxAgeMs) return null;
	if (age < -skew) return null;

	return parsed as T;
};
