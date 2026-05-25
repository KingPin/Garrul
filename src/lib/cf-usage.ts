/**
 * Cloudflare GraphQL Analytics API client for the usage dashboard.
 *
 * The dashboard surfaces today's Workers / D1 / KV usage vs the
 * free-tier ceilings. The API is queried server-side with a token
 * stored in CF_API_TOKEN; results are cached in TREE_CACHE under
 * `cfusage:*` for CACHE_TTL_SEC so a tab-flapping admin can't drive
 * up our per-account analytics quota.
 *
 * Failure semantics: every panel is independent. If one of the three
 * sub-queries (workers / d1 / kv) returns an error, the others still
 * render — the caller gets `{ ok: false, error }` for the failing
 * panel only. This keeps the page useful even when one of Cloudflare's
 * APIs is intermittently down or the token is missing one scope.
 *
 * Free-tier ceilings (as of 2026-05) live in src/admin-ui/pages/usage.ts
 * next to the chart that renders them. Update both sites together if
 * the limits change.
 */
import { log } from "./log";

export const isUsageConfigured = (env: {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
}): boolean => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);

const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CF_VERIFY_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";
const CACHE_TTL_SEC = 300; // 5 minutes
const REQUEST_TIMEOUT_MS = 10_000;

export type Panel<T> =
	| { ok: true; data: T }
	| { ok: false; error: string };

export type UsageSnapshot = {
	asOf: number; // ms epoch
	workers: Panel<{ today: number; last30d: number }>;
	d1: Panel<{
		reads_today: number;
		writes_today: number;
		storage_bytes: number | null;
	}>;
	kv: Panel<{
		reads_today: number;
		writes_today: number;
		storage_bytes: number | null;
	}>;
};

type UsageEnv = {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	TREE_CACHE: KVNamespace;
};

const CACHE_KEY = "cfusage:snapshot";

// -- token verification ------------------------------------------------------

export type TokenVerifyResult =
	| { ok: true; status: "active" | "disabled" | "expired" }
	| { ok: false; error: string };

export const verifyToken = async (
	token: string,
): Promise<TokenVerifyResult> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(CF_VERIFY_URL, {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			return { ok: false, error: `http_${res.status}` };
		}
		const body = (await res.json().catch(() => null)) as
			| { success?: boolean; result?: { status?: string } }
			| null;
		if (!body?.success || !body.result?.status) {
			return { ok: false, error: "invalid_response" };
		}
		const status = body.result.status;
		if (status === "active" || status === "disabled" || status === "expired") {
			return { ok: true, status };
		}
		return { ok: false, error: `unknown_status:${status}` };
	} catch (err) {
		return { ok: false, error: String(err) };
	} finally {
		clearTimeout(timer);
	}
};

// -- date helpers ------------------------------------------------------------

const isoDay = (offsetDays: number): string => {
	const d = new Date(Date.now() - offsetDays * 86_400_000);
	return d.toISOString().slice(0, 10);
};

// -- GraphQL ----------------------------------------------------------------

type GraphQLBody = {
	query: string;
	variables: Record<string, unknown>;
};

const graphql = async <T>(
	token: string,
	body: GraphQLBody,
): Promise<T | { __error: string }> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(CF_GRAPHQL_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!res.ok) return { __error: `http_${res.status}` };
		const json = (await res.json().catch(() => null)) as
			| { data?: T; errors?: { message: string }[] }
			| null;
		if (!json) return { __error: "invalid_json" };
		if (json.errors && json.errors.length > 0) {
			return { __error: json.errors.map((e) => e.message).join("; ") };
		}
		if (!json.data) return { __error: "no_data" };
		return json.data;
	} catch (err) {
		return { __error: String(err) };
	} finally {
		clearTimeout(timer);
	}
};

const isError = <T>(v: T | { __error: string }): v is { __error: string } =>
	typeof v === "object" && v !== null && "__error" in v;

// -- Workers requests --------------------------------------------------------

type WorkersResult = {
	viewer: {
		accounts: {
			workersInvocationsAdaptive: { sum: { requests: number } }[];
		}[];
	};
};

