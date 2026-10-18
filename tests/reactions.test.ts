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
import type { TestApp, } from "./helpers/app";
import { reactions } from "../src/routes/api.reactions";
import { bustSettingsCache } from "../src/lib/settings";
import type { Bindings } from "../src/index";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

const COMMENT_ID = "01HC000000000000000000ABCD";
const GHOST_ID = "01HU000000000000000000";

const makeDb = (status: string, settings: Record<string, string> = {}) => ({
	prepare: (sql: string) => ({
		bind() {
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
			// The IP-wide ban check (isIpHashBarred): no ghost on this IP is barred.
			if (sql.includes("SELECT 1 AS hit FROM users")) return null;
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
					// `USER_COLS` selects erased_at, so real D1 returns null.
					// Dropping it leaves `undefined`, which the active-user gate
					// reads as erased and refuses.
					erased_at: null,
				};
			}
			// toggleReaction's existence probe: no existing row, so it inserts.
			return null;
		},
		async all() {
			if (sql.includes("FROM settings")) {
				return {
					results: Object.entries(settings).map(([key, value]) => ({ key, value })),
				};
			}
			// The per-comment aggregate the route now sends back so the widget
			// can patch in place. Two kinds, one of them not the one being
			// toggled, so a test can tell a real aggregate from an echo.
			if (sql.includes("FROM reactions") && sql.includes("COUNT(*)")) {
				return {
					results: [
						{ kind: "fire", count: 3 },
						{ kind: "love", count: 1 },
					],
				};
			}
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

const mkApp = (status = "approved", settings: Record<string, string> = {}) => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/r", reactions);
	const env = {
		DB: makeDb(status, settings),
		TREE_CACHE: makeKv(),
		SESSIONS: makeKv(),
		ANALYTICS: { writeDataPoint: () => {} },
		IP_HASH_SECRET: "x".repeat(32),
	};
	return { app, env };
};

const post = async (
	app: TestApp,
	env: Record<string, unknown>,
	body: unknown,
) =>
	app.request(
		"/r",
		{
			method: "POST",
			// Cloudflare's edge sets this on every real request; requireIpHash
			// refuses the route without it outside dev.
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "203.0.113.7",
			},
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
		const res = await post(app, env, { kind: "fire" });
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

	it("rejects the retired `like` spelling with 400", async () => {
		// `like` became `fire` in v2.10.0 and was accepted on the wire as a
		// deprecated alias through v2.23.x. The alias is removed: pre-2.10.0
		// bundles aged out of every cache long ago (embed.js is cached for at
		// most ~25h), so a `like` today is a third-party script pinned to the
		// old spelling — see the breakingChanges entry in release-manifest.json.
		const { app, env } = mkApp();
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "like" });
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
				// Cloudflare's edge sets this on every real request;
				// requireIpHash refuses the route without it outside dev.
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": "203.0.113.7",
				},
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
			{ comment_id: COMMENT_ID, kind: "fire" },
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
				kind: "fire",
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
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "fire" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	it("returns authoritative per-comment counts, not just `added`", async () => {
		// The widget patches its reaction row from this instead of reloading the
		// whole thread, so an empty or missing `reactions` object is the shape
		// that would visibly blank a comment's reactions.
		installMockCaches();
		const { app, env } = mkApp("approved");
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "fire" });
		const body = (await res.json()) as {
			added: boolean;
			reactions: Record<string, number>;
		};
		expect(body.added).toBe(true);
		expect(body.reactions).toEqual({ fire: 3, love: 1 });
	});
});

describe("POST /reactions — only the operator's enabled kinds", () => {
	it("400s a known kind the operator turned off", async () => {
		const { app, env } = mkApp("approved", { comment_reaction_kinds: "fire,love" });
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "cry" });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_kind");
	});

	it("400s an opt-in kind while the list is at its default", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "rocket" });
		expect(res.status).toBe(400);
	});

	it("accepts an opt-in kind once enabled", async () => {
		installMockCaches();
		const { app, env } = mkApp("approved", { comment_reaction_kinds: "rocket" });
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "rocket" });
		expect(res.status).toBe(200);
	});

	// Deliberate: once a kind is off, its button is gone, so the same POST that
	// would toggle an earlier reaction off is refused too. The row stays counted.
	it("400s toggling off a kind the operator disabled after it was used", async () => {
		installMockCaches();
		const settings: Record<string, string> = { comment_reaction_kinds: "rocket" };
		const { app, env } = mkApp("approved", settings);
		const body = { comment_id: COMMENT_ID, kind: "rocket" };
		expect((await post(app, env, body)).status).toBe(200);
		settings.comment_reaction_kinds = "fire";
		await bustSettingsCache(env as unknown as Bindings); // an admin save
		const res = await post(app, env, body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_kind");
	});

	it("does not consult the page list", async () => {
		const { app, env } = mkApp("approved", { page_reaction_kinds: "rocket" });
		const res = await post(app, env, { comment_id: COMMENT_ID, kind: "rocket" });
		expect(res.status).toBe(400);
	});
});
