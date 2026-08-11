/**
 * Feature-flag resolution tests (src/lib/settings.ts).
 *
 * The contract under test is the precedence chain:
 *
 *     DB row  >  env var  >  hardcoded default
 *
 * plus the KV cache behavior that fronts it (GET /api/v1/config is hit on
 * every widget mount, so loadFlags() must avoid a D1 read when warm and bust
 * cleanly on save).
 *
 * No Miniflare: a hand-rolled `settings` D1 stub + an in-memory KV stub, in
 * the same style as votes.test.ts.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { Requestable } from "./helpers/app";
import {
	loadFlags,
	loadNumbers,
	loadSettings,
	loadStrings,
	bustSettingsCache,
	parseIntSetting,
	parseStringSetting,
	FLAG_KEYS,
	NUMBER_KEYS,
	STRING_KEYS,
	numberBounds,
	stringOptions,
	type FlagKey,
	type NumberKey,
} from "../src/lib/settings";
import { reactions } from "../src/routes/api.reactions";
import { comments } from "../src/routes/api.comments";
import type { Bindings } from "../src/index";

// In-memory KV double for TREE_CACHE. Tracks delete calls so a test can prove
// bustSettingsCache() actually drops the resolved object.
const makeKv = () => {
	const store = new Map<string, string>();
	// Options passed to put(), by key. KV's free tier caps writes at 1000/day
	// *account wide*, and the entry re-populates once per TTL window per edge
	// colo, so the TTL is a quota decision worth pinning down in a test.
	const putOpts = new Map<string, { expirationTtl?: number }>();
	let deletes = 0;
	// Total put() calls, not distinct keys: the account-wide write cap counts
	// every write, so a test proving concurrent misses don't each write needs
	// the call count rather than the resulting store size.
	let puts = 0;
	return {
		store,
		putOpts,
		deletes: () => deletes,
		puts: () => puts,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(
			key: string,
			value: string,
			opts?: { expirationTtl?: number },
		) {
			puts++;
			store.set(key, value);
			putOpts.set(key, opts ?? {});
		},
		async delete(key: string) {
			deletes++;
			store.delete(key);
		},
	};
};

// D1 double exposing only what getAllSettings() needs: prepare().all() over
// `SELECT key, value FROM settings`. Counts reads so cache-hit tests can prove
// the DB was never touched.
const makeDb = (rows: Record<string, string>) => {
	let reads = 0;
	return {
		reads: () => reads,
		prepare(_sql: string) {
			return {
				async all() {
					reads++;
					return {
						results: Object.entries(rows).map(([key, value]) => ({
							key,
							value,
						})),
					};
				},
			};
		},
	};
};

const mkEnv = (
	dbRows: Record<string, string> = {},
	envVars: Record<string, string> = {},
) => {
	const kv = makeKv();
	const db = makeDb(dbRows);
	const env = {
		DB: db,
		TREE_CACHE: kv,
		...envVars,
	} as unknown as Bindings;
	return { env, kv, db };
};

describe("loadFlags — defaults", () => {
	it("returns built-in defaults when no DB rows and no env vars", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		expect(flags).toEqual({
			comments_enabled: true,
			reactions_enabled: true,
			votes_enabled: true,
			downvotes_enabled: true,
			page_reactions_enabled: false,
			page_votes_enabled: false,
			show_deleted_placeholders: false,
			spam_first_comment_moderate: false,
		});
	});

	it("page-level features default OFF", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		expect(flags.page_reactions_enabled).toBe(false);
		expect(flags.page_votes_enabled).toBe(false);
	});

	it("resolves a value for every canonical flag key", async () => {
		const { env } = mkEnv();
		const flags = await loadFlags(env);
		for (const key of FLAG_KEYS) {
			expect(typeof flags[key as FlagKey]).toBe("boolean");
		}
	});
});

describe("loadFlags — env var over default", () => {
	it("env var disables a default-on flag", async () => {
		const { env } = mkEnv({}, { COMMENTS_ENABLED: "0" });
		const flags = await loadFlags(env);
		expect(flags.comments_enabled).toBe(false);
	});

	it("env var enables a default-off page flag", async () => {
		const { env } = mkEnv({}, { PAGE_VOTES_ENABLED: "true" });
		const flags = await loadFlags(env);
		expect(flags.page_votes_enabled).toBe(true);
	});

	it("honors legacy env names for votes/downvotes", async () => {
		const { env } = mkEnv(
			{},
			{ VOTING_ENABLED: "false", DOWNVOTES_ENABLED: "off" },
		);
		const flags = await loadFlags(env);
		expect(flags.votes_enabled).toBe(false);
		expect(flags.downvotes_enabled).toBe(false);
	});

	it("treats various falsy spellings as off", async () => {
		for (const raw of ["0", "false", "no", "off", "FALSE", " Off "]) {
			const { env } = mkEnv({}, { REACTIONS_ENABLED: raw });
			const flags = await loadFlags(env);
			expect(flags.reactions_enabled, `raw=${JSON.stringify(raw)}`).toBe(false);
		}
	});

	it("treats a non-empty non-falsy value as on", async () => {
		const { env } = mkEnv({}, { PAGE_REACTIONS_ENABLED: "1" });
		const flags = await loadFlags(env);
		expect(flags.page_reactions_enabled).toBe(true);
	});
});

describe("loadFlags — DB row over env var", () => {
	it("DB row beats a conflicting env var (DB on, env off)", async () => {
		const { env } = mkEnv(
			{ comments_enabled: "true" },
			{ COMMENTS_ENABLED: "0" },
		);
		const flags = await loadFlags(env);
		expect(flags.comments_enabled).toBe(true);
	});

	it("DB row beats a conflicting env var (DB off, env on)", async () => {
		const { env } = mkEnv(
			{ page_votes_enabled: "false" },
			{ PAGE_VOTES_ENABLED: "true" },
		);
		const flags = await loadFlags(env);
		expect(flags.page_votes_enabled).toBe(false);
	});

	it("falls back to the default when a stored row is junk", async () => {
		const { env } = mkEnv({ comments_enabled: "" });
		const flags = await loadFlags(env);
		// "" is treated as "no opinion" → default (true) applies.
		expect(flags.comments_enabled).toBe(true);
	});

	it("a row for one flag does not disturb the others", async () => {
		const { env } = mkEnv({ votes_enabled: "false" });
		const flags = await loadFlags(env);
		expect(flags.votes_enabled).toBe(false);
		expect(flags.comments_enabled).toBe(true);
		expect(flags.reactions_enabled).toBe(true);
	});
});

describe("loadFlags — KV cache", () => {
	it("populates the cache on a cold read", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(kv.store.has("settings:resolved")).toBe(true);
	});

	it("serves a warm cache without touching D1", async () => {
		const { env, db } = mkEnv({ comments_enabled: "false" });
		const first = await loadFlags(env);
		expect(db.reads()).toBe(1);
		const second = await loadFlags(env);
		expect(db.reads()).toBe(1); // no further D1 read
		expect(second).toEqual(first);
	});

	it("a warm cache masks a changed DB row until busted", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		const before = await loadFlags(env);
		expect(before.comments_enabled).toBe(false);

		// Simulate an admin save writing a new value straight to the stub's
		// backing rows — without busting, the cache still wins.
		const cached = JSON.parse(
			kv.store.get("settings:resolved") as string,
		) as Record<string, unknown>;
		kv.store.set(
			"settings:resolved",
			JSON.stringify({ ...cached, flags: { ...before } }), // unchanged entry
		);
		const stillCached = await loadFlags(env);
		expect(stillCached.comments_enabled).toBe(false);
	});

	// The entry is on the hot path and re-populates once per TTL window per edge
	// colo against a 1000-writes/day account-wide cap. At 300s a modest
	// three-colo footprint spent ~864 of that budget re-deriving settings that
	// hadn't changed. Freshness comes from bustSettingsCache on save, not from
	// the TTL, so shortening it back buys nothing and costs quota — assert the
	// value so a future edit is a deliberate one.
	it("writes the cache key with a one-hour TTL", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(kv.putOpts.get("settings:resolved")?.expirationTtl).toBe(3600);
	});
});

describe("bustSettingsCache", () => {
	it("deletes the cached resolved object", async () => {
		const { env, kv } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(kv.store.has("settings:resolved")).toBe(true);
		await bustSettingsCache(env);
		expect(kv.store.has("settings:resolved")).toBe(false);
		expect(kv.deletes()).toBe(1);
	});

	it("forces a fresh D1 read on the next load", async () => {
		const { env, db } = mkEnv({ comments_enabled: "false" });
		await loadFlags(env);
		expect(db.reads()).toBe(1);
		await bustSettingsCache(env);
		await loadFlags(env);
		expect(db.reads()).toBe(2);
	});
});

// -- numeric display settings ------------------------------------------------
//
// loadNumbers() mirrors loadFlags()'s precedence (DB > env > default) and shares
// its cache entry, but resolves integers with a per-key [min,max] clamp.

describe("parseIntSetting — clamp + fallback", () => {
	it("returns the fallback for undefined / empty / junk", () => {
		expect(parseIntSetting(undefined, 25, 1, 200)).toBe(25);
		expect(parseIntSetting("", 25, 1, 200)).toBe(25);
		expect(parseIntSetting("   ", 25, 1, 200)).toBe(25);
		expect(parseIntSetting("abc", 25, 1, 200)).toBe(25);
	});

	it("clamps below min and above max", () => {
		expect(parseIntSetting("-5", 25, 1, 200)).toBe(1);
		expect(parseIntSetting("0", 25, 1, 200)).toBe(1);
		expect(parseIntSetting("9999", 25, 1, 200)).toBe(200);
	});

	it("passes an in-range value through", () => {
		expect(parseIntSetting("50", 25, 1, 200)).toBe(50);
	});

	it("parses a leading integer from a decimal-ish string", () => {
		// Number.parseInt semantics: "12.9" -> 12.
		expect(parseIntSetting("12.9", 25, 1, 200)).toBe(12);
	});
});

describe("loadNumbers — defaults", () => {
	it("returns built-in defaults when no DB rows and no env vars", async () => {
		const { env } = mkEnv();
		const numbers = await loadNumbers(env);
		expect(numbers).toEqual({
			comments_per_page: 25,
			replies_per_thread: 3,
			auto_collapse_depth: 3,
			auto_close_days: 0,
			auto_close_at: 0,
			community_min_votes: 5,
			community_collapse_ratio: 0,
			// 15 (not the old 5-minute code fallback) is the documented default;
			// -1 / 0 are the "check disabled" sentinels for the two spam dials.
			edit_window_minutes: 15,
			spam_link_threshold: -1,
			spam_honeypot_min_ms: 0,
			// 0 = retention off. This default is load-bearing: a non-zero value
			// here would start irreversibly erasing ip_hash / user_agent on the
			// first cron tick after an upgrade, on instances that never asked for
			// it. See src/db/ip-retention.ts.
			ip_hash_retention_days: 0,
			// Same reasoning, and just as load-bearing: a non-zero default would
			// start deleting an operator's moderation history on the first cron tick
			// after an upgrade. See src/db/audit-retention.ts.
			audit_log_retention_days: 0,
			// The confirmation-email ceiling. Unlike every other dial here these have
			// no "off" value — 0 would be a ceiling that refuses all new
			// subscriptions, so the clamp floor is 1. The daily default sits above
			// Resend's free-tier 100/day deliberately, so the provider's limit is
			// what a normal instance meets first. See src/lib/email-budget.ts.
			confirm_send_burst_max: 20,
			confirm_send_daily_max: 200,
		});
	});

	it("resolves a number for every canonical number key", async () => {
		const { env } = mkEnv();
		const numbers = await loadNumbers(env);
		for (const key of NUMBER_KEYS) {
			expect(typeof numbers[key as NumberKey]).toBe("number");
		}
	});

	it("every default sits within its own clamp bounds", async () => {
		for (const key of NUMBER_KEYS) {
			const b = numberBounds(key as NumberKey);
			expect(b.default).toBeGreaterThanOrEqual(b.min);
			expect(b.default).toBeLessThanOrEqual(b.max);
		}
	});
});

describe("loadNumbers — env var over default", () => {
	it("env var overrides the default", async () => {
		const { env } = mkEnv({}, { COMMENTS_PER_PAGE: "50" });
		const numbers = await loadNumbers(env);
		expect(numbers.comments_per_page).toBe(50);
	});

	it("clamps an out-of-range env value", async () => {
		const { env } = mkEnv({}, { COMMENTS_PER_PAGE: "9999" });
		const numbers = await loadNumbers(env);
		expect(numbers.comments_per_page).toBe(200);
	});

	it("falls back to default for a junk env value", async () => {
		const { env } = mkEnv({}, { REPLIES_PER_THREAD: "lots" });
		const numbers = await loadNumbers(env);
		expect(numbers.replies_per_thread).toBe(3);
	});
});

describe("loadNumbers — DB row over env var", () => {
	it("DB row beats a conflicting env var", async () => {
		const { env } = mkEnv(
			{ comments_per_page: "10" },
			{ COMMENTS_PER_PAGE: "100" },
		);
		const numbers = await loadNumbers(env);
		expect(numbers.comments_per_page).toBe(10);
	});

	it("clamps a hostile DB value (no DoS-via-huge-slice)", async () => {
		const { env } = mkEnv({ comments_per_page: "1000000" });
		const numbers = await loadNumbers(env);
		expect(numbers.comments_per_page).toBe(200);
	});

	it("clamps a negative DB value up to min", async () => {
		const { env } = mkEnv({ replies_per_thread: "-1" });
		const numbers = await loadNumbers(env);
		expect(numbers.replies_per_thread).toBe(0);
	});

	it("a row for one number does not disturb the others", async () => {
		const { env } = mkEnv({ comments_per_page: "10" });
		const numbers = await loadNumbers(env);
		expect(numbers.comments_per_page).toBe(10);
		expect(numbers.replies_per_thread).toBe(3);
		expect(numbers.auto_collapse_depth).toBe(3);
	});
});

describe("loadNumbers — KV cache", () => {
	it("serves a warm cache without touching D1", async () => {
		const { env, db } = mkEnv({ comments_per_page: "10" });
		const first = await loadNumbers(env);
		expect(db.reads()).toBe(1);
		const second = await loadNumbers(env);
		expect(db.reads()).toBe(1);
		expect(second).toEqual(first);
	});

	it("forces a fresh D1 read after a bust", async () => {
		const { env, db } = mkEnv({ comments_per_page: "10" });
		await loadNumbers(env);
		expect(db.reads()).toBe(1);
		await bustSettingsCache(env);
		await loadNumbers(env);
		expect(db.reads()).toBe(2);
	});
});

// -- one entry, every group --------------------------------------------------
//
// Flags, numbers and strings all derive from the same `getAllSettings` read plus
// `env`, so they share a single KV entry. That is a write-quota decision: KV's
// free tier allows 1000 writes/day *account wide*, and each key re-populates
// once per TTL window per edge colo. Three keys spent 72 writes/colo/day; one
// spends 24. These tests pin the consequences so a future split is deliberate.
describe("settings cache — one entry for all groups", () => {
	it("uses a single KV key", async () => {
		const { env, kv } = mkEnv({ comments_per_page: "10" });
		await loadNumbers(env);
		expect([...kv.store.keys()]).toEqual(["settings:resolved"]);
	});

	it("resolves every group from one D1 read", async () => {
		const { env, db } = mkEnv({
			comments_enabled: "false",
			comments_per_page: "10",
			default_locale: "de",
		});
		const { flags, numbers, strings } = await loadSettings(env);
		expect(flags.comments_enabled).toBe(false);
		expect(numbers.comments_per_page).toBe(10);
		expect(strings.default_locale).toBe("de");
		expect(db.reads()).toBe(1);
	});

	it("warms every group, whichever one asked first", async () => {
		const { env, db } = mkEnv({
			comments_enabled: "false",
			comments_per_page: "10",
		});
		const flags = await loadFlags(env);
		expect(db.reads()).toBe(1);
		// Numbers and strings ride the entry that loadFlags() populated.
		const numbers = await loadNumbers(env);
		const strings = await loadStrings(env);
		expect(db.reads()).toBe(1);
		expect(flags.comments_enabled).toBe(false);
		expect(numbers.comments_per_page).toBe(10);
		expect(strings.default_locale).toBe("auto");
	});

	it("a bust drops every group at once", async () => {
		const { env, kv, db } = mkEnv({ comments_per_page: "10" });
		await loadSettings(env);
		expect(db.reads()).toBe(1);
		await bustSettingsCache(env);
		expect(kv.store.size).toBe(0);
		expect(kv.deletes()).toBe(1);
		await loadFlags(env);
		expect(db.reads()).toBe(2);
	});

	it("collapses concurrent cold misses onto one derivation", async () => {
		const { env, db, kv } = mkEnv({ comments_per_page: "10" });
		const [a, b, c] = await Promise.all([
			loadFlags(env),
			loadNumbers(env),
			loadStrings(env),
		]);
		// One D1 read and one KV write for three concurrent misses. Without the
		// in-flight share this is 3 and 3 — the shape a cold colo under load
		// takes, which is what makes it a write-quota problem.
		expect(db.reads()).toBe(1);
		expect(kv.puts()).toBe(1);
		expect(a.comments_enabled).toBe(true);
		expect(b.comments_per_page).toBe(10);
		expect(c.default_locale).toBe("auto");
	});

	it("re-derives after the in-flight share settles", async () => {
		const { env, db } = mkEnv({ comments_per_page: "10" });
		await Promise.all([loadFlags(env), loadNumbers(env)]);
		expect(db.reads()).toBe(1);
		await bustSettingsCache(env);
		// The share is per-derivation, not a second cache: once it settles a bust
		// is honoured immediately.
		await loadNumbers(env);
		expect(db.reads()).toBe(2);
	});

	// A blob missing a group would otherwise resolve every setting in it to
	// `undefined` — a silent wrong answer, where a miss is merely a D1 read.
	// Reachable today only via a hand-written entry, which is exactly what a
	// stale deploy or a test fixture is.
	it("ignores a cached blob that is missing a group", async () => {
		const { env, kv, db } = mkEnv({ comments_per_page: "10" });
		const { flags, numbers } = await loadSettings(env);
		expect(db.reads()).toBe(1);
		kv.store.set(
			"settings:resolved",
			JSON.stringify({ flags, numbers }), // no `strings`
		);
		const strings = await loadStrings(env);
		expect(db.reads()).toBe(2); // fell through to D1 rather than trusting it
		expect(strings.default_locale).toBe("auto");
	});
});

// -- route-level flag gating -------------------------------------------------
//
// The gate is the first thing each POST handler runs. With a pre-warmed cache
// disabling the flag, the handler returns 403 before touching D1 — so these
// don't need the full comment/user/ghost stub chain. We pre-seed the KV cache
// so loadFlags() resolves straight from it.

const mkGatedEnv = (cachedFlags: Partial<Record<FlagKey, boolean>>) => {
	const kv = makeKv();
	// A full-shaped entry: the loader rejects a blob missing a group, so the
	// other two have to be present even when only the flags matter here.
	kv.store.set(
		"settings:resolved",
		JSON.stringify({ flags: cachedFlags, numbers: {}, strings: {} }),
	);
	return {
		TREE_CACHE: kv,
		// DB present but should never be queried on the 403 path.
		DB: makeDb({}),
		IP_HASH_SECRET: "x".repeat(32),
		ANALYTICS: { writeDataPoint: () => {} },
		SESSIONS: { get: async () => null },
		RATE_LIMITS: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
	} as unknown as Bindings;
};

const postJson = (app: Requestable, env: Bindings, body: unknown) =>
	app.request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
	);

describe("route gating — reactions", () => {
	it("403s reactions_disabled when reactions_enabled is off", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", reactions);
		const env = mkGatedEnv({ reactions_enabled: false });
		const res = await postJson(app, env, {
			comment_id: "01HC000000000000000000ABCD",
			kind: "like",
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"reactions_disabled",
		);
	});

	it("passes the gate (not 403-disabled) when reactions_enabled is on", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", reactions);
		const env = mkGatedEnv({ reactions_enabled: true });
		const res = await postJson(app, env, {}); // bad body → 400, not 403
		expect(res.status).not.toBe(403);
	});
});

describe("route gating — comments", () => {
	it("403s comments_disabled when comments_enabled is off", async () => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
		const env = mkGatedEnv({ comments_enabled: false });
		const res = await postJson(app, env, { slug: "x", body: "hi" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"comments_disabled",
		);
	});
});

/**
 * The four settings promoted out of deploy-time env in #45. Two of them carry
 * a sentinel that has to keep meaning exactly what the old env-var gate meant,
 * so pin the whole ladder: unset, junk, out-of-range, and DB-beats-env.
 */
