/**
 * SSRF defense for outbound URLs the operator controls (webhook
 * endpoints, future custom-receiver hooks).
 *
 * Cloudflare Workers' fetch resolves DNS for hostnames it dispatches, so
 * an attacker-controlled hostname *can* resolve to a private IP at
 * request time and this Worker can't intercept that. What we CAN do at
 * configuration time:
 *
 *   1. Parse the URL and reject any literal IP in the RFC1918 / loopback
 *      / link-local / IPv6 ULA ranges — the most common typo + the most
 *      common naive attack.
 *   2. Reject obviously-internal hostnames (localhost, *.local,
 *      *.internal, host.docker.internal, *.cluster.local).
 *   3. Require https:// unless the operator opts into http via
 *      `allowHttp` (used for the legacy WEBHOOK_URL env var and for dev).
 *
 * This is a defense in depth — the operator is trusted to point this at
 * a sane destination. We're catching misconfigurations and naive attacks,
 * not a sophisticated adversary with control over DNS for an allowed
 * hostname.
 */

const LOOPBACK_HOSTS = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"host.docker.internal",
]);

const INTERNAL_TLDS = [".local", ".internal", ".localdomain", ".cluster.local"];

const isPrivateIPv4 = (host: string): boolean => {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return false;
	const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
	if (a > 255 || b > 255 || c > 255 || d > 255) return true; // malformed → treat as unsafe
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast + reserved
	return false;
};

const isPrivateIPv6 = (host: string): boolean => {
	// Node's URL.hostname keeps the brackets ("[::1]"); strip them before
	// matching. We don't parse the full address — match the obviously
	// private prefixes literally. Anything we don't recognize is allowed.
	let h = host.toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) {
		h = h.slice(1, -1);
	}
	if (h === "::" || h === "::1") return true;
	if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
	if (h.startsWith("fe80")) return true; // link-local
	if (h.startsWith("ff")) return true; // multicast
	if (h.startsWith("::ffff:")) {
		// IPv4-mapped IPv6 — reuse the v4 check on the trailing dotted-quad.
		const v4 = h.slice("::ffff:".length);
		if (v4.includes(".")) return isPrivateIPv4(v4);
	}
	return false;
};

export type UrlSafetyOptions = {
	allowHttp?: boolean;
};

export type UrlSafetyResult =
	| { ok: true; url: URL }
	| { ok: false; reason: string };

export const checkOutboundUrl = (
	raw: string,
	opts: UrlSafetyOptions = {},
): UrlSafetyResult => {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return { ok: false, reason: "invalid_url" };
	}
	if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
		return { ok: false, reason: "scheme_not_allowed" };
	}
	const host = u.hostname.toLowerCase();
	if (!host) return { ok: false, reason: "empty_host" };
	if (LOOPBACK_HOSTS.has(host)) {
		return { ok: false, reason: "loopback_host" };
	}
	for (const tld of INTERNAL_TLDS) {
		if (host.endsWith(tld)) return { ok: false, reason: "internal_tld" };
	}
	if (isPrivateIPv4(host)) return { ok: false, reason: "private_ipv4" };
	if (isPrivateIPv6(host)) return { ok: false, reason: "private_ipv6" };
	// Reject credentials in the URL — they'd be re-sent on every retry and
	// leak into our delivery log if we kept the full URL there.
	if (u.username || u.password) return { ok: false, reason: "url_credentials" };
	return { ok: true, url: u };
};
