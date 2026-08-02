/**
 * SSRF blocklist coverage for src/lib/url-safety.ts.
 *
 * This is configuration-time defense — the operator types a URL, we
 * reject obvious mistakes. We can't intercept DNS resolution that
 * Workers' fetch does at request time, so a hostname that resolves to a
 * private IP at fetch time is still reachable. See the module docstring
 * for the trust boundary.
 */
import { describe, it, expect } from "vitest";
import { checkOutboundUrl } from "../src/lib/url-safety";

const reject = (raw: string, opts?: { allowHttp?: boolean }): string => {
	const r = checkOutboundUrl(raw, opts);
	if (r.ok) throw new Error(`expected reject, got ok for ${raw}`);
	return r.reason;
};

describe("checkOutboundUrl scheme handling", () => {
	it("accepts https://", () => {
		const r = checkOutboundUrl("https://hooks.slack.com/services/T/B/X");
		expect(r.ok).toBe(true);
	});

	it("rejects http:// by default", () => {
		expect(reject("http://example.com/hook")).toBe("scheme_not_allowed");
	});

	it("accepts http:// when allowHttp=true (legacy WEBHOOK_URL path)", () => {
		const r = checkOutboundUrl("http://example.com/hook", { allowHttp: true });
		expect(r.ok).toBe(true);
	});

	it("rejects non-http schemes", () => {
		expect(reject("ftp://example.com/")).toBe("scheme_not_allowed");
		expect(reject("file:///etc/passwd")).toBe("scheme_not_allowed");
		expect(reject("javascript:alert(1)")).toBe("scheme_not_allowed");
		expect(reject("gopher://example.com/")).toBe("scheme_not_allowed");
	});

	it("rejects malformed URLs", () => {
		expect(reject("not-a-url")).toBe("invalid_url");
		expect(reject("https://")).toBe("invalid_url");
	});
});

describe("checkOutboundUrl SSRF blocklist", () => {
	const cases: Array<[string, string]> = [
		["https://localhost/hook", "loopback_host"],
		["https://Localhost:8080/", "loopback_host"],
		["https://host.docker.internal/x", "loopback_host"],
		["https://ip6-localhost/", "loopback_host"],
		["https://server.local/x", "internal_tld"],
		["https://kafka.internal/x", "internal_tld"],
		["https://kube-dns.cluster.local/x", "internal_tld"],
		["https://127.0.0.1/hook", "private_ipv4"],
		["https://10.0.0.5/hook", "private_ipv4"],
		["https://172.16.0.1/hook", "private_ipv4"],
		["https://172.20.0.1/hook", "private_ipv4"],
		["https://172.31.255.254/hook", "private_ipv4"],
		["https://192.168.1.1/hook", "private_ipv4"],
		["https://169.254.169.254/latest/meta-data/", "private_ipv4"], // EC2 IMDS
		["https://0.0.0.0/hook", "private_ipv4"],
		["https://224.0.0.1/hook", "private_ipv4"],
		["https://[::1]/hook", "private_ipv6"],
		["https://[fe80::1]/hook", "private_ipv6"],
		["https://[fd00::1]/hook", "private_ipv6"],
		["https://[fc00::1]/hook", "private_ipv6"],
		["https://[ff02::1]/hook", "private_ipv6"],
		["https://user:pass@example.com/hook", "url_credentials"],
	];
	for (const [url, reason] of cases) {
		it(`rejects ${url} → ${reason}`, () => {
			expect(reject(url)).toBe(reason);
		});
	}

	it("accepts a normal external HTTPS URL", () => {
		const cases = [
			"https://hooks.slack.com/services/T0/B0/X",
			"https://discord.com/api/webhooks/123/abc",
			"https://example.com/webhooks/garrul",
			"https://172.32.0.1/hook", // just outside RFC1918
		];
		for (const u of cases) {
			const r = checkOutboundUrl(u);
			expect(r.ok).toBe(true);
		}
	});

	it("rejects 172.16/12 boundary correctly (172.15 ok, 172.32 ok, 172.16-31 blocked)", () => {
		expect(checkOutboundUrl("https://172.15.0.1/").ok).toBe(true);
		expect(checkOutboundUrl("https://172.32.0.1/").ok).toBe(true);
		expect(reject("https://172.16.0.0/")).toBe("private_ipv4");
		expect(reject("https://172.31.0.0/")).toBe("private_ipv4");
	});
});

