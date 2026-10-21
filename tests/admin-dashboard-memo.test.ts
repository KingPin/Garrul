/**
 * The dashboard's aggregates are memoized per D1 binding for a minute, so a
 * refresh does not re-count every comment. Real SQLite via the admin harness.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";

afterEach(() => {
	vi.useRealTimers();
});

describe("GET /admin dashboard memo", () => {
	it("runs the aggregates once a minute", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { env, request } = adminHarness();
		const prepare = vi.spyOn(env.DB, "prepare");
		const statsReads = () =>
			prepare.mock.calls.filter(([sql]) => String(sql).includes("total_comments")).length;

		expect((await request("/admin")).status).toBe(200);
		expect((await request("/admin")).status).toBe(200);
		expect(statsReads()).toBe(1);

		vi.setSystemTime(Date.now() + 60_001);
		expect((await request("/admin")).status).toBe(200);
		expect(statsReads()).toBe(2);
	});
});
