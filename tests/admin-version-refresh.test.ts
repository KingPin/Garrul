/**
 * The "update available" refresh runs only after an admin or mod session has
 * been accepted. Before this, the old unconditional version-check middleware ran
 * two KV reads on every anonymous `GET /admin/anything`, and on an expired
 * entry every concurrent request fetched GitHub and wrote KV — an
 * unauthenticated path to the account-wide 1000 writes/day cap.
 */
import { describe, expect, it, vi } from "vitest";
import { ADMIN_SID, MOD_SID, adminHarness } from "./helpers/admin-sqlite";

describe("admin version refresh placement", () => {
	it("an anonymous admin request touches KV zero times", async () => {
		const { env, request } = adminHarness();
		const get = vi.spyOn(env.TREE_CACHE, "get");
		const put = vi.spyOn(env.TREE_CACHE, "put");
		const res = await request("/admin", { sid: "f".repeat(64) });
		expect(res.status).toBe(401);
		expect(get).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
	});

	it("an admin request reads both version keys (the refresh ran)", async () => {
		const { env, request } = adminHarness();
		const get = vi.spyOn(env.TREE_CACHE, "get");
		const res = await request("/admin", { sid: ADMIN_SID });
		expect(res.status).toBe(200);
		const keys = get.mock.calls.map((c) => c[0]);
		expect(keys).toContain("meta:latest-release");
		expect(keys).toContain("meta:recent-releases");
	});

	it("a mod request also triggers the refresh", async () => {
		const { env, request } = adminHarness();
		const get = vi.spyOn(env.TREE_CACHE, "get");
		await request("/admin/queue", { sid: MOD_SID });
		expect(get.mock.calls.map((c) => c[0])).toContain("meta:recent-releases");
	});
});
