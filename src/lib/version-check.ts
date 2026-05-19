/**
 * Passive "update available" check for the admin UI.
 *
 * The Worker checks the GitHub releases API at most once per 24h per cold
 * isolate (cached in TREE_CACHE under the `meta:` prefix). The check is
 * gated on /admin/* requests — public traffic never triggers a GitHub
 * fetch. Failures are swallowed silently; a `null`-marker is cached for
 * 1h so we don't hammer the API when it's unreachable.
 *
 * Optional GITHUB_TOKEN env var raises the unauth 60/hr rate limit if
 * shared Cloudflare egress IPs put us close to the cap.
 */
import type { MiddlewareHandler } from "hono";
import { CURRENT_VERSION, REPO_OWNER, REPO_NAME } from "./version.gen";
import { log } from "./log";

export type UpdateInfo = {
	current: string;
	latest: string;
	behind: boolean;
	url: string;
};

type CacheEntry =
	| { kind: "ok"; latest: string; url: string; fetchedAt: number }
	| { kind: "null"; fetchedAt: number };

type Env = {
	TREE_CACHE: KVNamespace;
	GITHUB_TOKEN?: string;
};

const CACHE_KEY = "meta:latest-release";
const OK_TTL_SEC = 86_400; // 24h
const NULL_TTL_SEC = 3_600; // 1h on failure, so we don't hammer GitHub

const stripV = (s: string): string => s.replace(/^v/, "");

const parts = (s: string): [number, number, number] | null => {
	const segs = stripV(s).split(/[-+]/)[0]?.split(".");
	if (!segs || segs.length !== 3) return null;
	const out: [number, number, number] = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const n = Number.parseInt(segs[i] as string, 10);
		if (!Number.isFinite(n)) return null;
		out[i] = n;
	}
	return out;
};

const isBehind = (current: string, latest: string): boolean => {
	const pc = parts(current);
	const pl = parts(latest);
	if (!pc || !pl) return false;
	for (let i = 0; i < 3; i++) {
		const cv = pc[i] as number;
		const lv = pl[i] as number;
		if (cv !== lv) return lv > cv;
	}
	return false;
};

const fetchFromGitHub = async (
	env: Env,
): Promise<{ latest: string; url: string } | null> => {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "garrul-version-check",
	};
	if (env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
	}
	try {
		const res = await fetch(
			`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
			{ headers },
		);
		if (!res.ok) {
			log.warn("version_check.failed", {
				status: res.status,
				owner: REPO_OWNER,
				repo: REPO_NAME,
			});
			return null;
		}
		const body: unknown = await res.json();
		if (
			typeof body !== "object" ||
			body === null ||
			typeof (body as { tag_name?: unknown }).tag_name !== "string"
		) {
			log.warn("version_check.malformed");
			return null;
		}
		const tag = (body as { tag_name: string }).tag_name;
		const url =
			typeof (body as { html_url?: unknown }).html_url === "string"
				? (body as { html_url: string }).html_url
				: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tag}`;
		return { latest: tag, url };
	} catch (err) {
		log.warn("version_check.failed", { error: (err as Error).message });
		return null;
	}
};

const readCache = async (env: Env): Promise<CacheEntry | null> => {
	const raw = await env.TREE_CACHE.get(CACHE_KEY);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof (parsed as { kind?: unknown }).kind === "string"
		) {
			return parsed as CacheEntry;
		}
		return null;
	} catch {
		return null;
	}
};

const writeCache = async (env: Env, entry: CacheEntry): Promise<void> => {
	const ttl = entry.kind === "ok" ? OK_TTL_SEC : NULL_TTL_SEC;
	await env.TREE_CACHE.put(CACHE_KEY, JSON.stringify(entry), {
		expirationTtl: ttl,
	});
};

/**
 * Returns the cached latest-release info, refreshing if the cache is
 * empty or stale. Read-only callers (admin layout) can pass the existing
 * cache through without forcing a refresh — see `peekCachedLatestVersion`
 * below.
 */
export const getCachedLatestVersion = async (
	env: Env,
): Promise<UpdateInfo | null> => {
	const existing = await readCache(env);
	if (existing && existing.kind === "ok") {
		return {
			current: CURRENT_VERSION,
			latest: existing.latest,
			behind: isBehind(CURRENT_VERSION, existing.latest),
			url: existing.url,
		};
	}
	if (existing && existing.kind === "null") {
		// Recent failure; respect the back-off.
		return null;
	}

	const fresh = await fetchFromGitHub(env);
	if (!fresh) {
		await writeCache(env, { kind: "null", fetchedAt: Date.now() });
		return null;
	}
	await writeCache(env, {
		kind: "ok",
		latest: fresh.latest,
		url: fresh.url,
		fetchedAt: Date.now(),
	});
	return {
		current: CURRENT_VERSION,
		latest: fresh.latest,
		behind: isBehind(CURRENT_VERSION, fresh.latest),
		url: fresh.url,
	};
};

/**
 * Cache-only read for downstream consumers (the admin layout). Never
 * triggers a GitHub fetch; the middleware refreshes asynchronously.
 */
export const peekCachedLatestVersion = async (
	env: Env,
): Promise<UpdateInfo | null> => {
	const existing = await readCache(env);
	if (!existing || existing.kind !== "ok") return null;
	return {
		current: CURRENT_VERSION,
		latest: existing.latest,
		behind: isBehind(CURRENT_VERSION, existing.latest),
		url: existing.url,
	};
};

/**
 * Middleware that ensures the cache is fresh on admin requests and emits
 * a warn log when the deployed Worker is behind. Wired in routes/admin.ts.
 */
export const versionCheckMiddleware = (): MiddlewareHandler<{
	Bindings: Env;
}> => {
	return async (c, next) => {
		const info = await getCachedLatestVersion(c.env);
		if (info && info.behind) {
			log.warn("version_check.behind", {
				current: info.current,
				latest: info.latest,
				url: info.url,
			});
		}
		await next();
	};
};
