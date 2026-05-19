/**
 * Heuristic unit tests. Pure logic + one D1 stub for isFirstComment.
 *
 * These are the lightweight, always-on-if-configured signals from
 * src/lib/spam/heuristics.ts. They're called BEFORE the (potentially
 * paid) classifier adapter, so coverage here pays off in two ways:
 * faster regressions and protection against accidentally weakening
 * the precision of the form-ts HMAC check.
 */
import { describe, it, expect } from "vitest";
import {
	countLinks,
	isFirstComment,
	signFormTimestamp,
	verifyFormTimestamp,
} from "../src/lib/spam/heuristics";

const SECRET = "test-secret-do-not-use-anywhere-real";

describe("countLinks", () => {
	it("returns 0 for empty input", () => {
		expect(countLinks("")).toBe(0);
	});
	it("counts a single https URL", () => {
		expect(countLinks("see https://example.com today")).toBe(1);
	});
	it("counts http, https, and mailto", () => {
		const md = "a http://a.b and https://c.d and mailto:x@y.z";
		expect(countLinks(md)).toBe(3);
	});
	it("counts URLs even inside markdown link syntax", () => {
		expect(countLinks("[x](https://a.b) and [y](https://c.d)")).toBe(2);
	});
	it("ignores plain text that looks like a domain but has no scheme", () => {
		expect(countLinks("a.b.c is not a link, neither is www.x.y")).toBe(0);
	});
});

describe("signFormTimestamp / verifyFormTimestamp", () => {
	it("a freshly signed token verifies after enough elapsed time", async () => {
		const t0 = 1_000_000;
		const token = await signFormTimestamp(t0, SECRET);
		const v = await verifyFormTimestamp(token, SECRET, t0 + 2000, 1000);
		expect(v.flag).toBe(false);
	});

	it("flags submissions faster than minMs", async () => {
		const t0 = 1_000_000;
		const token = await signFormTimestamp(t0, SECRET);
		const v = await verifyFormTimestamp(token, SECRET, t0 + 500, 1000);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.too_fast");
	});

	it("flags missing token", async () => {
		const v = await verifyFormTimestamp(undefined, SECRET, 1, 1);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.missing");
	});

	it("flags malformed token (no dot)", async () => {
		const v = await verifyFormTimestamp("garbage", SECRET, 1, 1);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.malformed");
	});

	it("flags a forged signature", async () => {
		const token = await signFormTimestamp(1_000_000, SECRET);
		const forged = `${token.slice(0, token.length - 1)}0`;
		const v = await verifyFormTimestamp(forged, SECRET, 1_002_000, 1000);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.bad_sig");
	});

	it("flags a token signed with the wrong secret", async () => {
		const token = await signFormTimestamp(1_000_000, "different-secret");
		const v = await verifyFormTimestamp(token, SECRET, 1_002_000, 1000);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.bad_sig");
	});

	it("flags a future-dated token (negative elapsed)", async () => {
		const token = await signFormTimestamp(2_000_000, SECRET);
		const v = await verifyFormTimestamp(token, SECRET, 1_000_000, 1000);
		expect(v.flag).toBe(true);
		expect(v.reason).toBe("form_ts.future");
	});
});

// Minimal D1 stub that returns null for the "is there any row" probe
// when the userId has not been seen, and a row otherwise. We only
// implement the prepare/bind/first surface that isFirstComment uses.
type Bind = string | number | null;
class StubD1 {
	private seen = new Set<string>();
	mark(userId: string) {
		this.seen.add(userId);
	}
	prepare(_sql: string) {
		const seen = this.seen;
		return {
			bind(...args: Bind[]) {
				const userId = String(args[0]);
				return {
					async first<T>(): Promise<T | null> {
						return seen.has(userId) ? ({ one: 1 } as unknown as T) : null;
					},
				};
			},
		};
	}
}

describe("isFirstComment", () => {
	it("returns true when the user has no prior rows", async () => {
		const db = new StubD1() as unknown as D1Database;
		expect(await isFirstComment(db, "user-1")).toBe(true);
	});
	it("returns false when the user has at least one prior row", async () => {
		const stub = new StubD1();
		stub.mark("user-1");
		const db = stub as unknown as D1Database;
		expect(await isFirstComment(db, "user-1")).toBe(false);
	});
});
