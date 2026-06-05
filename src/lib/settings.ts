/**
 * Hybrid feature-flag resolution.
 *
 * Garrul's configuration was historically env-var-only (per-deploy). This
 * layer adds a runtime override: a row in the `settings` D1 table beats the
 * matching env var, which in turn falls back to a hardcoded default.
 *
 *   precedence:  DB row  >  env var  >  default
 *
 * Operators flip these from the admin Settings page (writes a `settings`
 * row, no redeploy). Leaving a flag "inherit" writes no row, so the env var
 * / default still applies and existing installs are unaffected.
 *
 * Comment-level features default ON (preserve current behavior). The new
 * page-level features default OFF so upgrading doesn't surface new UI on an
 * instance that never opted in.
 *
 * The resolved object is cached in KV (TREE_CACHE) for a short TTL so the
 * hot path — GET /api/v1/config, hit on every widget mount — avoids a D1
 * read. The admin save path busts the cache. (An env-var change via redeploy
 * can be masked by a warm cache for up to the TTL; acceptable.)
 */
import type { Bindings } from "../index";
import { getAllSettings } from "../db/queries";

export type FlagKey =
	| "comments_enabled"
	| "reactions_enabled"
	| "votes_enabled"
	| "downvotes_enabled"
	| "page_reactions_enabled"
	| "page_votes_enabled";

export type ResolvedFlags = Record<FlagKey, boolean>;

// Each flag's env-var source and hardcoded default. `votes_enabled` /
// `downvotes_enabled` keep their legacy env names so existing wrangler.toml
// vars keep working.
const FLAGS: Record<FlagKey, { env: keyof Bindings; default: boolean }> = {
	comments_enabled: { env: "COMMENTS_ENABLED", default: true },
	reactions_enabled: { env: "REACTIONS_ENABLED", default: true },
	votes_enabled: { env: "VOTING_ENABLED", default: true },
	downvotes_enabled: { env: "DOWNVOTES_ENABLED", default: true },
	page_reactions_enabled: { env: "PAGE_REACTIONS_ENABLED", default: false },
	page_votes_enabled: { env: "PAGE_VOTES_ENABLED", default: false },
};

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

const CACHE_KEY = "settings:flags";
const CACHE_TTL_SEC = 60;

// Defaults-on/off boolish parse: present + falsy → false; anything else
// non-empty → true. Mirrors api.votes.ts / api.config.ts semantics so the
// widget, server gates, and admin UI all agree.
const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
	if (raw == null) return fallback;
	const v = raw.trim().toLowerCase();
	if (v === "") return fallback;
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	return true;
};

const resolve = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedFlags => {
	const out = {} as ResolvedFlags;
	for (const key of FLAG_KEYS) {
		const spec = FLAGS[key];
		if (key in dbSettings) {
			// DB row wins. Fall back to the default if the stored string is junk.
			out[key] = parseBool(dbSettings[key], spec.default);
		} else {
			out[key] = parseBool(env[spec.env] as string | undefined, spec.default);
		}
	}
	return out;
};

/**
 * Resolve all feature flags (DB override > env > default), KV-cached.
 */
export const loadFlags = async (env: Bindings): Promise<ResolvedFlags> => {
	const cached = await env.TREE_CACHE.get(CACHE_KEY, "json").catch(() => null);
	if (cached) return cached as ResolvedFlags;
	const dbSettings = await getAllSettings(env.DB);
	const flags = resolve(env, dbSettings);
	await env.TREE_CACHE.put(CACHE_KEY, JSON.stringify(flags), {
		expirationTtl: CACHE_TTL_SEC,
	}).catch(() => {});
	return flags;
};

/** Drop the cached resolved flags so the next read reflects a fresh save. */
export const bustFlagsCache = (env: Bindings): Promise<void> =>
	env.TREE_CACHE.delete(CACHE_KEY).catch(() => {});
