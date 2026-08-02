/**
 * Reply-nesting cap — API-level enforcement (src/routes/api.comments.ts).
 *
 * Nothing capped reply depth server-side: the route validated only that the
 * parent existed and shared the post, so a scripted client could POST an
 * arbitrarily deep chain. Tree assembly is O(N^2) in chain length, so a few
 * hundred links exceed the 10ms free-tier CPU budget and the slug's comment
 * list starts returning Error 1102 to every reader — permanently, because the
 * response never completes so the edge cache never populates.
 *
 * Runs against REAL SQLite (every migration applied) so `comments.depth`, the
 * insert that writes it, and the route check that reads it are all exercised
 * for real. Chains are built with direct INSERTs rather than N POSTs: the
 * subject under test is the *check*, and going through the route N times would
 * couple this suite to the rate limiter.
 *
 * The signed-in POST path is used deliberately (same reason as
 * thread-closure-api.test.ts): it skips Turnstile, which can't run offline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

// node:sqlite → D1 adapter (same shape as queries-comments-realdb.test.ts).
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
const USER = "01HU000000000000000000";
const SLUG = "deep";

const makeSessions = () => ({
	async get(key: string) {
		if (key !== `sess:${SID}`) return null;
		return JSON.stringify({ user_id: USER, expires_at: 4_102_444_800_000 });
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
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(USER, "anon", null, "Tester", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Deep", null, 1_700_000_000_000);
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

const app = () => new Hono<{ Bindings: Bindings }>().route("/", comments);

const post = (bodyObj: Record<string, unknown>) =>
	app().request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json", cookie: `garrul_sess=${SID}` },
			body: JSON.stringify(bodyObj),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

/** Inserts a chain of `n` comments (depths 1..n) and returns the deepest id. */
const seedChain = (n: number): string => {
	const stmt = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, created_at, depth)
		 VALUES (?, ?, ?, ?, 'x', '<p>x</p>', 1, 'approved', ?, ?)`,
	);
	let parent: string | null = null;
	let id = "";
	for (let d = 1; d <= n; d++) {
		id = `01HDEPTH${String(d).padStart(18, "0")}`;
		stmt.run(id, SLUG, parent, USER, 1_700_000_000_000 + d, d);
		parent = id;
	}
	return id;
};

const depthOf = (id: string): number =>
	(sqlite.prepare("SELECT depth FROM comments WHERE id = ?").get(id) as {
		depth: number;
	}).depth;

describe("reply nesting cap", () => {
	it("stores depth 1 for a top-level comment", async () => {
		const res = await post({ slug: SLUG, body: "top level" });
		expect(res.status).toBe(201);
		const json = (await res.json()) as { comment: { id: string } };
		expect(depthOf(json.comment.id)).toBe(1);
	});

	it("stores parent.depth + 1 for a reply", async () => {
		const parent = seedChain(3);
		const res = await post({ slug: SLUG, parent_id: parent, body: "a reply" });
		expect(res.status).toBe(201);
		const json = (await res.json()) as { comment: { id: string } };
		expect(depthOf(json.comment.id)).toBe(4);
	});

	it("accepts a reply that lands exactly on MAX_REPLY_DEPTH", async () => {
		const parent = seedChain(MAX_REPLY_DEPTH - 1);
		const res = await post({ slug: SLUG, parent_id: parent, body: "last allowed" });
		expect(res.status).toBe(201);
		const json = (await res.json()) as { comment: { id: string } };
		expect(depthOf(json.comment.id)).toBe(MAX_REPLY_DEPTH);
	});

	it("rejects a reply one past MAX_REPLY_DEPTH with 400 and writes nothing", async () => {
		const parent = seedChain(MAX_REPLY_DEPTH);
		const before = sqlite
			.prepare("SELECT COUNT(*) AS n FROM comments")
			.get() as { n: number };
		const res = await post({ slug: SLUG, parent_id: parent, body: "too deep" });
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toMatch(/nested too deeply/i);
		const after = sqlite
			.prepare("SELECT COUNT(*) AS n FROM comments")
			.get() as { n: number };
		expect(after.n).toBe(before.n);
	});

	it("still rejects when the parent is an over-deep pre-migration row", async () => {
		// Rows deeper than the cap predate it (imports, or chains created before
		// this shipped). They keep rendering; they just can't be replied to.
		const parent = seedChain(MAX_REPLY_DEPTH + 5);
		const res = await post({ slug: SLUG, parent_id: parent, body: "nope" });
		expect(res.status).toBe(400);
	});

	it("does not cap a sibling branch that is still shallow", async () => {
		seedChain(MAX_REPLY_DEPTH);
		// Depth is per-chain, not per-post: a fresh top-level comment is unaffected.
		const res = await post({ slug: SLUG, body: "new thread on the same post" });
		expect(res.status).toBe(201);
		const json = (await res.json()) as { comment: { id: string } };
		expect(depthOf(json.comment.id)).toBe(1);
	});
});
