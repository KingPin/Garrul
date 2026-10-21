/**
 * Page-level engagement route tests (POST/GET /api/v1/page-engagement/*).
 *
 * Covers the things that actually matter for this surface:
 *   - flag gating: 403 when the page_* flag is off,
 *   - per-user dedup/toggle: a repeat click from the same ghost removes the
 *     row rather than stacking, and the returned totals reflect it,
 *   - vote tally + clear,
 *   - input validation (bad slug, bad kind, bad value).
 *
 * No Miniflare: real SQLite for the tables, KV stubs for rate-limit;
 * settings come from rows the wrapper below serves.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { TestApp, } from "./helpers/app";
import { pageEngagement } from "../src/routes/api.page-engagement";
import { bustSettingsCache } from "../src/lib/settings";
import type { Bindings } from "../src/index";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { makeD1 } from "./helpers/admin-sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

// Real SQLite with every migration applied, so the totals the routes return
// come from the same write-time recounts production runs.
const makeDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	return { db: makeD1(sqlite) };
};

const kvNull = {
	get: async () => null,
	put: async () => {},
	delete: async () => {},
};

const mkApp = (flags: Record<string, boolean>, texts: Record<string, string> = {}) => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/", pageEngagement);
	const { db } = makeDb();
	// Settings come from `settings` rows served by the D1 stub, which is where
	// the loader reads them. Defaults are applied by the loader.
	// `texts` is read at query time so a test can edit it, then bust the memo.
	const rows = () => [
		...Object.entries(flags).map(([key, v]) => ({ key, value: String(v) })),
		...Object.entries(texts).map(([key, value]) => ({ key, value })),
	];
	const settingsDb = {
		prepare: (sql: string) =>
			/FROM settings/i.test(sql)
				? { all: async () => ({ results: rows() }) }
				: db.prepare(sql),
		batch: (stmts: never) => db.batch(stmts),
	};
	const env = {
		DB: settingsDb,
		TREE_CACHE: kvNull,
		RATE_LIMITS: kvNull,
		SESSIONS: kvNull,
		IP_HASH_SECRET: "x".repeat(32),
		ANALYTICS: { writeDataPoint: () => {} },
	};
	return { app, env };
};

const post = (
	app: TestApp,
	env: Record<string, unknown>,
	path: string,
	body: unknown,
	ip = "1.2.3.4",
) =>
	app.request(
		path,
		{
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": ip },
			body: JSON.stringify(body),
		},
		env,
	);

describe("page reactions — flag gating", () => {
	it("403s when page_reactions_enabled is off", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: false });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "fire" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"page_reactions_disabled",
		);
	});
});

describe("page reactions — toggle/dedup", () => {
	it("adds then removes on a repeat click from the same IP", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const r1 = await post(app, env, "/reactions", { slug: "p", kind: "fire" });
		const b1 = (await r1.json()) as {
			added: boolean;
			reactions: Record<string, number>;
		};
		expect(b1.added).toBe(true);
		expect(b1.reactions.fire).toBe(1);

		const r2 = await post(app, env, "/reactions", { slug: "p", kind: "fire" });
		const b2 = (await r2.json()) as {
			added: boolean;
			reactions: Record<string, number>;
		};
		expect(b2.added).toBe(false);
		expect(b2.reactions.fire ?? 0).toBe(0);
	});

	it("rejects an unknown reaction kind with 400", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "nope" });
		expect(res.status).toBe(400);
	});

	it("rejects the retired `like` spelling with 400", async () => {
		// `like` became `fire` in v2.10.0 and was accepted on the wire as a
		// deprecated alias through v2.23.x; the alias is removed, so the old
		// spelling fails the same membership check as any unknown kind.
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "like" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_kind");
	});

	it("keys totals by the stored kind alone", async () => {
		// Response-shape pin: `reactions` is exactly the aggregate over stored
		// rows — no synthesized keys.
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "fire" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { reactions: Record<string, number> };
		expect(Object.keys(body.reactions)).toEqual(["fire"]);
	});

	it("rejects a bad slug with 400", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", {
			slug: "bad slug!",
			kind: "fire",
		});
		expect(res.status).toBe(400);
	});
});

describe("page votes — flag gating + tally", () => {
	it("403s when page_votes_enabled is off", async () => {
		const { app, env } = mkApp({ page_votes_enabled: false });
		const res = await post(app, env, "/votes", { slug: "p", value: 1 });
		expect(res.status).toBe(403);
	});

	it("counts an upvote then clears it on toggle", async () => {
		const { app, env } = mkApp({ page_votes_enabled: true });
		const r1 = await post(app, env, "/votes", { slug: "p", value: 1 });
		const b1 = (await r1.json()) as {
			score_up: number;
			my_vote: number;
		};
		expect(b1.score_up).toBe(1);
		expect(b1.my_vote).toBe(1);

		const r2 = await post(app, env, "/votes", { slug: "p", value: 0 });
		const b2 = (await r2.json()) as { score_up: number; my_vote: number };
		expect(b2.score_up).toBe(0);
		expect(b2.my_vote).toBe(0);
	});

	it("403s a downvote when downvotes are disabled", async () => {
		const { app, env } = mkApp({
			page_votes_enabled: true,
			downvotes_enabled: false,
		});
		const res = await post(app, env, "/votes", { slug: "p", value: -1 });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"downvotes_disabled",
		);
	});

	it("rejects an out-of-range value with 400", async () => {
		const { app, env } = mkApp({ page_votes_enabled: true });
		const res = await post(app, env, "/votes", { slug: "p", value: 2 });
		expect(res.status).toBe(400);
	});
});

describe("page-engagement GET — initial state", () => {
	it("returns only the enabled sections", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await app.request(
			"/?slug=p",
			{ headers: { "cf-connecting-ip": "1.2.3.4" } },
			env,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("reactions");
		expect(body).not.toHaveProperty("votes");
	});
});

describe("page engagement — string votes and the per-IP budget", () => {
	it("accepts the string spellings of a vote from a form post", async () => {
		const { app, env } = mkApp({ page_votes_enabled: true });
		const up = (await (await post(app, env, "/votes", { slug: "p", value: "1" }, "10.0.0.1")).json()) as {
			my_vote: number;
		};
		expect(up.my_vote).toBe(1);
		const down = (await (await post(app, env, "/votes", { slug: "p", value: "-1" }, "10.0.0.2")).json()) as {
			my_vote: number;
		};
		expect(down.my_vote).toBe(-1);
		const clear = (await (await post(app, env, "/votes", { slug: "p", value: "0" }, "10.0.0.3")).json()) as {
			my_vote: number;
		};
		expect(clear.my_vote).toBe(0);
	});

	it("429s a second reaction and a second vote from one address inside the window", async () => {
		installMockCaches();
		try {
			const { app, env } = mkApp({ page_reactions_enabled: true, page_votes_enabled: true });
			expect((await post(app, env, "/reactions", { slug: "p", kind: "fire" })).status).toBe(200);
			expect((await post(app, env, "/reactions", { slug: "p", kind: "fire" })).status).toBe(429);
			expect((await post(app, env, "/votes", { slug: "p", value: 1 })).status).toBe(200);
			expect((await post(app, env, "/votes", { slug: "p", value: 1 })).status).toBe(429);
		} finally {
			uninstallMockCaches();
		}
	});
});

describe("page reactions — only the operator's enabled kinds", () => {
	it("400s a known kind the operator turned off", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true }, { page_reaction_kinds: "fire,love" });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "cry" }, "10.0.4.1");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_kind");
	});

	it("accepts an opt-in kind once enabled", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true }, { page_reaction_kinds: "rocket" });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "rocket" }, "10.0.4.2");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { reactions: Record<string, number> }).reactions).toEqual({ rocket: 1 });
	});

	// Deliberate: the same POST that would toggle the earlier reaction off is
	// refused once the kind is disabled. The stored row stays counted.
	it("400s toggling off a kind the operator disabled after it was used", async () => {
		const texts: Record<string, string> = { page_reaction_kinds: "rocket" };
		const { app, env } = mkApp({ page_reactions_enabled: true }, texts);
		const body = { slug: "p", kind: "rocket" };
		expect((await post(app, env, "/reactions", body, "10.0.4.4")).status).toBe(200);
		texts.page_reaction_kinds = "fire";
		await bustSettingsCache(env as unknown as Bindings); // an admin save
		const res = await post(app, env, "/reactions", body, "10.0.4.4");
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("invalid_kind");
	});

	it("does not consult the comment list", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true }, { comment_reaction_kinds: "rocket" });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "rocket" }, "10.0.4.3");
		expect(res.status).toBe(400);
	});
});
