/**
 * POST /admin/settings write-path tests.
 *
 * The render side (settings page HTML) and the read side (loadFlags /
 * loadNumbers) are covered elsewhere; this exercises the handler that
 * PERSISTS operator overrides — specifically the numeric branch added with
 * configurable pagination:
 *
 *   - numbers are validated, clamped into [min,max], and stored as text;
 *   - a non-numeric value is rejected 400 (`invalid_number:<key>`);
 *   - unknown keys are ignored (whitelist);
 *   - the numbers cache is busted but the flag cache is left alone when only
 *     numbers change (independent cache entries);
 *   - the write is audited;
 *   - "reset" clears both flag AND number keys.
 *
 * Plus the free-form `texts` group (muted words), whose rules differ from all
 * three above: no clamp, no whitelist, over-long rejected rather than
 * truncated, empty meaning empty, and the audit row recording a size instead
 * of the value.
 *
 * No Miniflare: hand-rolled D1 + KV stubs route by SQL substring / key, in
 * the same style as votes.test.ts. The admin gate (session → admin user) and
 * the same-origin CSRF check are satisfied with a seeded session + Origin
 * header.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { admin } from "../src/routes/admin";
import { MAX_TEXT_SETTING_CHARS } from "../src/lib/settings";
import type { Bindings } from "../src/index";

// Real session ids are 64 lowercase hex chars (see newSessionId); readSession
// rejects anything else before the KV lookup, so the fixture must match.
const SID = "a".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";

// D1 double: serves the admin user for the auth gate and captures every
// .run() (setSetting INSERTs, deleteSettings DELETE, audit INSERT) so tests
// can assert what was persisted.
const makeDb = () => {
	const runs: { sql: string; binds: unknown[] }[] = [];
	const chain = (sql: string) => ({
		_binds: [] as unknown[],
		bind(...args: unknown[]) {
			this._binds = args;
			return this;
		},
		async first() {
			if (sql.includes("FROM users WHERE id")) {
				return {
					id: ADMIN_ID,
					provider: "github",
					provider_id: "1",
					name: "Op",
					email: "op@example.com",
					avatar_url: null,
					is_admin: 1,
					is_banned: 0,
					role: "admin",
					created_at: 1_700_000_000_000,
				};
			}
			return null;
		},
		async all() {
			return { results: [] };
		},
		async run() {
			runs.push({ sql, binds: this._binds });
			return { meta: { changes: 1 } };
		},
	});
	return { db: { prepare: (sql: string) => chain(sql) }, runs };
};

const makeKv = (seed: Record<string, string> = {}) => {
	const store = new Map<string, string>(Object.entries(seed));
	const deletedKeys: string[] = [];
	return {
		store,
		deletedKeys,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			deletedKeys.push(key);
			store.delete(key);
		},
	};
};

const mkEnv = () => {
	const { db, runs } = makeDb();
	// Seed the version-check cache with a back-off entry so the admin
	// middleware's fire-and-forget refresh never attempts a GitHub fetch.
	const kv = makeKv({
		"meta:latest-release": JSON.stringify({ kind: "null", fetchedAt: 1 }),
		"meta:recent-releases": JSON.stringify({ kind: "null", fetchedAt: 1 }),
	});
	const sessions = {
		async get(key: string) {
			if (key === `sess:${SID}`) {
				return JSON.stringify({
					user_id: ADMIN_ID,
					expires_at: 4_102_444_800_000, // year 2100
				});
			}
			return null;
		},
		async put() {},
		async delete() {},
	};
	const env = {
		DB: db,
		TREE_CACHE: kv,
		SESSIONS: sessions,
	} as unknown as Bindings;
	return { env, kv, runs };
};

const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} };

const postSettings = (
	env: Bindings,
	body: unknown,
	opts: { cookie?: boolean; origin?: string | null } = {},
) => {
	const { cookie = true, origin = "http://localhost" } = opts;
	const app = new Hono<{ Bindings: Bindings }>().route("/admin", admin);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cookie) headers.cookie = `__Host-garrul_sess=${SID}`;
	if (origin) headers.origin = origin;
	return app.request(
		"/admin/settings",
		{ method: "POST", headers, body: JSON.stringify(body) },
		env as unknown as Record<string, unknown>,
		execCtx as unknown as ExecutionContext,
	);
};

// settings INSERT binds are (key, value, updated_at).
const settingWrites = (runs: { sql: string; binds: unknown[] }[]) =>
	runs
		.filter((r) => r.sql.includes("INSERT INTO settings"))
		.map((r) => [r.binds[0], r.binds[1]] as [string, string]);

describe("POST /admin/settings — numeric writes", () => {
	it("stores an in-range number as text and busts the settings cache", async () => {
		const { env, kv, runs } = mkEnv();
		const res = await postSettings(env, { numbers: { comments_per_page: 10 } });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { numbers: Record<string, number> };
		expect(json.numbers.comments_per_page).toBe(10);

		expect(settingWrites(runs)).toContainEqual(["comments_per_page", "10"]);
		// One entry holds every group, so any write invalidates all of it.
		expect(kv.deletedKeys).toContain("settings:resolved");
	});

	it("clamps an over-max value before storing", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: 1_000_000 },
		});
		expect(res.status).toBe(200);
		// max is 200.
		expect(settingWrites(runs)).toContainEqual(["comments_per_page", "200"]);
	});

	it("clamps a negative value up to the minimum", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { replies_per_thread: -5 },
		});
		expect(res.status).toBe(200);
		// min is 0.
		expect(settingWrites(runs)).toContainEqual(["replies_per_thread", "0"]);
	});

	// spam_link_threshold is the one key whose floor is negative: -1 is the
	// "check off" sentinel, 0 means "flag any link". A shared clamp that
	// assumed a 0 floor would quietly turn the off switch into flag-any-link.
	it("preserves the -1 off sentinel for spam_link_threshold", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { spam_link_threshold: -1 },
		});
		expect(res.status).toBe(200);
		expect(settingWrites(runs)).toContainEqual(["spam_link_threshold", "-1"]);
	});

	it("clamps below-sentinel link thresholds up to -1", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { spam_link_threshold: -9 },
		});
		expect(res.status).toBe(200);
		expect(settingWrites(runs)).toContainEqual(["spam_link_threshold", "-1"]);
	});

	it("accepts a numeric string and truncates a decimal", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { auto_collapse_depth: "2", comments_per_page: 12.9 },
		});
		expect(res.status).toBe(200);
		const writes = settingWrites(runs);
		expect(writes).toContainEqual(["auto_collapse_depth", "2"]);
		expect(writes).toContainEqual(["comments_per_page", "12"]);
	});

	it("rejects a non-numeric value with 400 invalid_number:<key>", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: "lots" },
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("invalid_number:comments_per_page");
		// Nothing persisted on the rejected request.
		expect(settingWrites(runs)).toHaveLength(0);
	});

	it("ignores unknown number keys (whitelist)", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			numbers: { comments_per_page: 15, bogus_setting: 99 },
		});
		expect(res.status).toBe(200);
		const writes = settingWrites(runs);
		expect(writes).toContainEqual(["comments_per_page", "15"]);
		expect(writes.some(([k]) => k === "bogus_setting")).toBe(false);
	});

	it("400s settings_required when only unknown keys are supplied", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, { numbers: { bogus_setting: 99 } });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"settings_required",
		);
		expect(settingWrites(runs)).toHaveLength(0);
	});

	it("400s settings_required when neither flags nor numbers are present", async () => {
		const { env } = mkEnv();
		const res = await postSettings(env, { something: "else" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe(
			"settings_required",
		);
	});

	it("audits the settings update", async () => {
		const { env, runs } = mkEnv();
		await postSettings(env, { numbers: { comments_per_page: 10 } });
		const audit = runs.find((r) => r.sql.includes("INSERT INTO audit_log"));
		expect(audit).toBeDefined();
		expect(audit!.binds).toContain("settings.update");
		expect(audit!.binds).toContain(ADMIN_ID);
	});
});

describe("POST /admin/settings — string writes", () => {
	it("stores a whitelisted value and busts the settings cache", async () => {
		const { env, kv, runs } = mkEnv();
		const res = await postSettings(env, { strings: { default_locale: "en" } });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { strings: Record<string, string> };
		expect(json.strings.default_locale).toBe("en");

		expect(settingWrites(runs)).toContainEqual(["default_locale", "en"]);
		expect(kv.deletedKeys).toEqual(["settings:resolved"]);
	});

	it("stores the auto sentinel, which is distinct from an explicit locale", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, { strings: { default_locale: "auto" } });
		expect(res.status).toBe(200);
		expect(settingWrites(runs)).toContainEqual(["default_locale", "auto"]);
	});

	// Rejected outright rather than coerced to the default: a silent
	// substitution would let a stale admin page reset a locale the operator
	// picked, and report success while doing it.
	it("rejects an off-list value with 400 invalid_string:<key>", async () => {
		const { env, runs } = mkEnv();
		for (const bad of ["kl", "en-GB", "../../etc", "<script>", "__proto__"]) {
			const res = await postSettings(env, { strings: { default_locale: bad } });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_string:default_locale" });
		}
		expect(settingWrites(runs)).toEqual([]);
	});

	it("rejects a non-string value", async () => {
		const { env } = mkEnv();
		const res = await postSettings(env, { strings: { default_locale: 7 } });
		expect(res.status).toBe(400);
	});

	it("ignores unknown string keys (whitelist)", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			strings: { default_locale: "en", nonsense_key: "x" },
		});
		expect(res.status).toBe(200);
		expect(settingWrites(runs).map(([k]) => k)).toEqual(["default_locale"]);
	});
});

describe("POST /admin/settings — text writes", () => {
	it("stores a multi-line value verbatim and busts the settings cache", async () => {
		const { env, kv, runs } = mkEnv();
		const list = "viagra\n*casino*\n# a comment\nt.me/*";
		const res = await postSettings(env, { texts: { spam_blocklist: list } });
		expect(res.status).toBe(200);
		expect(settingWrites(runs)).toContainEqual(["spam_blocklist", list]);
		expect(kv.deletedKeys).toContain("settings:resolved");
	});

	// The one case where "empty means unset" would be actively wrong: an
	// operator who clears the box wants the list gone, not silently replaced by
	// whatever SPAM_BLOCKLIST the deploy shipped. Reset is the way back to that.
	it("writes an empty string rather than treating it as absent", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, { texts: { spam_blocklist: "" } });
		expect(res.status).toBe(200);
		expect(settingWrites(runs)).toContainEqual(["spam_blocklist", ""]);
	});

	it("rejects a non-string value with 400 invalid_text:<key>", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, { texts: { spam_blocklist: 42 } });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_text:spam_blocklist" });
		expect(settingWrites(runs)).toEqual([]);
	});

	// Rejected, not truncated. The resolver truncates because it has nobody to
	// tell; here there's an operator watching, and dropping the tail of a
	// moderation list silently is how rules go missing with no visible cause.
	it("rejects an over-long value with 400 text_too_long:<key>", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			texts: { spam_blocklist: "x".repeat(MAX_TEXT_SETTING_CHARS + 1) },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "text_too_long:spam_blocklist" });
		expect(settingWrites(runs)).toEqual([]);
	});

	it("accepts a value exactly at the limit", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			texts: { spam_blocklist: "x".repeat(MAX_TEXT_SETTING_CHARS) },
		});
		expect(res.status).toBe(200);
		expect(settingWrites(runs).map(([k]) => k)).toEqual(["spam_blocklist"]);
	});

	it("ignores unknown text keys (whitelist)", async () => {
		const { env, runs } = mkEnv();
		const res = await postSettings(env, {
			texts: { spam_blocklist: "casino", nonsense_key: "x" },
		});
		expect(res.status).toBe(200);
		expect(settingWrites(runs).map(([k]) => k)).toEqual(["spam_blocklist"]);
	});

	// The audit log answers "who changed what, when" — it is not a revision
	// store for a 20k-character moderation list, and a copy of every list an
	// operator has ever typed is a liability, not a feature.
	it("audits the size of a text setting, never its content", async () => {
		const { env, runs } = mkEnv();
		await postSettings(env, { texts: { spam_blocklist: "viagra\ncasino" } });
		const audit = runs.find((r) => r.sql.includes("INSERT INTO audit_log"));
		expect(audit).toBeDefined();
		const meta = audit!.binds.find(
			(b) => typeof b === "string" && b.includes("spam_blocklist"),
		) as string;
		expect(JSON.parse(meta).spam_blocklist).toBe("13 chars");
		expect(meta).not.toContain("viagra");
	});
});

describe("POST /admin/settings — reset", () => {
	it("clears flag, number, string and text keys and busts the cache", async () => {
		const { env, kv, runs } = mkEnv();
		const res = await postSettings(env, { reset: true });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { reset: boolean };
		expect(json.reset).toBe(true);

		const del = runs.find((r) => r.sql.includes("DELETE FROM settings"));
		expect(del).toBeDefined();
		// The delete binds every flag + number key.
		expect(del!.binds).toContain("comments_enabled");
		expect(del!.binds).toContain("comments_per_page");
		expect(del!.binds).toContain("auto_collapse_depth");
		expect(del!.binds).toContain("default_locale");
		expect(del!.binds).toContain("spam_blocklist");

		expect(kv.deletedKeys).toContain("settings:resolved");
	});
});

describe("POST /admin/settings — gate", () => {
	it("401s without a session cookie", async () => {
		const { env } = mkEnv();
		const res = await postSettings(env, { numbers: { comments_per_page: 10 } }, {
			cookie: false,
		});
		expect(res.status).toBe(401);
	});

	it("403s on an Origin mismatch (CSRF)", async () => {
		const { env } = mkEnv();
		const res = await postSettings(
			env,
			{ numbers: { comments_per_page: 10 } },
			{ origin: "https://evil.example.com" },
		);
		expect(res.status).toBe(403);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("origin_mismatch");
	});
});
