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
