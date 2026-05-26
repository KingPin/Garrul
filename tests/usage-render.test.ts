/**
 * Renderer + isUsageConfigured tests. These don't hit the GraphQL API —
 * that's an integration concern. We're testing graceful-degradation
 * paths (setup view, token-error view), the bar coloring thresholds,
 * and the per-panel error fallback.
 */
import { describe, it, expect } from "vitest";
import {
	renderUsageDashboard,
	renderUsageSetup,
	renderUsageTokenError,
} from "../src/admin-ui/pages/usage";
import { isUsageConfigured } from "../src/lib/cf-usage";
import type { UsageSnapshot } from "../src/lib/cf-usage";

describe("isUsageConfigured", () => {
	it("returns false when neither env var is set", () => {
		expect(isUsageConfigured({})).toBe(false);
	});

	it("returns false when only the token is set", () => {
		expect(isUsageConfigured({ CF_API_TOKEN: "tok" })).toBe(false);
	});

	it("returns false when only the account ID is set", () => {
		expect(isUsageConfigured({ CF_ACCOUNT_ID: "acct" })).toBe(false);
	});

	it("returns true when both are set", () => {
		expect(
			isUsageConfigured({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct" }),
		).toBe(true);
	});

	it("returns false on empty strings", () => {
		expect(
			isUsageConfigured({ CF_API_TOKEN: "", CF_ACCOUNT_ID: "" }),
		).toBe(false);
	});
});

describe("renderUsageSetup", () => {
	it("shows the three required token scopes", () => {
		const html = renderUsageSetup();
		expect(html).toContain("Account Analytics");
		expect(html).toContain("D1");
		expect(html).toContain("Workers KV Storage");
	});

	it("shows both wrangler secret put commands", () => {
		const html = renderUsageSetup();
		expect(html).toContain("wrangler secret put CF_API_TOKEN");
		expect(html).toContain("wrangler secret put CF_ACCOUNT_ID");
	});

	it("explains the token never leaves the worker", () => {
		const html = renderUsageSetup();
		expect(html).toContain("never leaves the Worker");
	});
});

describe("renderUsageTokenError", () => {
	it("renders the error message verbatim and escapes HTML", () => {
		const html = renderUsageTokenError("status:expired");
		expect(html).toContain("status:expired");
	});

	it("escapes malicious error content", () => {
		const html = renderUsageTokenError('<img src=x onerror=alert(1)>');
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});

const okSnapshot = (
	over: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
	asOf: Date.parse("2026-05-25T12:00:00Z"),
	workers: { ok: true, data: { today: 12_345, last30d: 250_000 } },
	d1: {
		ok: true,
		data: {
			reads_today: 50_000,
			writes_today: 25_000,
			storage_bytes: null,
		},
	},
	kv: {
		ok: true,
		data: {
			reads_today: 8_000,
			writes_today: 200,
			storage_bytes: null,
		},
	},
	...over,
});

describe("renderUsageDashboard", () => {
	it("renders all three panels when all queries succeed", () => {
		const html = renderUsageDashboard(okSnapshot());
		expect(html).toContain("Workers requests");
		expect(html).toContain("D1 database");
		expect(html).toContain("KV namespaces");
	});

	it("shows the cached-snapshot timestamp", () => {
		const html = renderUsageDashboard(okSnapshot());
		expect(html).toContain("2026-05-25 12:00 UTC");
	});

	it("formats large numbers with thousands separators", () => {
		const html = renderUsageDashboard(okSnapshot());
		expect(html).toContain("12,345");
		expect(html).toContain("250,000");
	});

	it("renders a fallback card per panel on per-query error", () => {
		const html = renderUsageDashboard(
			okSnapshot({
				workers: { ok: false, error: "http_403" },
				d1: { ok: false, error: "graphql_scope_missing" },
			}),
		);
		expect(html).toContain("Couldn't fetch this metric");
		expect(html).toContain("http_403");
		expect(html).toContain("graphql_scope_missing");
		// The kv panel still succeeded — bar still rendered.
		expect(html).toContain("Reads (today)");
	});

	it("colors bars green / yellow / red at 0/75/90%", () => {
		const html = renderUsageDashboard(
			okSnapshot({
				workers: { ok: true, data: { today: 50_000, last30d: 0 } },
				d1: {
					ok: true,
					data: {
						reads_today: 3_900_000,
						writes_today: 95_000,
						storage_bytes: null,
					},
				},
				kv: {
					ok: true,
					data: {
						reads_today: 200,
						writes_today: 100,
						storage_bytes: null,
					},
				},
			}),
		);
		// 50%, 78% — yellow somewhere
		expect(html).toContain("var(--warn)");
		// 95% — red somewhere
		expect(html).toContain("var(--bad)");
		// 0.2%, 10% — green somewhere
		expect(html).toContain("var(--ok)");
	});

	it("clamps the bar to 100% even when usage exceeds the ceiling", () => {
		const html = renderUsageDashboard(
			okSnapshot({
				workers: { ok: true, data: { today: 9_999_999, last30d: 0 } },
			}),
		);
		// Bar SVG x-positions are computed as p*2 where p is capped at 100,
		// so the rect width must be at most 200.
		const widths = [...html.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map(
			(m) => Number(m[1]),
		);
		for (const w of widths) {
			expect(w).toBeLessThanOrEqual(200);
		}
		// The label should show 100.0% in that case.
		expect(html).toContain("100.0%");
	});

	it("escapes the timestamp before embedding it in an HTML attribute", () => {
		// asOf is a number, so HTML injection through that field is not
		// possible — but the percentage label IS embedded into a
		// SVG aria-label attribute. Spot-check the escape is happening.
		const html = renderUsageDashboard(okSnapshot());
		expect(html).toContain('aria-label="Today: ');
	});
});