describe("promoted runtime settings — spam_link_threshold", () => {
	it("defaults to -1 (check disabled) when unset", async () => {
		const { env } = mkEnv();
		expect((await loadNumbers(env)).spam_link_threshold).toBe(-1);
	});

	it("treats a junk env value as disabled, matching the old isFinite gate", async () => {
		const { env } = mkEnv({}, { SPAM_LINK_THRESHOLD: "NaN" });
		expect((await loadNumbers(env)).spam_link_threshold).toBe(-1);
	});

	it("clamps a negative env value to the -1 sentinel (old gate: n >= 0)", async () => {
		const { env } = mkEnv({}, { SPAM_LINK_THRESHOLD: "-5" });
		expect((await loadNumbers(env)).spam_link_threshold).toBe(-1);
	});

	it("keeps 0 distinct from off — 0 flags any comment carrying a link", async () => {
		const { env } = mkEnv({}, { SPAM_LINK_THRESHOLD: "0" });
		expect((await loadNumbers(env)).spam_link_threshold).toBe(0);
	});

	it("lets a DB row override the env var", async () => {
		const { env } = mkEnv(
			{ spam_link_threshold: "7" },
			{ SPAM_LINK_THRESHOLD: "3" },
		);
		expect((await loadNumbers(env)).spam_link_threshold).toBe(7);
	});
});

