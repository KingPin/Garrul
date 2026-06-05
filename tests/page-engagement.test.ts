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
 * No Miniflare: a small in-memory D1 that simulates the page_reactions /
 * page_votes / posts / users tables by matching on the SQL the query layer
 * issues, plus KV stubs for rate-limit + flag cache.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { pageEngagement } from "../src/routes/api.page-engagement";

type Reaction = { post_slug: string; user_id: string; kind: string };
type Vote = { post_slug: string; user_id: string; value: number };

const makeDb = () => {
	const posts = new Set<string>();
	const ghosts = new Map<string, string>(); // ip_hash -> user_id
	const reactions: Reaction[] = [];
	const votes: Vote[] = [];
	let ghostSeq = 0;

	const stmt = (sql: string) => {
		let binds: unknown[] = [];
		const api = {
			bind(...args: unknown[]) {
				binds = args;
				return api;
			},
			async run() {
				if (sql.includes("INSERT INTO posts")) {
					posts.add(String(binds[0]));
					return { meta: { changes: 1 } };
				}
				if (sql.includes("INSERT INTO users")) {
					// getOrCreateGhost: (id, provider_id, name, created_at)
					ghosts.set(String(binds[1]), String(binds[0]));
					return { meta: { changes: 1 } };
				}
				if (sql.includes("INSERT INTO page_reactions")) {
					const [post_slug, user_id, kind] = binds as string[];
					const dup = reactions.some(
						(r) =>
							r.post_slug === post_slug &&
							r.user_id === user_id &&
							r.kind === kind,
					);
					if (dup) return { meta: { changes: 0 } };
					reactions.push({ post_slug, user_id, kind });
					return { meta: { changes: 1 } };
				}
				if (sql.includes("DELETE FROM page_reactions")) {
					const [post_slug, user_id, kind] = binds as string[];
					for (let i = reactions.length - 1; i >= 0; i--) {
						const r = reactions[i]!;
						if (
							r.post_slug === post_slug &&
							r.user_id === user_id &&
							r.kind === kind
						)
							reactions.splice(i, 1);
					}
					return { meta: { changes: 1 } };
				}
				if (sql.includes("DELETE FROM page_votes")) {
					const [post_slug, user_id] = binds as string[];
					for (let i = votes.length - 1; i >= 0; i--) {
						const v = votes[i]!;
						if (v.post_slug === post_slug && v.user_id === user_id)
							votes.splice(i, 1);
					}
					return { meta: { changes: 1 } };
				}
				if (sql.includes("INSERT INTO page_votes")) {
					const [post_slug, user_id, value] = binds as [string, string, number];
					const existing = votes.find(
						(v) => v.post_slug === post_slug && v.user_id === user_id,
					);
					if (existing) existing.value = value;
					else votes.push({ post_slug, user_id, value });
					return { meta: { changes: 1 } };
				}
				return { meta: { changes: 0 } };
			},
			async first<T>() {
				if (sql.includes("FROM users")) {
					// getOrCreateGhost lookup by ip_hash
					const ip = String(binds[0]);
					const id = ghosts.get(ip);
					if (!id) return null;
					return {
						id,
						provider: "anon",
						provider_id: ip,
						name: "anon",
						email: null,
						avatar_url: null,
						is_admin: 0,
						is_banned: 0,
						role: "user",
						created_at: 1,
					} as T;
				}
				if (sql.includes("FROM posts")) {
					return {
						slug: String(binds[0]),
						title: null,
						url: null,
						created_at: 1,
					} as T;
				}
				if (sql.includes("page_votes")) {
					// reselectPageVote: bind(post_slug, user_id)
					const [post_slug, user_id] = binds as string[];
					const up = votes.filter(
						(v) => v.post_slug === post_slug && v.value === 1,
					).length;
					const down = votes.filter(
						(v) => v.post_slug === post_slug && v.value === -1,
					).length;
					const mine =
						votes.find(
							(v) => v.post_slug === post_slug && v.user_id === user_id,
						)?.value ?? 0;
					return { score_up: up, score_down: down, my_vote: mine } as T;
				}
				return null;
			},
			async all<T>() {
				if (sql.includes("GROUP BY kind")) {
					const post_slug = String(binds[0]);
					const byKind = new Map<string, number>();
					for (const r of reactions) {
						if (r.post_slug === post_slug)
							byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
					}
					return {
						results: [...byKind].map(([kind, count]) => ({ kind, count })),
					} as { results: T[] };
				}
				if (sql.includes("SELECT kind FROM page_reactions")) {
					const [post_slug, user_id] = binds as string[];
					return {
						results: reactions
							.filter(
								(r) => r.post_slug === post_slug && r.user_id === user_id,
							)
							.map((r) => ({ kind: r.kind })),
					} as { results: T[] };
				}
				return { results: [] as T[] };
			},
		};
		return api;
	};

	return {
		db: { prepare: (sql: string) => stmt(sql) },
		state: { posts, reactions, votes },
		nextGhost: () => `ghost-${ghostSeq++}`,
	};
};

const kvNull = {
	get: async () => null,
	put: async () => {},
	delete: async () => {},
};

const mkApp = (flags: Record<string, boolean>) => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/", pageEngagement);
	const { db } = makeDb();
	const flagCache = {
		get: async (_k: string, type?: string) =>
			type === "json"
				? {
						comments_enabled: true,
						reactions_enabled: true,
						votes_enabled: true,
						downvotes_enabled: true,
						page_reactions_enabled: false,
						page_votes_enabled: false,
						...flags,
					}
				: null,
		put: async () => {},
		delete: async () => {},
	};
	const env = {
		DB: db,
		TREE_CACHE: flagCache,
		RATE_LIMITS: kvNull,
		SESSIONS: kvNull,
		IP_HASH_SECRET: "x".repeat(32),
		ANALYTICS: { writeDataPoint: () => {} },
	};
	return { app, env };
};

const post = (
	app: Hono,
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
		const res = await post(app, env, "/reactions", { slug: "p", kind: "like" });
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"page_reactions_disabled",
		);
	});
});

describe("page reactions — toggle/dedup", () => {
	it("adds then removes on a repeat click from the same IP", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const r1 = await post(app, env, "/reactions", { slug: "p", kind: "like" });
		const b1 = (await r1.json()) as {
			added: boolean;
			reactions: Record<string, number>;
		};
		expect(b1.added).toBe(true);
		expect(b1.reactions.like).toBe(1);

		const r2 = await post(app, env, "/reactions", { slug: "p", kind: "like" });
		const b2 = (await r2.json()) as {
			added: boolean;
			reactions: Record<string, number>;
		};
		expect(b2.added).toBe(false);
		expect(b2.reactions.like ?? 0).toBe(0);
	});

	it("rejects an unknown reaction kind with 400", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", { slug: "p", kind: "nope" });
		expect(res.status).toBe(400);
	});

	it("rejects a bad slug with 400", async () => {
		const { app, env } = mkApp({ page_reactions_enabled: true });
		const res = await post(app, env, "/reactions", {
			slug: "bad slug!",
			kind: "like",
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
