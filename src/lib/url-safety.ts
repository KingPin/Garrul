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
 *      / link-local / CGNAT / IPv6 ULA ranges — the most common typo + the
 *      most common naive attack. An IPv6 literal that embeds an IPv4
 *      address (IPv4-mapped, IPv4-compatible, NAT64, 6to4) is resolved to
 *      that address and checked against the v4 list, since each of those
 *      actually routes to it.
 *   2. Reject obviously-internal hostnames (localhost, *.local,
 *      *.internal, host.docker.internal, *.cluster.local, *.localhost,
 *      *.home.arpa), after normalizing the trailing DNS root dot.
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

// `.localhost` is reserved to loopback by RFC 6761 §6.3 and resolvers honor it,
// so `db.localhost` is as reachable as `localhost`. `.home.arpa` is RFC 8375's
// home-network zone — the default on OpenWrt and most consumer routers.
const INTERNAL_TLDS = [
	".local",
	".internal",
	".localdomain",
	".cluster.local",
	".localhost",
	".home.arpa",
];

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
	// CGNAT 100.64/10 (RFC 6598). Not RFC1918, but it is carrier-internal
	// space: 100.100.100.100 is Alibaba Cloud's metadata service and Tailscale
	// hands out 100.64/10 addresses, so this reaches a private network.
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast + reserved
	return false;
};

/**
 * Expand an IPv6 literal (no brackets) into its 8 hextets, or null if it isn't
 * one. Handles `::` compression and a trailing dotted-quad.
 *
 * Prefix matching on the *text* is what made the old IPv4-mapped check dead
 * code: the WHATWG parser re-serializes IPv6 in compressed hex, so
 * `[::ffff:169.254.169.254]` arrives as `[::ffff:a9fe:a9fe]` and a
 * `.includes(".")` test can never fire. Matching on numbers instead means the
 * input spelling — compressed, expanded, or dotted — no longer matters.
 */
const parseIPv6 = (raw: string): number[] | null => {
	let s = raw;
	// A trailing dotted-quad ("::ffff:1.2.3.4") is legal IPv6 text. URL never
	// emits it, but this function is also handed raw operator input.
	const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (dotted) {
		const q = dotted.slice(2).map(Number) as [number, number, number, number];
		if (q.some((n) => n > 255)) return null;
		const hi = ((q[0] << 8) | q[1]).toString(16);
		const lo = ((q[2] << 8) | q[3]).toString(16);
		s = `${dotted[1]}${hi}:${lo}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	let groups: string[];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		groups = head;
	} else {
		// `::` must stand in for at least one all-zero group.
		if (head.length + tail.length > 7) return null;
		groups = [
			...head,
			...new Array<string>(8 - head.length - tail.length).fill("0"),
			...tail,
		];
	}
	const out: number[] = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		out.push(Number.parseInt(g, 16));
	}
	return out;
};

/**
 * The dotted-quad an IPv6 address embeds, for the transition mechanisms that
 * actually route to IPv4, or null if it embeds none. Each of these reaches an
 * IPv4 destination, so the v4 blocklist has to apply to them.
 */
const embeddedIPv4 = (h: number[]): string | null => {
	const quad = (hi: number, lo: number): string =>
		`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	const zeroTo = (n: number): boolean => h.slice(0, n).every((x) => x === 0);
	// ::ffff:a.b.c.d — IPv4-mapped (RFC 4291 §2.5.5.2). The bypass this fix
	// closes: [::ffff:169.254.169.254] is EC2's IMDS.
	if (zeroTo(5) && h[5] === 0xffff) return quad(h[6]!, h[7]!);
	// ::a.b.c.d — deprecated IPv4-compatible. Also catches :: and ::1, which
	// land on 0.0.0.0 / 0.0.0.1 and are blocked as `a === 0`.
	if (zeroTo(6)) return quad(h[6]!, h[7]!);
	// 64:ff9b::a.b.c.d — well-known NAT64 prefix (RFC 6052). A NAT64 gateway
	// translates these straight onto the v4 address.
	if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
		return quad(h[6]!, h[7]!);
	}
	// 2002:a.b.c.d:: — 6to4 (RFC 3056), v4 in hextets 1-2.
	if (h[0] === 0x2002) return quad(h[1]!, h[2]!);
	return null;
};

const isPrivateIPv6 = (host: string): boolean => {
	// URL.hostname keeps the brackets ("[::1]"); strip them before parsing.
	let h = host.toLowerCase();
	if (h.startsWith("[") && h.endsWith("]")) {
		h = h.slice(1, -1);
	}
	const g = parseIPv6(h);
	if (!g) return false; // not an IPv6 literal — nothing to say about it
	const v4 = embeddedIPv4(g);
	if (v4 !== null) return isPrivateIPv4(v4);
	if (g.every((x) => x === 0)) return true; // ::
	if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
	// fe80::/10 is fe80-febf, not just fe80: the old startsWith("fe80") let
	// fe90::1 and febf::1 through.
	if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
	if (g[0]! >> 8 === 0xff) return true; // ff00::/8 multicast
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
	// Case was the only normalization here, and a trailing root dot survives the
	// URL parser: `localhost.` and `server.local.` resolve exactly like their
	// dotless forms while matching neither LOOPBACK_HOSTS nor any endsWith(tld).
	// Stripping every trailing dot also covers `localhost..`, which some
	// resolvers still accept.
	const host = u.hostname.toLowerCase().replace(/\.+$/, "");
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
