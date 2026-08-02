/**
 * The inactive-author gate on the *authenticated* comment POST branch.
 *
 * That branch used to run its own inline SELECT that listed columns by hand and
 * checked `is_banned` alone. It omitted `erased_at`, so it was the one
 * state-changing route that an erased user could still write through: erasure
 * revokes their sessions, but the stamp lives in KV and takes up to a minute to
 * reach every colo, and inside that window a live cookie attributed brand-new
 * comments to an identity whose name had just become a placeholder.
 *
 * PATCH and DELETE were never affected — they go through `requireActiveUser`.
 * These cover POST reaching the same predicate, plus the 401/403 split that
 * kept the inline query around in the first place.
 *
 * Real SQLite, every migration applied, so the gate runs against the actual
 * `erased_at` column rather than a stub that agrees with it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				return this;
			},
			async run() {
				const r = stmt.run(...(bound as never[]));
				return { success: true, meta: { changes: r.changes } };
			},
			async first() {
				return stmt.get(...(bound as never[])) ?? null;
			},
			async all() {
				return { results: stmt.all(...(bound as never[])) };
			},
		};
	},
});

const SLUG = "gate";
const ACTIVE_ID = "01HU00000000000000ACTIVE";
const BANNED_ID = "01HU00000000000000BANNED";
const ERASED_ID = "01HU00000000000000ERASED";
const GONE_ID = "01HU000000000000000GONE0";

/**
 * sid → user_id. GONE_SID resolves to a user_id with no row behind it.
 *
 * All four are hex: `SESSION_ID_RE` rejects anything else outright, and a
 * rejected cookie falls through to the *anonymous* branch, which would quietly
 * turn these into Turnstile assertions instead.
 */
const SIDS: Record<string, string> = {
	[`${"a".repeat(64)}`]: ACTIVE_ID,
	[`${"b".repeat(64)}`]: BANNED_ID,
	[`${"e".repeat(64)}`]: ERASED_ID,
	[`${"d".repeat(64)}`]: GONE_ID,
};
const ACTIVE_SID = "a".repeat(64);
const BANNED_SID = "b".repeat(64);
const ERASED_SID = "e".repeat(64);
const GONE_SID = "d".repeat(64);

const makeSessions = () => ({
	async get(key: string) {
		const userId = SIDS[key.replace(/^sess:/, "")];
		if (!userId) return null;
		// Live and unrevoked on purpose: these tests are about the D1 layer that
		// has to hold while the KV revocation stamp is still propagating.
		return JSON.stringify({ user_id: userId, expires_at: 4_102_444_800_000 });
	},
	async put() {},
	async delete() {},
});

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const user = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_banned, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	user.run(ACTIVE_ID, "github", "1", "Reader", 0, 1_700_000_000_000);
	user.run(BANNED_ID, "github", "2", "Spammer", 1, 1_700_000_000_000);
	// Erased but NOT banned — `eraseUserData` empties the identity and stamps
	// erased_at, and leaves is_banned alone. That is exactly what the old
	// is_banned-only check missed.
	user.run(ERASED_ID, "github", null, "[deleted]", 0, 1_700_000_000_000);
	sqlite
		.prepare("UPDATE users SET erased_at = ? WHERE id = ?")
		.run(1_700_000_001_000, ERASED_ID);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Gate", null, 1_700_000_000_000);
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		EDIT_WINDOW_MINUTES: "15",
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const post = (sid: string, body = "hello") =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", comments)
		.request(
			"/",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `garrul_sess=${sid}`,
				},
				body: JSON.stringify({ slug: SLUG, body }),
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);

const countComments = (): number =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;

describe("POST /comments — inactive author", () => {
	it("accepts an active signed-in author", async () => {
		expect((await post(ACTIVE_SID)).status).toBe(201);
		expect(countComments()).toBe(1);
	});

	it("refuses a banned author", async () => {
		expect((await post(BANNED_SID)).status).toBe(403);
		expect(countComments()).toBe(0);
	});

	it("refuses an erased author", async () => {
		// The regression: erased_at set, is_banned clear. Their session is still
		// live here because the revocation stamp has not propagated yet.
		expect((await post(ERASED_SID)).status).toBe(403);
		expect(countComments()).toBe(0);
	});

	it("reports a vanished user row as an expired session, not a ban", async () => {
		// The 401/403 split is why this branch can't just call requireActiveUser:
		// "sign in again" and "you are refused" are different messages, and a null
		// return can't tell them apart.
		const res = await post(GONE_SID);
		expect(res.status).toBe(401);
		expect(countComments()).toBe(0);
	});
});