describe("promoted runtime settings — spam_honeypot_min_ms", () => {
	it("defaults to 0 (disabled) when unset", async () => {
		const { env } = mkEnv();
		expect((await loadNumbers(env)).spam_honeypot_min_ms).toBe(0);
	});

	it("floors a negative env value at 0, matching the old > 0 gate", async () => {
		const { env } = mkEnv({}, { SPAM_HONEYPOT_MIN_MS: "-1" });
		expect((await loadNumbers(env)).spam_honeypot_min_ms).toBe(0);
	});

	it("lets a DB row override the env var", async () => {
		const { env } = mkEnv(
			{ spam_honeypot_min_ms: "2500" },
			{ SPAM_HONEYPOT_MIN_MS: "1500" },
		);
		expect((await loadNumbers(env)).spam_honeypot_min_ms).toBe(2500);
	});
});

describe("promoted runtime settings — edit_window_minutes", () => {
	// The pre-settings code fell back to 5 minutes while every doc said 15.
	it("defaults to the documented 15, not the old 5-minute code fallback", async () => {
		const { env } = mkEnv();
		expect((await loadNumbers(env)).edit_window_minutes).toBe(15);
	});

	it("still honors an existing env var", async () => {
		const { env } = mkEnv({}, { EDIT_WINDOW_MINUTES: "5" });
		expect((await loadNumbers(env)).edit_window_minutes).toBe(5);
	});

	it("lets a DB row of 0 disable editing outright", async () => {
		const { env } = mkEnv(
			{ edit_window_minutes: "0" },
			{ EDIT_WINDOW_MINUTES: "15" },
		);
		expect((await loadNumbers(env)).edit_window_minutes).toBe(0);
	});

	it("clamps above the one-week ceiling", async () => {
		const { env } = mkEnv({}, { EDIT_WINDOW_MINUTES: "99999" });
		expect((await loadNumbers(env)).edit_window_minutes).toBe(10_080);
	});

	// The ceiling exists to bound the stepper, not to retune existing installs:
	// parseIntSetting clamps env values too, so anything below it must survive
	// untouched. A day and a week are the two plausible "long window" configs.
	it("leaves a pre-existing multi-day env window alone", async () => {
		const { env } = mkEnv({}, { EDIT_WINDOW_MINUTES: "1440" });
		expect((await loadNumbers(env)).edit_window_minutes).toBe(1440);
		const week = mkEnv({}, { EDIT_WINDOW_MINUTES: "10080" });
		expect((await loadNumbers(week.env)).edit_window_minutes).toBe(10_080);
	});
});

