/**
 * `GET /api/v1/auth/me` — the widget's "who am I" call.
 *
 * This route shipped without server-side coverage, which mattered more than it
 * looks: its response is the *only* thing the widget consults to decide whether
 * a reader is signed in, and its field list is a disclosure boundary. The
 * projection now lives in one exported function (`publicUser`) shared with
 * `GET /api/v1/bootstrap`, so these tests pin the boundary itself rather than
 * one route's spelling of it.
 *
 * What each case is defending:
 *   - no cookie → `{user: null}` at HTTP 200, not a 401. The widget renders a
 *     sign-in button off this, and an error status would make an anonymous
 *     pageview look like a failure.
 *   - the omitted columns stay omitted. `provider_id` is the provider's opaque
 *     account id and `is_banned`/`erased_at` are moderation state; a `SELECT *`
 *     refactor that widened the row would leak all three to every host page.
 *   - a session whose user row is gone reports anonymous rather than 500.
 *   - a banned identity still gets a `user`. This route answers "who is this
 *     cookie", not "may they act" — the write paths run `requireActiveUser`
 *     separately, and conflating the two here would silently sign a banned
 *     reader out of the UI while their session stayed live.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auth } from "../src/routes/auth";
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

const SID = "a".repeat(64);
const GHOST_SID = "b".repeat(64);
const USER = "01HU00000000000000AUTHOR";

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
			                    is_admin, role, created_at)
			 VALUES (?, 'github', 'gh-1', 'Ada', 'ada@example.com',
			         'https://cdn.example/a.png', 0, 'mod', ?)`,
		)
		.run(USER, 1_700_000_000_000);

	const sessions: Record<string, string> = {
		[`sess:${SID}`]: JSON.stringify({
			user_id: USER,
			expires_at: 4_102_444_800_000,
		}),
		// A live cookie pointing at a user row that no longer exists.
		[`sess:${GHOST_SID}`]: JSON.stringify({
			user_id: "01HU0000000000000MISSING",
			expires_at: 4_102_444_800_000,
		}),
	};

	env = {
		DB: makeD1(sqlite),
		SESSIONS: {
			async get(key: string) {
				return sessions[key] ?? null;
			},
			async put() {},
			async delete() {},
		},
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
	} as unknown as Bindings;
});

const me = (sid?: string) =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", auth)
		.request(
			"http://localhost/me",
			{ headers: sid ? { cookie: `garrul_sess=${sid}` } : {} },
			env as unknown as Record<string, unknown>,
		);

describe("GET /auth/me", () => {
	it("reports anonymous at 200 with no cookie", async () => {
		const res = await me();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user: null });
	});

	it("returns exactly the public projection for a signed-in reader", async () => {
		const res = await me(SID);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			user: {
				id: USER,
				provider: "github",
				name: "Ada",
				email: "ada@example.com",
				avatar_url: "https://cdn.example/a.png",
				is_admin: false,
				role: "mod",
			},
		});
	});

	it("never discloses provider_id or moderation state", async () => {
		const body = (await (await me(SID)).json()) as {
			user: Record<string, unknown>;
		};
		for (const field of ["provider_id", "is_banned", "erased_at", "created_at"]) {
			expect(body.user).not.toHaveProperty(field);
		}
	});

	it("reports anonymous when the session outlives its user row", async () => {
		const res = await me(GHOST_SID);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user: null });
	});

	it("still identifies a banned reader (identity, not authorization)", async () => {
		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(USER);
		const body = (await (await me(SID)).json()) as {
			user: Record<string, unknown> | null;
		};
		expect(body.user?.id).toBe(USER);
		expect(body.user).not.toHaveProperty("is_banned");
	});
});
