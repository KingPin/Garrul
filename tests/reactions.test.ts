/**
 * POST /api/v1/reactions — input validation and the status gate.
 *
 * The status gate is the security-relevant half: reactions used to be accepted
 * on anything that wasn't `deleted`, so a 200 on a `pending` or `spam` comment
 * confirmed to whoever held the id that a moderator had held it, and let
 * reaction rows pile up on content no reader can see. Every non-approved state
 * must look exactly like a missing row.
 *
 * No Miniflare: a hand-rolled D1 stub answers getComment/getOrCreateGhost and
 * the mock Cache API stands in for the edge cache that bustTreeCache touches.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { reactions } from "../src/routes/api.reactions";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

const COMMENT_ID = "01HC000000000000000000ABCD";
const GHOST_ID = "01HU000000000000000000";

const makeDb = (status: string) => ({
	prepare: (sql: string) => ({
		bind(..._args: unknown[]) {
			return this;
		},
		async first() {
			if (sql.includes("FROM comments WHERE id = ?")) {
				return {
					id: COMMENT_ID,
					post_slug: "hello",
					parent_id: null,
					user_id: "01HU111111111111111111",
					body_md: "x",
					body_html: "<p>x</p>",
					renderer_version: 1,
					status,
					edited_at: null,
					deleted_at: null,
					deleted_by: null,
					ip_hash: null,
					user_agent: null,
					created_at: 1,
					score_up: 0,
					score_down: 0,
					depth: 1,
				};
			}
			if (sql.includes("FROM users")) {
				return {
					id: GHOST_ID,
					provider: "anon",
					provider_id: null,
					name: "anon",
					email: null,
					avatar_url: null,
					is_admin: 0,
					is_banned: 0,
					role: "user",
					created_at: 1_700_000_000_000,
				};
			}
			// toggleReaction's existence probe: no existing row, so it inserts.
			return null;
		},
		async all() {
			return { results: [] };
		},
		async run() {
			return { meta: { changes: 1 } };
		},
	}),
	async batch() {
		return [];
	},
});

const makeKv = () => ({
	async get() {
		return null;
	},
	async put() {},
	async delete() {},
});

const mkApp = (status = "approved") => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/r", reactions);
	const env = {
		DB: makeDb(status),
		TREE_CACHE: makeKv(),
		SESSIONS: makeKv(),
		ANALYTICS: { writeDataPoint: () => {} },
		IP_HASH_SECRET: "x".repeat(32),
	};
	return { app, env };
};

const post = async (
	app: Hono,
	env: Record<string, unknown>,
	body: unknown,
) =>
	app.request(
		"/r",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		env,
	);

afterEach(() => {
	uninstallMockCaches();
});

describe("POST /reactions — input validation", () => {
	it("rejects a missing comment_id with 400", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, { kind: "like" });
		expect(res.status).toBe(400);
	});

	it("rejects an unknown kind with 400", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, {
			comment_id: COMMENT_ID,
			kind: "shrug",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_kind");
	});

	it("rejects a malformed JSON body with 400", async () => {
		const { app, env } = mkApp();
		const res = await app.request(
			"/r",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			},
			env,
		);
		expect(res.status).toBe(400);
	});

	it("403s when REACTIONS_ENABLED=0", async () => {
		const { app, env } = mkApp();
		const res = await post(
			app,
			{ ...env, REACTIONS_ENABLED: "0" },
			{ comment_id: COMMENT_ID, kind: "like" },
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("reactions_disabled");
	});
});

describe("POST /reactions — only approved comments are reactable", () => {
	for (const status of ["pending", "spam", "deleted"]) {
		it(`404s a reaction on a ${status} comment`, async () => {
			const { app, env } = mkApp(status);
			const res = await post(app, env, {
				comment_id: COMMENT_ID,
				kind: "like",
			});
			expect(res.status).toBe(404);
			// Same body as a missing row — nothing to key the moderation state off.
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("Not found.");
		});
	}

	it("still accepts a reaction on an approved comment", async () => {
		installMockCaches();
		const { app, env } = mkApp("approved");
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "like" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});
});
