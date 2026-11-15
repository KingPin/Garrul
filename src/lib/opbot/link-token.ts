import { randomHex } from "../oauth";

// One-time link tokens issued in the admin panel and redeemed by a bot command.
// Stored in OAUTH_STATE under a per-transport prefix so a Telegram token can
// never be redeemed for Discord and vice versa.
const LINK_TOKEN_TTL = 600; // 10 minutes
const LINK_TOKEN_RE = /^[0-9a-f]{48}$/;
const linkKey = (prefix: LinkPrefix, token: string): string => `${prefix}:link:${token}`;

export type LinkPrefix = "tg" | "dc";

export const issueLinkToken = async (
	kv: KVNamespace,
	prefix: LinkPrefix,
	user_id: string,
): Promise<string> => {
	const token = randomHex(24);
	await kv.put(
		linkKey(prefix, token),
		JSON.stringify({ user_id, created_at: Date.now() }),
		{ expirationTtl: LINK_TOKEN_TTL },
	);
	return token;
};

export const consumeLinkToken = async (
	kv: KVNamespace,
	prefix: LinkPrefix,
	token: string,
): Promise<string | null> => {
	if (!LINK_TOKEN_RE.test(token)) return null;
	const raw = await kv.get(linkKey(prefix, token));
	if (!raw) return null;
	await kv.delete(linkKey(prefix, token)); // one-time use
	try {
		const parsed = JSON.parse(raw) as { user_id?: string };
		return parsed.user_id ?? null;
	} catch {
		return null;
	}
};
