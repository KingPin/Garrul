/**
 * `GET /api/v1/bootstrap` — the widget's single mount call.
 *
 * The contract this endpoint lives or dies by is **section equivalence**: each
 * section must be byte-identical to what its standalone endpoint returns for the
 * same inputs. That is what lets the widget parse both boot paths with one set of
 * code, and it is what makes the legacy fallback equivalent rather than merely
 * similar. So most of these tests do not assert a literal shape — they diff
 * bootstrap against the real `/config`, `/auth/me`, `/comments`,
 * `/page-engagement` and `/subscribe/mine`, mounted on the same DB and env.
 * A literal expectation would drift the moment one of those five changed; a diff
 * cannot.
 *
 * The cache tests matter for a different reason. Bootstrap deliberately reuses
 * `/comments`' own tree-cache entry instead of minting a key of its own, so that
 * `bustTreeCache` keeps covering both paths without knowing bootstrap exists.
 * These pin all three halves of that: same key, warmed either way, and — the
 * half that would leak — a signed-in bootstrap still neither reads nor writes it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootstrap } from "../src/routes/api.bootstrap";
import { comments } from "../src/routes/api.comments";
import { config } from "../src/routes/api.config";
import { pageEngagement } from "../src/routes/api.page-engagement";
import { subscriptions } from "../src/routes/api.subscriptions";
import { auth } from "../src/routes/auth";
import { localeMiddleware } from "../src/lib/locale";
import { sessionMiddleware } from "../src/lib/session";
import { treeCacheKey } from "../src/lib/tree-cache";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";
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
const USER = "01HU00000000000000VIEWER";
const EMAIL = "viewer@example.com";
const SLUG = "hello-world";
const PAGE_SIZE = 25;
const COMMENT = "01HC00000000000000000001";

let sqlite: DatabaseSync;
let cache: MockCache;
let env: Bindings;

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

/** All five surfaces on one app, so a diff runs against the real handlers. */
const app = () =>
	new Hono<{ Bindings: Bindings }>()
		.use("/api/*", localeMiddleware())
		.route("/api/v1/bootstrap", bootstrap)
		.route("/api/v1/comments", comments)
		.route("/api/v1/config", config)
		.route("/api/v1/auth", auth)
		.route("/api/v1/page-engagement", pageEngagement)
		.route("/api/v1/subscribe", subscriptions);

