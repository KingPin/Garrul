/**
 * HMAC-SHA-256 of the client IP with IP_HASH_SECRET as the key.
 * Returns hex. Never log or store the raw IP; this is the only entry point.
 *
 * Cloudflare provides the client IP via the `cf-connecting-ip` request header.
 */
import { hmacHex } from "./hmac";

export const hashIp = async (ip: string, secret: string): Promise<string> =>
	hmacHex(secret, ip);

export const clientIp = (req: Request): string => {
	return req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
};