const fetchWorkers = async (
	token: string,
	accountId: string,
): Promise<Panel<{ today: number; last30d: number }>> => {
	const today = isoDay(0);
	const last30 = isoDay(30);
	const query = `query ($accountTag: String!, $today: Date!, $last30: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      today: workersInvocationsAdaptive(
        filter: { date: $today }
        limit: 10
      ) { sum { requests } }
      last30d: workersInvocationsAdaptive(
        filter: { date_geq: $last30 }
        limit: 1000
      ) { sum { requests } }
    }
  }
}`;
	const data = await graphql<{
		viewer: {
			accounts: {
				today: { sum: { requests: number } }[];
				last30d: { sum: { requests: number } }[];
			}[];
		};
	}>(token, {
		query,
		variables: { accountTag: accountId, today, last30 },
	});
	if (isError(data)) return { ok: false, error: data.__error };
	const account = data.viewer.accounts[0];
	if (!account) return { ok: false, error: "account_not_found" };
	const sumOf = (rows: { sum: { requests: number } }[]): number =>
		rows.reduce((acc, r) => acc + (r.sum?.requests ?? 0), 0);
	return {
		ok: true,
		data: {
			today: sumOf(account.today),
			last30d: sumOf(account.last30d),
		},
	};
};

// -- D1 ----------------------------------------------------------------------

type D1Data = {
	reads_today: number;
	writes_today: number;
	storage_bytes: number | null;
};

const fetchD1 = async (
	token: string,
	accountId: string,
): Promise<Panel<D1Data>> => {
	const today = isoDay(0);
	const query = `query ($accountTag: String!, $today: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1AnalyticsAdaptiveGroups(
        filter: { date: $today }
        limit: 1000
      ) {
        sum {
          readQueries
          writeQueries
        }
      }
    }
  }
}`;
	const data = await graphql<{
		viewer: {
			accounts: {
				d1AnalyticsAdaptiveGroups: {
					sum: { readQueries: number; writeQueries: number };
				}[];
			}[];
		};
	}>(token, {
		query,
		variables: { accountTag: accountId, today },
	});
	if (isError(data)) return { ok: false, error: data.__error };
	const account = data.viewer.accounts[0];
	if (!account) return { ok: false, error: "account_not_found" };
	const rows = account.d1AnalyticsAdaptiveGroups;
	const reads = rows.reduce((a, r) => a + (r.sum?.readQueries ?? 0), 0);
	const writes = rows.reduce((a, r) => a + (r.sum?.writeQueries ?? 0), 0);
	// Storage size is not exposed via the analytics API; the dashboard
	// shows null and links to the Cloudflare console for that metric.
	return {
		ok: true,
		data: { reads_today: reads, writes_today: writes, storage_bytes: null },
	};
};

// -- KV ----------------------------------------------------------------------

type KvData = {
	reads_today: number;
	writes_today: number;
	storage_bytes: number | null;
};

const fetchKv = async (
	token: string,
	accountId: string,
): Promise<Panel<KvData>> => {
	const today = isoDay(0);
	const query = `query ($accountTag: String!, $today: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(
        filter: { date: $today, actionType_in: ["read", "write"] }
        limit: 1000
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;
	const data = await graphql<{
		viewer: {
			accounts: {
				kvOperationsAdaptiveGroups: {
					sum: { requests: number };
					dimensions: { actionType: string };
				}[];
			}[];
		};
	}>(token, {
		query,
		variables: { accountTag: accountId, today },
	});
	if (isError(data)) return { ok: false, error: data.__error };
	const account = data.viewer.accounts[0];
	if (!account) return { ok: false, error: "account_not_found" };
	const rows = account.kvOperationsAdaptiveGroups;
	let reads = 0;
	let writes = 0;
	for (const r of rows) {
		const n = r.sum?.requests ?? 0;
		if (r.dimensions.actionType === "read") reads += n;
		else if (r.dimensions.actionType === "write") writes += n;
	}
	return {
		ok: true,
		data: { reads_today: reads, writes_today: writes, storage_bytes: null },
	};
};

// -- public entry ------------------------------------------------------------

export const fetchUsageSnapshot = async (
	env: UsageEnv,
	opts: { skipCache?: boolean } = {},
): Promise<UsageSnapshot> => {
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
		throw new Error("usage_not_configured");
	}
	if (!opts.skipCache) {
		const cached = await env.TREE_CACHE.get(CACHE_KEY, "json").catch(
			() => null,
		);
		if (cached) return cached as UsageSnapshot;
	}
	const [workers, d1, kv] = await Promise.all([
		fetchWorkers(env.CF_API_TOKEN, env.CF_ACCOUNT_ID),
		fetchD1(env.CF_API_TOKEN, env.CF_ACCOUNT_ID),
		fetchKv(env.CF_API_TOKEN, env.CF_ACCOUNT_ID),
	]);
	const snapshot: UsageSnapshot = {
		asOf: Date.now(),
		workers,
		d1,
		kv,
	};
	// Best-effort cache write — never let a KV failure block the page.
	await env.TREE_CACHE.put(CACHE_KEY, JSON.stringify(snapshot), {
		expirationTtl: CACHE_TTL_SEC,
	}).catch((err) => {
		log.warn("usage.cache_put_failed", { error: String(err) });
	});
	return snapshot;
};
