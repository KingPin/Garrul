/**
 * IPv6 /64 normalization before hashing (M9).
 *
 * `hashIp` used to HMAC the address verbatim. A residential IPv6 allocation is a
 * /64 or larger, so one household could mint 2^64 distinct `ip_hash` values —
 * and every defense keyed on that hash counts per value: rate-limit buckets,
 * anonymous ghost identities, vote dedup, and `UNIQUE (comment_id,
 * reporter_ip_hash)` on reports. All of them were unenforceable over IPv6.
 */
import { describe, it, expect } from "vitest";
import { hashIp, normalizeIpForHash } from "../src/lib/ip-hash";

const SECRET = "test-secret";

describe("normalizeIpForHash", () => {
	it("leaves IPv4 alone", () => {
		expect(normalizeIpForHash("203.0.113.7")).toBe("203.0.113.7");
	});

	it("reduces an IPv6 address to its /64 prefix", () => {
		expect(normalizeIpForHash("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
	});

	it("agrees across every textual form of the same /64", () => {
		const forms = [
			"2001:db8::1",
			"2001:0db8:0000:0000:0000:0000:0000:0001",
			"2001:db8:0:0::ffff",
			"2001:DB8::dead:beef",
			"[2001:db8::1]",
			"2001:db8::1%eth0",
		];
		const out = forms.map(normalizeIpForHash);
		expect(new Set(out).size).toBe(1);
		expect(out[0]).toBe("2001:db8:0:0::/64");
	});

	it("keeps distinct /64s distinct", () => {
		expect(normalizeIpForHash("2001:db8:1:2::1")).not.toBe(
			normalizeIpForHash("2001:db8:1:3::1"),
		);
	});

	it("maps an IPv4-mapped address back to its dotted form", () => {
		// Otherwise every ::ffff: address collapses into one `::/64` bucket, and
		// the same client over v4 and v6-mapped would count twice.
		expect(normalizeIpForHash("::ffff:203.0.113.7")).toBe("203.0.113.7");
		expect(normalizeIpForHash("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
		expect(normalizeIpForHash("::ffff:cb00:7107")).toBe("203.0.113.7");
	});

	it("normalizes loopback and link-local without collapsing them together", () => {
		expect(normalizeIpForHash("::1")).toBe("0:0:0:0::/64");
		expect(normalizeIpForHash("fe80::1")).toBe("fe80:0:0:0::/64");
		expect(normalizeIpForHash("::1")).not.toBe(normalizeIpForHash("fe80::1"));
	});

	it("hashes an unparseable value verbatim rather than dropping it", () => {
		// A malformed cf-connecting-ip should land in *some* bucket — just not the
		// same one as everybody else's malformed value plus every real address.
		expect(normalizeIpForHash("2001:db8::zz::1")).toBe("2001:db8::zz::1");
		expect(normalizeIpForHash("1:2:3")).toBe("1:2:3");
		expect(normalizeIpForHash("0.0.0.0")).toBe("0.0.0.0");
	});
});

describe("hashIp", () => {
	it("gives one household one bucket", async () => {
		const a = await hashIp("2001:db8:abcd:1234::1", SECRET);
		const b = await hashIp("2001:db8:abcd:1234:ffff:ffff:ffff:ffff", SECRET);
		expect(a).toBe(b);
	});

	it("still separates neighbouring subscribers", async () => {
		const a = await hashIp("2001:db8:abcd:1234::1", SECRET);
		const b = await hashIp("2001:db8:abcd:1235::1", SECRET);
		expect(a).not.toBe(b);
	});

	it("keeps the secret load-bearing", async () => {
		expect(await hashIp("203.0.113.7", SECRET)).not.toBe(
			await hashIp("203.0.113.7", "other-secret"),
		);
	});
});
