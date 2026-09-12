/**
 * Thread closure — API-level enforcement (src/routes/api.comments.ts).
 *
 * resolveThreadOpen is unit-tested in thread.test.ts; this exercises the route
 * that consults it, against REAL SQLite (node:sqlite, every migration applied)
 * so the upsertPost → resolveThreadOpen → insert path runs end-to-end:
 *
 *   - POST is rejected 403 when the post is manually closed, for both a
 *     top-level comment AND a reply (the gate runs before the parent lookup).
 *   - POST still succeeds on an open post.
 *   - GET carries accepting_comments + closed_reason so the widget can render
 *     the closed state.
 *
 * The signed-in POST path is used deliberately: it skips Turnstile and the
 * rate-limit, neither of which can run offline, while still hitting the exact
 * closure gate the anonymous path uses.
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
	async batch(stmts: { all: () => Promise<{ results: unknown[] }> }[]) {
		return Promise.all(stmts.map((s) => s.all()));
	},
});

const SID = "a".repeat(64);
const USER = "01HU000000000000000000";

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const db = makeD1(sqlite);
	return { sqlite, db };
};

// Far-future-expiry SESSIONS double mapping our one session to USER.
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
	// Installed for the side effect: the routes under test reach for
	// `caches.default`, which does not exist in the node pool.
	installMockCaches();
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	// One signed-in, non-banned user to author comments.
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(USER, "anon", null, "Tester", 1_700_000_000_000);
	env = {
		DB: fresh.db,
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		EDIT_WINDOW_MINUTES: "15",
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const app = () => new Hono<{ Bindings: Bindings }>().route("/", comments);

// Workers ExecutionContext double. The POST handler reads c.executionCtx to
// schedule webhook/notification fanout via waitUntil; Hono throws on the getter
// when no context is supplied, so the route needs one even in tests.
const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

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

const closePost = (slug: string) =>
	sqlite.prepare("UPDATE posts SET closed = 1 WHERE slug = ?").run(slug);

describe("thread closure — POST gate", () => {
	it("accepts a comment on an open post", async () => {
		const res = await post({ slug: "open-post", body: "hello there" });
		expect(res.status).toBe(201);
	});

	it("rejects a new top-level comment with 403 on a closed post", async () => {
		// Create the post via a first comment, then freeze it.
		await post({ slug: "frozen", body: "first comment" });
		closePost("frozen");
		const res = await post({ slug: "frozen", body: "second comment" });
		expect(res.status).toBe(403);
		const json = (await res.json()) as { error: string };
		expect(json.error).toMatch(/closed/i);
	});

	it("rejects a REPLY with 403 on a closed post (gate runs before parent lookup)", async () => {
		const first = await post({ slug: "frozen2", body: "parent comment" });
		const parent = (await first.json()) as { comment: { id: string } };
		closePost("frozen2");
		const res = await post({
			slug: "frozen2",
			parent_id: parent.comment.id,
			body: "a reply",
		});
		expect(res.status).toBe(403);
	});

	it("does not let a later request overwrite an established published_at anchor", async () => {
		const real = 1_700_000_000_000; // host's real publish time, set on first comment
		const bogus = 1_000_000_000_000; // ~year 2001, a poison attempt
		const publishedAt = (slug: string) =>
			(sqlite.prepare("SELECT published_at FROM posts WHERE slug = ?").get(slug) as {
				published_at: number | null;
			}).published_at;

		await post({ slug: "anchored", body: "first", post_published: real });
		expect(publishedAt("anchored")).toBe(real);

		// A second comment carrying a bogus older anchor must not clobber it.
		const res = await post({ slug: "anchored", body: "second", post_published: bogus });
		expect(res.status).toBe(201);
		expect(publishedAt("anchored")).toBe(real);
	});

	it("does not persist published_at when the gate rejects the request", async () => {
		await post({ slug: "frozen3", body: "first comment" });
		closePost("frozen3");
		const res = await post({
			slug: "frozen3",
			body: "blocked",
			post_published: 1_000_000_000_000,
		});
		expect(res.status).toBe(403);
		const row = sqlite
			.prepare("SELECT published_at FROM posts WHERE slug = ?")
			.get("frozen3") as { published_at: number | null };
		expect(row.published_at).toBeNull();
	});

	it("does not let a later request fill a NULL published_at anchor", async () => {
		// The hole first-writer-wins left: COALESCE only defends a value already
		// stored, and NULL is the normal state — the row is created by whatever
		// touches the slug first (a reaction, a page vote, an admin pre-close, or
		// a comment from a host page that sends no `data-published`). So any
		// later commenter could stamp an old date on an established thread and,
		// with auto_close_days set, close it for good.
		await post({ slug: "unanchored", body: "first comment" });
		const res = await post({
			slug: "unanchored",
			body: "second comment",
			post_published: 1_000_000_000_000,
		});
		expect(res.status).toBe(201);
		const row = sqlite
			.prepare("SELECT published_at FROM posts WHERE slug = ?")
			.get("unanchored") as { published_at: number | null };
		expect(row.published_at).toBeNull();
	});

	it("closes the poisoned thread when the anchor is accepted, proving the impact", async () => {
		// Why the anchor is worth protecting at all: with auto_close_days set, an
		// anchor old enough puts the thread past the cutoff, and closure is
		// evaluated lazily on every later request — so the poison needs no
		// follow-up. Set here through the one path that legitimately can (the
		// row-creating write) to pin the consequence rather than assume it.
		env = { ...env, AUTO_CLOSE_DAYS: "30" } as unknown as Bindings;
		const created = await post({
			slug: "aged",
			body: "first comment",
			post_published: 1_000_000_000_000, // ~year 2001
		});
		expect(created.status).toBe(201);
		const res = await post({ slug: "aged", body: "second comment" });
		expect(res.status).toBe(403);
		expect((await res.json()) as { error: string }).toMatchObject({
			error: expect.stringMatching(/closed/i),
		});
	});

	it("writes no post metadata when the parent check rejects the request", async () => {
		// upsertPost used to run before the parent lookup, so a reply naming a
		// nonexistent parent got its 400 *and* left the title, url and
		// published_at it carried behind — a permanent write from a request that
		// never passed the checks that gate a real comment, on a slug that need
		// not have existed at all.
		const res = await post({
			slug: "no-such-thread",
			parent_id: "01HU999999999999999999",
			body: "a reply to nothing",
			post_title: "Attacker Title",
			post_published: 1_000_000_000_000,
		});
		expect(res.status).toBe(400);
		const row = sqlite
			.prepare("SELECT slug FROM posts WHERE slug = ?")
			.get("no-such-thread");
		expect(row).toBeUndefined();
	});

	it("writes no post metadata when the parent belongs to another post", async () => {
		const first = await post({ slug: "thread-a", body: "parent comment" });
		const parent = (await first.json()) as { comment: { id: string } };
		const res = await post({
			slug: "thread-b",
			parent_id: parent.comment.id,
			body: "cross-thread reply",
			post_title: "Attacker Title",
		});
		expect(res.status).toBe(400);
		expect(
			sqlite.prepare("SELECT slug FROM posts WHERE slug = ?").get("thread-b"),
		).toBeUndefined();
	});
});

describe("thread closure — GET payload", () => {
	const list = async (slug: string) => {
		const res = await app().request(
			`/?slug=${slug}`,
			{},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
		return res.json() as Promise<{
			accepting_comments: boolean;
			closed_reason: string | null;
		}>;
	};

	it("reports accepting_comments=true for an open post", async () => {
		await post({ slug: "live", body: "a comment" });
		const payload = await list("live");
		expect(payload.accepting_comments).toBe(true);
		expect(payload.closed_reason).toBeNull();
	});

	it("reports accepting_comments=false + reason for a closed post", async () => {
		await post({ slug: "shut", body: "a comment" });
		closePost("shut");
		const payload = await list("shut");
		expect(payload.accepting_comments).toBe(false);
		expect(payload.closed_reason).toBe("post_closed");
	});

	it("treats a post with no row yet as open", async () => {
		const payload = await list("never-commented");
		expect(payload.accepting_comments).toBe(true);
	});
});