describe("checkOutboundUrl — IPv4-in-IPv6 bypasses", () => {
	// The old check tested `host.slice("::ffff:".length).includes(".")`, which
	// could never fire: the WHATWG parser re-serializes IPv6 in compressed hex,
	// so `[::ffff:169.254.169.254]` arrives as `[::ffff:a9fe:a9fe]`. Every one of
	// these was ALLOWED before this fix.
	const cases: Array<[string, string]> = [
		// IPv4-mapped, all three spellings of the same address (EC2/GCP IMDS).
		["https://[::ffff:169.254.169.254]/latest/meta-data/", "private_ipv6"],
		["https://[0:0:0:0:0:ffff:169.254.169.254]/", "private_ipv6"],
		["https://[::ffff:a9fe:a9fe]/", "private_ipv6"],
		["https://[::ffff:127.0.0.1]/", "private_ipv6"],
		["https://[::ffff:10.0.0.1]/", "private_ipv6"],
		["https://[::ffff:192.168.1.1]/", "private_ipv6"],
		// IPv4-compatible (deprecated ::/96).
		["https://[::127.0.0.1]/", "private_ipv6"],
		["https://[::169.254.169.254]/", "private_ipv6"],
		// NAT64 well-known prefix (RFC 6052) — a gateway translates this to v4.
		["https://[64:ff9b::169.254.169.254]/", "private_ipv6"],
		["https://[64:ff9b::a9fe:a9fe]/", "private_ipv6"],
		// 6to4 (RFC 3056): v4 lives in hextets 1-2.
		["https://[2002:7f00:1::]/", "private_ipv6"],
		["https://[2002:a9fe:a9fe::1]/", "private_ipv6"],
	];
	for (const [url, reason] of cases) {
		it(`rejects ${url} → ${reason}`, () => {
			expect(reject(url)).toBe(reason);
		});
	}

	it("still allows an IPv4-mapped PUBLIC address", () => {
		// The point is to apply the v4 list through the mapping, not to blanket-
		// reject mapped addresses.
		expect(checkOutboundUrl("https://[::ffff:93.184.216.34]/").ok).toBe(true);
	});

	it("covers the whole fe80::/10 link-local range, not just fe80:", () => {
		// startsWith("fe80") missed everything from fe81:: to febf::.
		expect(reject("https://[fe80::1]/")).toBe("private_ipv6");
		expect(reject("https://[fe90::1]/")).toBe("private_ipv6");
		expect(reject("https://[febf:ffff::1]/")).toBe("private_ipv6");
		// fec0:: is site-local (deprecated), outside /10 — not our concern here.
		expect(checkOutboundUrl("https://[2606:4700::1]/").ok).toBe(true);
	});

	it("accepts a normal public IPv6 literal", () => {
		expect(checkOutboundUrl("https://[2001:4860:4860::8888]/").ok).toBe(true);
	});
});

describe("checkOutboundUrl — CGNAT 100.64/10", () => {
	it("rejects carrier-internal space", () => {
		// 100.100.100.100 is Alibaba Cloud's metadata service; Tailscale hands
		// out addresses in this range.
		expect(reject("https://100.100.100.100/latest/meta-data/")).toBe("private_ipv4");
		expect(reject("https://100.64.0.1/")).toBe("private_ipv4");
		expect(reject("https://100.127.255.255/")).toBe("private_ipv4");
	});

	it("leaves the neighbouring public /10 boundaries alone", () => {
		expect(checkOutboundUrl("https://100.63.255.255/").ok).toBe(true);
		expect(checkOutboundUrl("https://100.128.0.1/").ok).toBe(true);
	});
});

describe("checkOutboundUrl — hostname normalization", () => {
	it("rejects a trailing-dot loopback host", () => {
		// `toLowerCase()` was the only normalization, so the DNS root dot — which
		// resolvers treat as identical — bypassed both the loopback set and every
		// endsWith(tld) check.
		expect(reject("https://localhost./")).toBe("loopback_host");
		expect(reject("https://localhost../")).toBe("loopback_host");
		expect(reject("https://host.docker.internal./")).toBe("loopback_host");
	});

	it("rejects a trailing-dot internal TLD", () => {
		expect(reject("https://server.local./")).toBe("internal_tld");
		expect(reject("https://kube-dns.cluster.local./")).toBe("internal_tld");
	});

	it("rejects the loopback and home-network reserved TLDs", () => {
		expect(reject("https://db.localhost/")).toBe("internal_tld"); // RFC 6761
		expect(reject("https://printer.home.arpa/")).toBe("internal_tld"); // RFC 8375
	});
});

describe("checkOutboundUrl — non-dotted IPv4 forms", () => {
	// The WHATWG URL parser normalizes decimal, hex, octal and short-form IPv4
	// to dotted-quad before we ever see the hostname, so the existing v4 list
	// covers them. Locked in as a regression test because the whole v4 defense
	// silently depends on that parser behavior.
	it("rejects decimal, hex, octal and short-form loopback", () => {
		expect(reject("https://2130706433/")).toBe("private_ipv4"); // 127.0.0.1
		expect(reject("https://0x7f000001/")).toBe("private_ipv4");
		expect(reject("https://017700000001/")).toBe("private_ipv4");
		expect(reject("https://127.1/")).toBe("private_ipv4");
	});

	it("rejects decimal-encoded IMDS", () => {
		expect(reject("https://2852039166/")).toBe("private_ipv4"); // 169.254.169.254
	});
});
