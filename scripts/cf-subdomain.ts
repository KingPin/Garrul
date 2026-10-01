/**
 * The account's workers.dev subdomain, for scripts/setup.sh.
 *
 *   tsx scripts/cf-subdomain.ts get          print the subdomain; print nothing when
 *                                            the account has none (exit 0)
 *   tsx scripts/cf-subdomain.ts put <name>   register <name> as the subdomain
 *
 * Exit 2 when the lookup itself failed. "No subdomain" and "could not look" must
 * stay distinct: setup registers one on the first and must stop on the second,
 * and registering over an existing subdomain would rename it and break every
 * Worker URL on the account.
 *
 * Auth is wrangler's own: `wrangler auth token` returns the OAuth token from
 * `wrangler login`, or CLOUDFLARE_API_TOKEN when that is what is in use. The
 * account comes from CLOUDFLARE_ACCOUNT_ID, else `account_id` in wrangler.toml.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";
// A DNS label: what the Cloudflare API accepts for a workers.dev subdomain.
export const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type Fetch = typeof fetch;
type ApiBody = {
	success?: boolean;
	result?: { subdomain?: string } | null;
	errors?: { code?: number; message?: string }[];
};

export type Lookup = { ok: true; subdomain: string | null } | { ok: false; error: string };

const errorText = (b: ApiBody): string =>
	(b.errors ?? []).map((e) => `${e.message ?? "error"} [code: ${e.code ?? "?"}]`).join("; ") ||
	"unexpected response";

const call = async (
	fetchFn: Fetch,
	method: "GET" | "PUT",
	account: string,
	token: string,
	body?: unknown,
): Promise<{ status: number; json: ApiBody | null }> => {
	const res = await fetchFn(`${API}/accounts/${account}/workers/subdomain`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body === undefined ? null : JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json().catch(() => null)) as ApiBody | null };
};

export const getSubdomain = async (
	account: string,
	token: string,
	fetchFn: Fetch = fetch,
): Promise<Lookup> => {
	try {
		const { status, json } = await call(fetchFn, "GET", account, token);
		if (json?.success) return { ok: true, subdomain: json.result?.subdomain || null };
		// 10007: the account has not registered one yet. Anything else is a failure.
		if (json?.errors?.some((e) => e.code === 10007)) return { ok: true, subdomain: null };
		return { ok: false, error: json ? errorText(json) : `HTTP ${status}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
};

export const putSubdomain = async (
	account: string,
	token: string,
	name: string,
	fetchFn: Fetch = fetch,
): Promise<Lookup> => {
	if (!SUBDOMAIN_RE.test(name)) {
		return { ok: false, error: "use lowercase letters, digits and hyphens (no leading or trailing hyphen)" };
	}
	try {
		const { status, json } = await call(fetchFn, "PUT", account, token, { subdomain: name });
		if (json?.success) return { ok: true, subdomain: json.result?.subdomain ?? name };
		return { ok: false, error: json ? errorText(json) : `HTTP ${status}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
};

const accountId = (): string | null => {
	const env = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (env) return env;
	if (!existsSync("wrangler.toml")) return null;
	const m = readFileSync("wrangler.toml", "utf8").match(/^\s*account_id\s*=\s*["']([^"']+)["']/m);
	return m?.[1] ?? null;
};

const wranglerToken = (): string => {
	const out = execFileSync("wrangler", ["auth", "token", "--json"], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "ignore"],
	});
	return (JSON.parse(out.slice(out.indexOf("{"))) as { token: string }).token;
};

const main = async (): Promise<number> => {
	const [cmd, name] = process.argv.slice(2);
	const account = accountId();
	if (!account) {
		console.error("error: no Cloudflare account id (set CLOUDFLARE_ACCOUNT_ID or account_id in wrangler.toml)");
		return 2;
	}
	let token: string;
	try {
		token = wranglerToken();
	} catch {
		console.error("error: could not read the wrangler login (run: npx wrangler login)");
		return 2;
	}
	if (cmd === "get") {
		const r = await getSubdomain(account, token);
		if (!r.ok) {
			console.error(`error: could not read the workers.dev subdomain: ${r.error}`);
			return 2;
		}
		if (r.subdomain) console.log(r.subdomain);
		return 0;
	}
	if (cmd === "put" && name) {
		const r = await putSubdomain(account, token, name);
		if (!r.ok) {
			console.error(`error: could not register "${name}": ${r.error}`);
			return 3;
		}
		console.log(r.subdomain);
		return 0;
	}
	console.error("usage: cf-subdomain.ts get | put <name>");
	return 64;
};

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await main());
}