describe("promoted runtime settings — spam_first_comment_moderate", () => {
	it("defaults off", async () => {
		const { env } = mkEnv();
		expect((await loadFlags(env)).spam_first_comment_moderate).toBe(false);
	});

	it("reads the legacy env var", async () => {
		const { env } = mkEnv({}, { SPAM_FIRST_COMMENT_MODERATE: "true" });
		expect((await loadFlags(env)).spam_first_comment_moderate).toBe(true);
	});

	it("lets a DB row turn it back off over an enabling env var", async () => {
		const { env } = mkEnv(
			{ spam_first_comment_moderate: "false" },
			{ SPAM_FIRST_COMMENT_MODERATE: "true" },
		);
		expect((await loadFlags(env)).spam_first_comment_moderate).toBe(false);
	});
});

/**
 * GET /form-token gates on the resolved honeypot setting, not raw env. If it
 * kept reading env, an admin enabling fill-time checks from the Settings page
 * would get a 404 here, every submission would arrive unsigned, and the check
 * they just switched on would silently never fire.
 */
describe("promoted runtime settings — /form-token honors the DB override", () => {
	const tokenReq = async (env: Bindings) => {
		const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
		return app.request(
			"/form-token",
			{},
			env as unknown as Record<string, unknown>,
		);
	};

	it("404s while the honeypot check is disabled", async () => {
		const { env } = mkEnv({}, { SPAM_FORM_TS_SECRET: "k" });
		expect((await tokenReq(env)).status).toBe(404);
	});

	it("mints a token when a DB row enables the check with no env var set", async () => {
		const { env } = mkEnv(
			{ spam_honeypot_min_ms: "1500" },
			{ SPAM_FORM_TS_SECRET: "k" },
		);
		const res = await tokenReq(env);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { token: string }).token).toBeTruthy();
	});

	it("404s when a DB row disables a check the env var had enabled", async () => {
		const { env } = mkEnv(
			{ spam_honeypot_min_ms: "0" },
			{ SPAM_FORM_TS_SECRET: "k", SPAM_HONEYPOT_MIN_MS: "1500" },
		);
		expect((await tokenReq(env)).status).toBe(404);
	});
});

