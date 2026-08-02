/**
 * HMAC-SHA-256 of the client IP with IP_HASH_SECRET as the key.
 * Returns hex. Never log or store the raw IP; this is the only entry point.
 *
 * Cloudflare provides the client IP via the `cf-connecting-ip` request header.
 *
 * IPv6 is truncated to its /64 prefix before hashing. A residential IPv6
 * allocation is a /64 or larger, so hashing the full address gave one household
 * 2^64 distinct `ip_hash` values — and every defense keyed on that hash counts
 * per value: rate-limit buckets, anonymous ghost identities, vote dedup, and the
 * `UNIQUE (comment_id, reporter_ip_hash)` on reports. All of them were
 * unenforceable for any IPv6 client. /64 is the smallest unit an operator can
 * assume is one subscriber; going coarser (/48) would start grouping unrelated
 * customers of the same ISP.
 */
import { hmacHex } from "./hmac";

const HEXTET_RE = /^[0-9a-f]{1,4}$/;

// A fixed-width tuple rather than string[], so the /64 slice and the
// IPv4-mapped fold below can index into it without an undefined check on every
// hextet. The one cast that produces it is guarded by an explicit length test.
type Hextets = [string, string, string, string, string, string, string, string];

/**
 * Expand an IPv6 literal into exactly 8 hextets, or null if it doesn't parse.
 * Handles `::` elision and an embedded dotted-quad tail (`::ffff:1.2.3.4`).
 */
const expandIpv6 = (addr: string): Hextets | null => {
	let s = addr;

	// The low 32 bits may be written as a dotted quad. Fold it into two hextets
	// first so the elision maths below only has to deal with one notation.
	const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		// Number(undefined) is NaN, so the range test also covers a group the
		// compiler can't prove matched.
		const [a, b, c, d] = [v4[1], v4[2], v4[3], v4[4]].map(Number);
		const octets = [a, b, c, d];
		if (octets.some((o) => o === undefined || !Number.isInteger(o) || o > 255)) {
			return null;
		}
		const hi = (((a as number) << 8) | (b as number)).toString(16);
		const lo = (((c as number) << 8) | (d as number)).toString(16);
		s = `${s.slice(0, s.length - (v4[0]?.length ?? 0))}${hi}:${lo}`;
	}

	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

	let parts: string[];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		parts = head;
	} else {
		const fill = 8 - head.length - tail.length;
		if (fill < 1) return null;
		parts = [...head, ...Array<string>(fill).fill("0"), ...tail];
	}
	if (parts.length !== 8 || !parts.every((h) => HEXTET_RE.test(h))) return null;
	return parts as Hextets;
};

/** Drop leading zeros so `0db8` and `db8` land in the same bucket. */
const trimHextet = (h: string): string => parseInt(h, 16).toString(16);

/**
 * Canonicalize a client IP for hashing.
 *
 * IPv4 is returned as-is. IPv6 is reduced to its /64 prefix. An unparseable
 * value is hashed verbatim rather than rejected — a malformed
 * `cf-connecting-ip` should still land in *some* bucket, just not everyone's.
 */
export const normalizeIpForHash = (ip: string): string => {
	const raw = ip
		.trim()
		.toLowerCase()
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		// Link-local addresses can carry a zone id; it isn't part of the address.
		// split() always yields at least one element; the fallback is for tsc.
		.split("%")[0] ?? "";
	if (!raw.includes(":")) return raw;

	const parts = expandIpv6(raw);
	if (!parts) return raw;

	// IPv4-mapped (::ffff:a.b.c.d) is an IPv4 client wearing an IPv6 hat. Emit
	// the dotted form so it shares a bucket with the same client arriving over
	// v4 — and so every mapped address doesn't collapse into a single `::/64`.
	if (parts.slice(0, 5).every((h) => h === "0") && parts[5] === "ffff") {
		const hi = parseInt(parts[6], 16);
		const lo = parseInt(parts[7], 16);
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}

	return `${parts.slice(0, 4).map(trimHextet).join(":")}::/64`;
};

export const hashIp = async (ip: string, secret: string): Promise<string> =>
	hmacHex(secret, normalizeIpForHash(ip));

/**
 * The client IP as Cloudflare's edge reports it, or null when the header is
 * absent.
 *
 * The edge sets `cf-connecting-ip` on every request that reaches a Worker, so
 * an absent header means we were reached some other way — `wrangler dev`
 * against a local upstream, or a test harness. This used to fall back to a
 * literal `"0.0.0.0"`, which is worse than no answer: every header-less
 * request hashed to the *same* value, so they shared one rate-limit bucket,
 * one anonymous ghost identity, one vote-dedup row and one
 * `UNIQUE (comment_id, reporter_ip_hash)` slot. Returning null hands the
 * decision to the caller — see `requireIpHash`.
 */
export const clientIp = (req: Request): string | null =>
	req.headers.get("cf-connecting-ip");

// Stand-in used only when ENV=dev and the edge header is absent, so local
// development still exercises the hashing path end to end.
const DEV_CLIENT_IP = "127.0.0.1";

// Structural shape of the Hono context bits used here. Defined structurally
// rather than as Context<{Bindings: Bindings}> for the same reason
// src/lib/session.ts does it: callers add their own Variables and sub-paths,
// and the nominal form loses those invariance fights.
type IpHashCtx = {
	env: { IP_HASH_SECRET?: string | undefined; ENV?: string | undefined };
	req: { raw: Request };
};

const jsonError = (error: string, status: 400 | 500): Response =>
	new Response(JSON.stringify({ error }), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" },
	});

/**
 * Resolve the caller's `ip_hash`, or a Response explaining why we can't.
 *
 * Follows the `requireAdmin` idiom already used across the admin routes:
 *
 *     const ipHash = await requireIpHash(c);
 *     if (ipHash instanceof Response) return ipHash;
 *
 * Outside dev, a missing `cf-connecting-ip` is refused rather than folded into
 * a shared bucket. Every defense keyed on this hash exists to tell callers
 * apart; a value that cannot do that is not a safe default, it is a hole with
 * a plausible shape.
 *
 * The IP_HASH_SECRET check duplicates the startup guard in
 * `src/lib/require-config.ts` when the full app is mounted, and is kept
 * deliberately: route modules are mounted standalone in tests, and `hmacHex`
 * with an empty key throws inside WebCrypto — an anonymous 500 with a stack
 * trace, which is exactly the failure mode being removed here.
 */
export const requireIpHash = async (
	c: IpHashCtx,
): Promise<string | Response> => {
	const secret = c.env.IP_HASH_SECRET;
	if (!secret) return jsonError("server_misconfigured", 500);
	const ip =
		clientIp(c.req.raw) ?? (c.env.ENV === "dev" ? DEV_CLIENT_IP : null);
	if (!ip) return jsonError("no_client_ip", 400);
	return hashIp(ip, secret);
};
