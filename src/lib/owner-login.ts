/**
 * Owner login: constants and the token hash shared by the issuing CLI
 * (scripts/owner-link.ts, node) and the redeeming route (routes/admin.ts,
 * Worker). Web Crypto only, so both runtimes load it unchanged.
 *
 * The token is 32 random bytes, base64url (43 chars). Only its SHA-256 is
 * stored. A plain hash is enough (no HMAC key): the input already carries 256
 * bits of entropy, so there is nothing to brute-force, and the CLI needs no
 * secret to compute it. Lookup is by hash equality in SQL, never a string
 * compare in JS.
 */
import { hexEncode } from "./hmac";

export const OWNER_PROVIDER = "owner";
export const OWNER_PROVIDER_ID = "primary";
export const OWNER_TOKEN_TTL_MS = 10 * 60 * 1000;
export const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const hashOwnerToken = async (token: string): Promise<string> =>
	hexEncode(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	);