describe("parseStringSetting", () => {
	const OPTS = ["auto", "en"];

	it("falls back when the value is absent or empty", () => {
		expect(parseStringSetting(undefined, "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("", "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("   ", "auto", OPTS)).toBe("auto");
	});

	it("accepts a whitelisted value", () => {
		expect(parseStringSetting("en", "auto", OPTS)).toBe("en");
	});

	it("canonicalizes case and surrounding space", () => {
		expect(parseStringSetting("  EN ", "auto", OPTS)).toBe("en");
	});

	it("falls back rather than repairing an off-list value", () => {
		// The whole safety property: a string setting is safe because it is one
		// of a known set, so a near-miss must not be coerced onto the list.
		expect(parseStringSetting("en-GB", "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("de", "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("../../etc", "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("<script>", "auto", OPTS)).toBe("auto");
		expect(parseStringSetting("__proto__", "auto", OPTS)).toBe("auto");
	});
});

describe("loadStrings", () => {
	it("returns built-in defaults when no DB rows and no env vars", async () => {
		const { env } = mkEnv();
		expect(await loadStrings(env)).toEqual({ default_locale: "auto" });
	});

	it("resolves a value for every canonical string key", async () => {
		const { env } = mkEnv();
		const strings = await loadStrings(env);
		for (const key of STRING_KEYS) {
			expect(stringOptions(key)).toContain(strings[key]);
		}
	});

	it("env var beats the default", async () => {
		const { env } = mkEnv({}, { DEFAULT_LOCALE: "en" });
		expect((await loadStrings(env)).default_locale).toBe("en");
	});

	it("DB row beats the env var", async () => {
		const { env } = mkEnv({ default_locale: "auto" }, { DEFAULT_LOCALE: "en" });
		expect((await loadStrings(env)).default_locale).toBe("auto");
	});

	it("an unknown env value falls back to the default, not to the DB row", async () => {
		const { env } = mkEnv({}, { DEFAULT_LOCALE: "kl" });
		expect((await loadStrings(env)).default_locale).toBe("auto");
	});

	it("skips D1 while warm", async () => {
		const { env, db, kv } = mkEnv({ default_locale: "en" });
		await loadStrings(env);
		expect(db.reads()).toBe(1);
		await loadStrings(env);
		expect(db.reads()).toBe(1);
		expect([...kv.store.keys()]).toEqual(["settings:resolved"]);
		expect(kv.putOpts.get("settings:resolved")?.expirationTtl).toBe(3600);
	});

	it("a bust forces the next read back to D1", async () => {
		const { env, db } = mkEnv({ default_locale: "en" });
		await loadStrings(env);
		await bustSettingsCache(env);
		await loadStrings(env);
		expect(db.reads()).toBe(2);
	});
});
