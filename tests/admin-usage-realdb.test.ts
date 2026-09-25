/**
 * GET /admin/usage with a Cloudflare token configured, against REAL SQLite.
 *
 * The token is verified before any GraphQL call, so a revoked or disabled
 * token renders a readable error page instead of cryptic GraphQL failures.
 * fetch is stubbed; no request leaves the process.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

// Answer each verify URL (account-scoped, then user-scoped) with [status, body].
const verifyWith = (account: [number, unknown], user: [number, unknown]) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const [status, body] = url.includes("/accounts/") ? account : user;
			return new Response(JSON.stringify(body), { status });
		}),
	);

const active = { success: true, result: { status: "active" } };

const usagePage = async (h: ReturnType<typeof adminHarness>) => {
	const res = await h.request("/admin/usage");
	expect(res.status).toBe(200);
	return res.text();
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GET /admin/usage with a token", () => {
	it("renders the dashboard from the cached snapshot once the token verifies", async () => {
		verifyWith([200, active], [500, {}]);
		const h = adminHarness({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT });
		const snapshot = {
			asOf: Date.UTC(2026, 0, 2, 3, 4),
			workers: { ok: true, data: { today: 5, last30d: 90 } },
			d1: { ok: true, data: { reads_today: 7, writes_today: 2, storage_bytes: null } },
			kv: { ok: false, error: "http_403" },
		};
		(h.env.TREE_CACHE as unknown as { store: Map<string, string> }).store.set(
			"cfusage:snapshot",
			JSON.stringify(snapshot),
		);
		const html = await usagePage(h);
		expect(html).toContain("<h2 style=\"margin-top:0\">Cloudflare usage</h2>");
		expect(html).toContain("2026-01-02 03:04 UTC");
		expect(html).not.toContain("token error");
	});

	it("shows a token error for a disabled token and for two failed probes", async () => {
		verifyWith([200, { success: true, result: { status: "disabled" } }], [500, {}]);
		const disabled = await usagePage(adminHarness({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT }));
		expect(disabled).toContain("Cloudflare usage — token error");
		expect(disabled).toContain("<code>status:disabled</code>");

		verifyWith([401, {}], [200, { success: false }]);
		const failed = await usagePage(adminHarness({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT }));
		expect(failed).toContain("<code>account:http_401 user:invalid_response</code>");
	});

	it("shows a token error when the snapshot itself throws", async () => {
		verifyWith([200, active], [500, {}]);
		const h = adminHarness({ CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT });
		const kv = h.env.TREE_CACHE as unknown as { get: (k: string, t?: string) => Promise<unknown> };
		const get = kv.get.bind(kv);
		kv.get = (key, type) => {
			if (key === "cfusage:snapshot") throw new Error("kv exploded");
			return get(key, type);
		};
		const html = await usagePage(h);
		expect(html).toContain("Cloudflare usage — token error");
		expect(html).toContain("Error: kv exploded");
	});
});
