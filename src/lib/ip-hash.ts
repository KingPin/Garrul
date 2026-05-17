/**
 * HMAC-SHA-256 of the client IP with IP_HASH_SECRET as the key.
 * Returns hex. Never log or store the raw IP; this is the only entry point.
 *
 * Cloudflare provides the client IP via the `cf-connecting-ip` request header.
 */
const encoder = new TextEncoder();

export const hashIp = async (ip: string, secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
	return Array.from(new Uint8Array(sig), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
};

export const clientIp = (req: Request): string => {
	return req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
};
