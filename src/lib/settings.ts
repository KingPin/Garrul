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
import { MAX_DEPTH } from "./tree";

export type FlagKey =
	| "comments_enabled"
	| "reactions_enabled"
	| "votes_enabled"
	| "downvotes_enabled"
	| "page_reactions_enabled"
	| "page_votes_enabled"
	| "show_deleted_placeholders";

export type ResolvedFlags = Record<FlagKey, boolean>;

export type NumberKey =
	| "comments_per_page"
	| "replies_per_thread"
	| "auto_collapse_depth";

export type ResolvedNumbers = Record<NumberKey, number>;

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
	// When OFF (default) a deleted comment with no surviving replies is pruned
	// from the public tree — current behavior. When ON, every deleted comment
	// is kept and rendered as a placeholder ("[deleted]" / "[removed by a
	// moderator]"), so threads never silently lose entries.
	show_deleted_placeholders: {
		env: "SHOW_DELETED_PLACEHOLDERS",
		default: false,
	},
};

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

// Numeric display settings. Same precedence chain as FLAGS (DB > env >
// default), but each carries a [min, max] clamp so a junk or hostile value
// (negative, or a huge `comments_per_page` that would slice an enormous
// in-memory page) can't reach the slice/render paths.
const NUMBERS: Record<
	NumberKey,
	{ env: keyof Bindings; default: number; min: number; max: number }
> = {
	// Top-level threads per initial load and per Load-more click (server-side
	// slice in api.comments.ts).
	comments_per_page: { env: "COMMENTS_PER_PAGE", default: 25, min: 1, max: 200 },
	// Replies shown per parent before a "Show N more replies" button (widget).
	// 0 = show all replies.
	replies_per_thread: { env: "REPLIES_PER_THREAD", default: 3, min: 0, max: 100 },
	// A comment at depth >= this starts with its replies collapsed (widget).
	// 0 = never auto-collapse. Capped at the tree's MAX_DEPTH so the clamp
	// tracks the depth cap if it ever changes.
	auto_collapse_depth: {
		env: "AUTO_COLLAPSE_DEPTH",
		default: 3,
		min: 0,
		max: MAX_DEPTH,
	},
};

export const NUMBER_KEYS = Object.keys(NUMBERS) as NumberKey[];

/** Min/max clamp bounds for a numeric setting (used by the admin UI inputs). */
export const numberBounds = (
	key: NumberKey,
): { default: number; min: number; max: number } => {
	const { default: def, min, max } = NUMBERS[key];
	return { default: def, min, max };
};

const CACHE_KEY = "settings:flags";
const CACHE_KEY_NUMBERS = "settings:numbers";
// These resolve on the hot path (every comments GET reads numbers; config/counts
// read flags). They're a fixed pair of KV keys, so a write happens at most once
// per TTL window per edge colo — but on the free tier those add up. A longer TTL
// cuts that steady-state KV write rate; it's safe because the admin save path
// busts the key (bustFlagsCache/bustNumbersCache), so a real change still takes
// effect promptly rather than waiting out the TTL.
const CACHE_TTL_SEC = 300;

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

// Parse an integer setting and clamp it into [min, max]. Junk / empty / NaN
// falls back to `fallback` (which callers pass already inside the bounds).
export const parseIntSetting = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	if (raw == null) return fallback;
	const v = raw.trim();
	if (v === "") return fallback;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
};

const resolveNumbers = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedNumbers => {
	const out = {} as ResolvedNumbers;
	for (const key of NUMBER_KEYS) {
		const spec = NUMBERS[key];
		const raw =
			key in dbSettings
				? dbSettings[key]
				: (env[spec.env] as string | undefined);
		out[key] = parseIntSetting(raw, spec.default, spec.min, spec.max);
	}
	return out;
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

/**
 * Resolve all numeric display settings (DB override > env > default), KV-cached
 * under its own key so it doesn't disturb the boolean-flag cache entry/tests.
 */
export const loadNumbers = async (env: Bindings): Promise<ResolvedNumbers> => {
	const cached = await env.TREE_CACHE.get(CACHE_KEY_NUMBERS, "json").catch(
		() => null,
	);
	if (cached) return cached as ResolvedNumbers;
	const dbSettings = await getAllSettings(env.DB);
	const numbers = resolveNumbers(env, dbSettings);
	await env.TREE_CACHE.put(CACHE_KEY_NUMBERS, JSON.stringify(numbers), {
		expirationTtl: CACHE_TTL_SEC,
	}).catch(() => {});
	return numbers;
};

/** Drop the cached resolved numbers so the next read reflects a fresh save. */
export const bustNumbersCache = (env: Bindings): Promise<void> =>
	env.TREE_CACHE.delete(CACHE_KEY_NUMBERS).catch(() => {});
