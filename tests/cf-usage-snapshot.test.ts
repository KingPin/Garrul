/**
 * fetchUsageSnapshot with the Cloudflare GraphQL API a stubbed fetch.
 *
 * Three panels are fetched in parallel and each fails on its own, so one
 * broken dataset still leaves the others on the /admin/usage page. The
 * snapshot is cached for five minutes; a failed cache write never blocks.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchUsageSnapshot } from "../src/lib/cf-usage";
import { makeKv } from "./helpers/admin-sqlite";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

// Answer by dataset name found in the query: [status, body] or a thrown error.
const serve = (answers: Record<"workers" | "d1" | "kv", [number, unknown] | Error>) => {
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		const { query, variables } = JSON.parse(String(init.body));
		expect(variables.accountTag).toBe(ACCOUNT);
		const key = query.includes("workersInvocations") ? "workers" : query.includes("d1Analytics") ? "d1" : "kv";
		const answer = answers[key as keyof typeof answers];
		if (answer instanceof Error) throw answer;
		return new Response(typeof answer[1] === "string" ? answer[1] : JSON.stringify(answer[1]), {
			status: answer[0],
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

const account = (a: unknown) => ({ data: { viewer: { accounts: [a] } } });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchUsageSnapshot", () => {
	it("sums each panel and serves the cached snapshot on the next call", async () => {
		const fetchMock = serve({
			workers: [
				200,
				account({
					today: [{ sum: { requests: 5 } }, { sum: { requests: 4 } }],
					last30d: [{ sum: { requests: 90 } }, { sum: { requests: 8 } }],
				}),
			],
			d1: [
				200,
				account({
					d1AnalyticsAdaptiveGroups: [
						{ sum: { readQueries: 7, writeQueries: 2 } },
						{ sum: { readQueries: 3, writeQueries: 5 } },
					],
				}),
			],
			kv: [
				200,
				account({
					kvOperationsAdaptiveGroups: [
						{ sum: { requests: 11 }, dimensions: { actionType: "read" } },
						{ sum: { requests: 4 }, dimensions: { actionType: "read" } },
						{ sum: { requests: 3 }, dimensions: { actionType: "write" } },
						{ sum: { requests: 1 }, dimensions: { actionType: "write" } },
						{ sum: { requests: 99 }, dimensions: { actionType: "delete" } },
					],
				}),
			],
		});
		const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, TREE_CACHE: makeKv() as unknown as KVNamespace };
		const snap = await fetchUsageSnapshot(env);
		expect(snap.workers).toEqual({ ok: true, data: { today: 9, last30d: 98 } });
		expect(snap.d1).toEqual({ ok: true, data: { reads_today: 10, writes_today: 7, storage_bytes: null } });
		expect(snap.kv).toEqual({ ok: true, data: { reads_today: 15, writes_today: 4, storage_bytes: null } });

		expect(await fetchUsageSnapshot(env)).toEqual(snap);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		await fetchUsageSnapshot(env, { skipCache: true });
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("reports each failing panel on its own and survives a failed cache write", async () => {
		serve({ workers: [403, {}], d1: [200, { errors: [{ message: "bad scope" }, { message: "x" }] }], kv: [200, "not json"] });
		const kv = makeKv();
		kv.put = async () => {
			throw new Error("kv quota");
		};
		const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, TREE_CACHE: kv as unknown as KVNamespace };
		const snap = await fetchUsageSnapshot(env);
		expect(snap.workers).toEqual({ ok: false, error: "http_403" });
		expect(snap.d1).toEqual({ ok: false, error: "bad scope; x" });
		expect(snap.kv).toEqual({ ok: false, error: "invalid_json" });
	});

	it("keeps a healthy panel's data next to two broken ones", async () => {
		serve({
			workers: [403, {}],
			d1: [200, { errors: [{ message: "bad scope" }] }],
			kv: [200, account({ kvOperationsAdaptiveGroups: [{ sum: { requests: 20 }, dimensions: { actionType: "read" } }] })],
		});
		const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, TREE_CACHE: makeKv() as unknown as KVNamespace };
		const snap = await fetchUsageSnapshot(env);
		expect(snap.workers).toEqual({ ok: false, error: "http_403" });
		expect(snap.d1).toEqual({ ok: false, error: "bad scope" });
		expect(snap.kv).toEqual({ ok: true, data: { reads_today: 20, writes_today: 0, storage_bytes: null } });
	});

	it("names a missing account, empty data and a network error", async () => {
		serve({ workers: [200, { data: { viewer: { accounts: [] } } }], d1: [200, {}], kv: new Error("offline") });
		const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: ACCOUNT, TREE_CACHE: makeKv() as unknown as KVNamespace };
		const snap = await fetchUsageSnapshot(env);
		expect(snap.workers).toEqual({ ok: false, error: "account_not_found" });
		expect(snap.d1).toEqual({ ok: false, error: "no_data" });
		expect(snap.kv).toEqual({ ok: false, error: "Error: offline" });
	});

	it("refuses to run unconfigured", async () => {
		await expect(fetchUsageSnapshot({ TREE_CACHE: makeKv() as unknown as KVNamespace })).rejects.toThrow(
			"usage_not_configured",
		);
	});
});
