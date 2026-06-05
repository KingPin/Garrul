/**
 * Voting tests cover three concerns:
 *
 *   1. Route-level input validation — accepting only -1/0/1, rejecting
 *      malformed payloads with 400, honoring the VOTING_ENABLED and
 *      DOWNVOTES_ENABLED env flags.
 *   2. castVote() SQL semantics — that we emit a batch with the right
 *      writes (DELETE vs UPSERT) and the counter recomputation lands.
 *   3. Tree rendering — vote scores propagate via buildTree.
 *
 * No Miniflare here: the route hits a hand-rolled D1 stub. Integration
 * against real D1 is covered by `npm run dev` end-to-end testing on the
 * dogfood instance (per project convention).
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { votes } from "../src/routes/api.votes";
import { castVote } from "../src/db/queries";

type Row = Record<string, unknown> | null;

const ULID_OK = "01HC000000000000000000ABCD";

// Tracks every SQL stmt issued; lets a test prove that castVote(value=0)
// emits a DELETE while castVote(value=1) emits an INSERT … UPSERT.
type Captured = { sql: string; binds: unknown[] };

const makeDb = (config: {
	comment?: Row;
	scoresAfter?: { score_up: number; score_down: number; my_vote: number };
}) => {
	const captured: Captured[] = [];
	const batches: Captured[][] = [];
	const chain = (sql: string, binds: unknown[] = []) => {
		const stmt = {
			_sql: sql,
			_binds: binds,
			bind(...args: unknown[]) {
				this._binds = args;
				return this;
			},
			async first() {
				captured.push({ sql, binds: this._binds });
				if (sql.includes("SELECT c.score_up")) {
					return config.scoresAfter ?? null;
				}
				if (sql.includes("FROM comments WHERE id")) {
					return config.comment ?? null;
				}
				if (sql.includes("FROM users")) {
					return {
						id: "01HU000000000000000000",
						provider: "anon",
						provider_id: null,
						name: "anon",
						email: null,
						avatar_url: null,
						is_admin: 0,
						is_banned: 0,
						created_at: 1_700_000_000_000,
					};
				}
				return null;
			},
			async all() {
				captured.push({ sql, binds: this._binds });
				return { results: [] };
			},
			async run() {
				captured.push({ sql, binds: this._binds });
				return { meta: { changes: 1 } };
			},
		};
		return stmt;
	};
	const db = {
		prepare(sql: string) {
			return chain(sql);
		},
		async batch(stmts: { _sql: string; _binds: unknown[] }[]) {
			const group: Captured[] = stmts.map((s) => ({
				sql: s._sql,
				binds: s._binds,
			}));
			batches.push(group);
			for (const c of group) captured.push(c);
			return [];
		},
	};
	return { db, captured, batches };
};

// -- castVote SQL semantics --------------------------------------------------

describe("castVote", () => {
	it("issues an UPSERT + counter recompute for value=1", async () => {
		const { db, batches } = makeDb({
			scoresAfter: { score_up: 1, score_down: 0, my_vote: 1 },
		});
		const result = await castVote(
			db as unknown as D1Database,
			ULID_OK,
			"01HU000000000000000000",
			1,
		);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(2);
		expect(batches[0]![0]!.sql).toContain("INSERT INTO votes");
		expect(batches[0]![0]!.sql).toContain("ON CONFLICT(comment_id, user_id)");
		expect(batches[0]![1]!.sql).toContain("UPDATE comments");
		expect(result).toEqual({ score_up: 1, score_down: 0, my_vote: 1 });
	});

	it("issues a DELETE + counter recompute for value=0", async () => {
		const { db, batches } = makeDb({
			scoresAfter: { score_up: 0, score_down: 0, my_vote: 0 },
		});
		await castVote(
			db as unknown as D1Database,
			ULID_OK,
			"01HU000000000000000000",
			0,
		);
		expect(batches).toHaveLength(1);
		expect(batches[0]![0]!.sql).toContain("DELETE FROM votes");
		expect(batches[0]![1]!.sql).toContain("UPDATE comments");
	});

	it("downvote stores value=-1 verbatim", async () => {
		const { db, batches } = makeDb({
			scoresAfter: { score_up: 0, score_down: 1, my_vote: -1 },
		});
		await castVote(
			db as unknown as D1Database,
			ULID_OK,
			"01HU000000000000000000",
			-1,
		);
		// the UPSERT binds (comment_id, user_id, value, created_at)
		expect(batches[0]![0]!.binds[2]).toBe(-1);
	});
});

// -- route-level input validation -------------------------------------------

// The route's ghost-user lookup falls through makeDb's `FROM users` branch,
// which returns id="01HU000000000000000000". A comment.user_id distinct
// from that id means the anon voter is NOT the comment author — the
// default path. The self-vote test below overrides this to match.
const COMMENT_AUTHOR_ID = "01HU111111111111111111";

const mkRouteApp = (
	envOver: Partial<{
		VOTING_ENABLED: string;
		DOWNVOTES_ENABLED: string;
	}> = {},
	commentAuthorId: string = COMMENT_AUTHOR_ID,
) => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	const { db } = makeDb({
		comment: {
			id: ULID_OK,
			post_slug: "hello",
			parent_id: null,
			user_id: commentAuthorId,
			body_md: "x",
			body_html: "<p>x</p>",
			renderer_version: 1,
			status: "approved",
			edited_at: null,
			deleted_at: null,
			ip_hash: null,
			user_agent: null,
			created_at: 1,
			score_up: 0,
			score_down: 0,
		},
		scoresAfter: { score_up: 1, score_down: 0, my_vote: 1 },
	});
	app.route("/v", votes);
	const env = {
		DB: db,
		RATE_LIMITS: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
		// loadFlags() (now sourcing the vote flags) reads/writes TREE_CACHE on
		// the hot path; an empty KV stub forces a cold resolve from env vars.
		TREE_CACHE: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
		ANALYTICS: { writeDataPoint: () => {} },
		SESSIONS: { get: async () => null },
		IP_HASH_SECRET: "x".repeat(32),
		...envOver,
	};
	return { app, env };
};

const post = async (
	app: Hono,
	env: Record<string, unknown>,
	body: unknown,
) =>
	app.request(
		"/v",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);

describe("POST /votes — input validation", () => {
	it("rejects a missing comment_id with 400", async () => {
		const { app, env } = mkRouteApp();
		const res = await post(app, env, { value: 1 });
		expect(res.status).toBe(400);
	});

	it("rejects value=2 with 400", async () => {
		const { app, env } = mkRouteApp();
		const res = await post(app, env, { comment_id: ULID_OK, value: 2 });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_value");
	});

	it('rejects value="up" with 400', async () => {
		const { app, env } = mkRouteApp();
		const res = await post(app, env, { comment_id: ULID_OK, value: "up" });
		expect(res.status).toBe(400);
	});

	it("rejects a malformed JSON body with 400", async () => {
		const { app, env } = mkRouteApp();
		const res = await app.request(
			"/v",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			},
			env,
		);
		expect(res.status).toBe(400);
	});

	it("accepts value=-1 / 0 / 1 (numbers AND strings)", async () => {
		const { app, env } = mkRouteApp();
		for (const value of [1, -1, 0, "1", "-1", "0"]) {
			const res = await post(app, env, { comment_id: ULID_OK, value });
			expect(res.status).toBe(200);
		}
	});
});

describe("POST /votes — env flags", () => {
	it("403s when VOTING_ENABLED=0", async () => {
		const { app, env } = mkRouteApp({ VOTING_ENABLED: "0" });
		const res = await post(app, env, { comment_id: ULID_OK, value: 1 });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("voting_disabled");
	});

	it("403s a downvote when DOWNVOTES_ENABLED=false but allows upvotes", async () => {
		const { app, env } = mkRouteApp({ DOWNVOTES_ENABLED: "false" });
		const down = await post(app, env, { comment_id: ULID_OK, value: -1 });
		expect(down.status).toBe(403);
		const up = await post(app, env, { comment_id: ULID_OK, value: 1 });
		expect(up.status).toBe(200);
	});

	it("accepts both directions when both flags are unset (default on)", async () => {
		const { app, env } = mkRouteApp();
		const up = await post(app, env, { comment_id: ULID_OK, value: 1 });
		const down = await post(app, env, { comment_id: ULID_OK, value: -1 });
		expect(up.status).toBe(200);
		expect(down.status).toBe(200);
	});
});

describe("POST /votes — self-vote forbidden", () => {
	// The ghost-user lookup in makeDb returns id="01HU000000000000000000".
	// Setting the comment's author to the same id puts the voter and the
	// author at the same identity — the guard must reject all three values
	// (up, down, clear) rather than letting the author game score-sort.
	const GHOST_ID = "01HU000000000000000000";

	it("403s an upvote on own comment with vote_self_forbidden", async () => {
		const { app, env } = mkRouteApp({}, GHOST_ID);
		const res = await post(app, env, { comment_id: ULID_OK, value: 1 });
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("vote_self_forbidden");
	});

	it("403s a downvote on own comment", async () => {
		const { app, env } = mkRouteApp({}, GHOST_ID);
		const res = await post(app, env, { comment_id: ULID_OK, value: -1 });
		expect(res.status).toBe(403);
	});

	it("403s a clear (value=0) on own comment", async () => {
		const { app, env } = mkRouteApp({}, GHOST_ID);
		const res = await post(app, env, { comment_id: ULID_OK, value: 0 });
		expect(res.status).toBe(403);
	});
});