const get = (path: string, sid?: string) =>
	app().request(
		`http://localhost${path}`,
		{ headers: sid ? { cookie: `garrul_sess=${sid}` } : {} },
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const json = async (path: string, sid?: string) =>
	(await (await get(path, sid)).json()) as Record<string, any>;

beforeEach(() => {
	cache = installMockCaches();
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
			 VALUES (?, 'github', 'gh-1', 'Viewer', ?, NULL, 0, 'user', ?)`,
		)
		.run(USER, EMAIL, 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Hello", null, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', ?, 1)`,
		)
		.run(COMMENT, SLUG, USER, 1_700_000_000_000);

	env = {
		DB: makeD1(sqlite),
		// Settings resolve from D1/env each call — this stub only has to not throw.
		TREE_CACHE: {
			get: async () => null,
			put: async () => {},
			delete: async () => {},
		},
		SESSIONS: {
			async get(key: string) {
				return key === `sess:${SID}`
					? JSON.stringify({ user_id: USER, expires_at: 4_102_444_800_000 })
					: null;
			},
			async put() {},
			async delete() {},
		},
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		TURNSTILE_SITE_KEY: "site-key",
		TURNSTILE_SECRET: "secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

describe("bootstrap — section equivalence", () => {
	it("serves the same config body as GET /config", async () => {
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		const standalone = await json("/api/v1/config");
		expect(boot.config).toEqual(standalone);
	});

	it("resolves the locale the same way /config does", async () => {
		// The widget echoes this answer back as ?lang= on every later call, so the
		// two boot paths disagreeing about language would be silent and durable.
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}&lang=de`);
		const standalone = await json("/api/v1/config?lang=de");
		expect(boot.config).toEqual(standalone);
		expect(boot.config.locale).toBe("de");
	});

	it("serves the same comment tree as GET /comments, anonymous", async () => {
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		const standalone = await json(`/api/v1/comments?slug=${SLUG}`);
		expect(boot.comments).toEqual(standalone);
		expect(boot.comments.threads).toHaveLength(1);
	});

	it("serves the same comment tree as GET /comments, signed in", async () => {
		// The signed-in payload is the one that carries my_vote / mine / pending,
		// and the one that skips the cache — so it is a separate code path.
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(`/api/v1/comments?slug=${SLUG}`, SID);
		expect(boot.comments).toEqual(standalone);
	});

	it("honors ?sort=top like GET /comments", async () => {
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}&sort=top`);
		const standalone = await json(`/api/v1/comments?slug=${SLUG}&sort=top`);
		expect(boot.comments).toEqual(standalone);
	});

	it("serves the same user object as GET /auth/me", async () => {
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const me = await json("/api/v1/auth/me", SID);
		expect(boot.user).toEqual(me.user);
		expect(boot.user.id).toBe(USER);
	});

	it("reports user: null for an anonymous reader", async () => {
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(boot.user).toBeNull();
		const me = await json("/api/v1/auth/me");
		expect(boot.user).toEqual(me.user);
	});
});

describe("bootstrap — session reads", () => {
	/**
	 * The app above routes bootstrap directly, which is the mount that has to keep
	 * working; this one adds the middleware every real `/api/*` request runs
	 * through, so both branches of the session read are covered.
	 */
	const mounted = () =>
		new Hono<{ Bindings: Bindings }>()
			.use("/api/*", localeMiddleware())
			.use("/api/*", sessionMiddleware() as never)
			.route("/api/v1/bootstrap", bootstrap);

	/** Wraps SESSIONS so a test can see which keys were fetched, and how often. */
	const countKeys = () => {
		const inner = env.SESSIONS;
		const keys: string[] = [];
		(env as { SESSIONS: unknown }).SESSIONS = {
			async get(key: string) {
				keys.push(key);
				return inner.get(key);
			},
			async put() {},
			async delete() {},
		};
		return keys;
	};

	it("reads the session record once when the middleware already has it", async () => {
		// The whole mount now hangs off this one request, so a second readSession
		// here is two KV reads — and a second chance at a TTL-slide write — on
		// every signed-in pageview.
		const keys = countKeys();
		const res = await mounted().request(
			`http://localhost/api/v1/bootstrap?slug=${SLUG}`,
			{ headers: { cookie: `garrul_sess=${SID}` } },
			env as unknown as Record<string, unknown>,
			execCtx,
		);
		expect(res.status).toBe(200);
		expect(keys.filter((k) => k === `sess:${SID}`)).toHaveLength(1);
	});

	it("resolves the same identity through the middleware as without it", async () => {
		const viaMiddleware = (await (
			await mounted().request(
				`http://localhost/api/v1/bootstrap?slug=${SLUG}`,
				{ headers: { cookie: `garrul_sess=${SID}` } },
				env as unknown as Record<string, unknown>,
				execCtx,
			)
		).json()) as Record<string, any>;
		const direct = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		expect(viaMiddleware.user).toEqual(direct.user);
		expect(viaMiddleware.user.id).toBe(USER);
		expect(viaMiddleware.comments).toEqual(direct.comments);
	});

	it("reports an anonymous reader through the middleware", async () => {
		// `userId` is set-but-null here, which must not be confused with the
		// never-set case that falls back to readSession.
		const boot = (await (
			await mounted().request(
				`http://localhost/api/v1/bootstrap?slug=${SLUG}`,
				{},
				env as unknown as Record<string, unknown>,
				execCtx,
			)
		).json()) as Record<string, any>;
		expect(boot.user).toBeNull();
	});
});

describe("bootstrap — engagement section", () => {
	it("is omitted when both page surfaces are off", async () => {
		// Default-off, so the common install pays no bytes and no D1 reads for it.
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(boot).not.toHaveProperty("engagement");
	});

	it("matches GET /page-engagement when reactions are on", async () => {
		env = { ...env, PAGE_REACTIONS_ENABLED: "true" } as unknown as Bindings;
		sqlite
			.prepare(
				`INSERT INTO page_reactions (post_slug, user_id, kind, created_at)
				 VALUES (?, ?, 'fire', ?)`,
			)
			.run(SLUG, USER, 1_700_000_000_000);

		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(`/api/v1/page-engagement?slug=${SLUG}`, SID);
		expect(boot.engagement).toEqual(standalone);
		expect(boot.engagement.reactions).toEqual({ fire: 1 });
		expect(boot.engagement.my_reactions).toEqual(["fire"]);
	});

	it("matches GET /page-engagement when votes are on", async () => {
		env = { ...env, PAGE_VOTES_ENABLED: "true" } as unknown as Bindings;
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(`/api/v1/page-engagement?slug=${SLUG}`, SID);
		expect(boot.engagement).toEqual(standalone);
		expect(boot.engagement).toHaveProperty("votes");
		expect(boot.engagement).not.toHaveProperty("reactions");
	});

	it("gives an anonymous reader totals but no personal state", async () => {
		env = { ...env, PAGE_REACTIONS_ENABLED: "true" } as unknown as Bindings;
		sqlite
			.prepare(
				`INSERT INTO page_reactions (post_slug, user_id, kind, created_at)
				 VALUES (?, ?, 'fire', ?)`,
			)
			.run(SLUG, USER, 1_700_000_000_000);

		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(boot.engagement.reactions).toEqual({ fire: 1 });
		// No ghost user is minted on a GET just to answer "mine".
		expect(boot.engagement.my_reactions).toEqual([]);
	});
});

describe("bootstrap — subscription section", () => {
	const mailEnv = () =>
		({
			...env,
			EMAIL_FROM: "noreply@example.com",
			PUBLIC_BASE_URL: "https://comments.example.com",
		}) as unknown as Bindings;

	const subscribe = (confirmed: boolean) =>
		sqlite
			.prepare(
				`INSERT INTO subscriptions (id, post_slug, email, token, created_at,
				                            confirm_token, confirmed_at)
				 VALUES ('01HS00000000000000000001', ?, ?, 'tok', ?, 'ctok', ?)`,
			)
			.run(SLUG, EMAIL, 1_700_000_000_000, confirmed ? 1_700_000_000_000 : null);

	it("is omitted for an anonymous reader", async () => {
		env = mailEnv();
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(boot).not.toHaveProperty("subscription");
	});

	it("is omitted when the install cannot send mail", async () => {
		// Same pair POST /subscribe fails closed on: offering a bell that would
		// 503 is worse than not offering one.
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		expect(boot).not.toHaveProperty("subscription");
	});

	it("matches GET /subscribe/mine for a confirmed subscriber", async () => {
		env = mailEnv();
		subscribe(true);
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(
			`/api/v1/subscribe/mine?post_slug=${SLUG}`,
			SID,
		);
		expect(boot.subscription).toEqual(standalone);
		expect(boot.subscription).toEqual({
			subscribed: true,
			pending: false,
			id: "01HS00000000000000000001",
		});
	});

	it("matches GET /subscribe/mine for an unconfirmed subscriber", async () => {
		env = mailEnv();
		subscribe(false);
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(
			`/api/v1/subscribe/mine?post_slug=${SLUG}`,
			SID,
		);
		expect(boot.subscription).toEqual(standalone);
		expect(boot.subscription.pending).toBe(true);
	});

	it("matches GET /subscribe/mine when not subscribed", async () => {
		env = mailEnv();
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		const standalone = await json(
			`/api/v1/subscribe/mine?post_slug=${SLUG}`,
			SID,
		);
		expect(boot.subscription).toEqual(standalone);
		expect(boot.subscription.subscribed).toBe(false);
	});

	it("is omitted for a banned reader", async () => {
		// How /subscribe/mine's 403 reads once folded into a 200 envelope. The
		// `user` section still reports them — that answers identity, not authority.
		env = mailEnv();
		subscribe(true);
		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(USER);
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		expect(boot).not.toHaveProperty("subscription");
		expect(boot.user.id).toBe(USER);
	});
});

describe("bootstrap — tree cache is the same entry /comments uses", () => {
	/** The key the tree route computes for an anonymous first page of this slug. */
	const keyUrl = (from: string): string =>
		treeCacheKey(`http://localhost${from}`, SLUG, "new", PAGE_SIZE, null).url;

	it("keys off the origin only, so both routes agree", async () => {
		// This is the mechanism the rest of this block depends on: the cache key is
		// synthesized from the request's origin, not its path, so a request to
		// /bootstrap and one to /comments land on the identical entry.
		expect(keyUrl(`/api/v1/bootstrap?slug=${SLUG}`)).toBe(
			keyUrl(`/api/v1/comments?slug=${SLUG}`),
		);
	});

	it("warms the shared entry from an anonymous bootstrap", async () => {
		await get(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(cache.store.has(keyUrl("/api/v1/comments"))).toBe(true);
	});

	it("serves a tree warmed by /comments", async () => {
		cache.store.set(
			keyUrl("/api/v1/comments"),
			new Response(JSON.stringify({ threads: [], sentinel: "from-comments" })),
		);
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(boot.comments.sentinel).toBe("from-comments");
		// The envelope is still fully built around the embedded hit.
		expect(boot.config).toBeTruthy();
	});

	it("lets /comments serve a tree warmed by bootstrap", async () => {
		await get(`/api/v1/bootstrap?slug=${SLUG}`);
		const stored = cache.store.get(keyUrl("/api/v1/comments"));
		expect(stored).toBeTruthy();
		const viaComments = await json(`/api/v1/comments?slug=${SLUG}`);
		expect(viaComments.threads).toHaveLength(1);
	});

	it("does not store a signed-in bootstrap", async () => {
		await get(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		expect(cache.store.has(keyUrl("/api/v1/comments"))).toBe(false);
	});

	it("does not serve a signed-in bootstrap from the cache", async () => {
		cache.store.set(
			keyUrl("/api/v1/comments"),
			new Response(JSON.stringify({ threads: [], sentinel: "anonymous" })),
		);
		const boot = await json(`/api/v1/bootstrap?slug=${SLUG}`, SID);
		expect(boot.comments).not.toHaveProperty("sentinel");
		expect(boot.comments.threads).toHaveLength(1);
	});

	it("carries no Cache-Control of its own", async () => {
		// It varies by locale and by session; a browser-cached copy reused across
		// auth states would hand one reader another's identity.
		const res = await get(`/api/v1/bootstrap?slug=${SLUG}`);
		expect(res.headers.get("cache-control")).toBeNull();
	});
});

describe("bootstrap — slug validation", () => {
	it("rejects a missing slug", async () => {
		const res = await get("/api/v1/bootstrap");
		expect(res.status).toBe(400);
	});

	it("rejects a malformed slug identically to /comments", async () => {
		const bad = encodeURIComponent("a b<c>");
		const res = await get(`/api/v1/bootstrap?slug=${bad}`);
		expect(res.status).toBe(400);
		const viaComments = await get(`/api/v1/comments?slug=${bad}`);
		expect(viaComments.status).toBe(400);
		expect(await res.json()).toEqual(await viaComments.json());
	});

	it("answers a slug with no post row", async () => {
		// A page nobody has commented on yet is a normal case, not an error: the
		// widget still needs config, identity and an empty tree to render.
		const boot = await json("/api/v1/bootstrap?slug=fresh-page");
		expect(boot.comments.threads).toEqual([]);
		expect(boot.comments.accepting_comments).toBe(true);
		expect(boot.config).toBeTruthy();
	});
});
