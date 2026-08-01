/**
 * Rate limiting on the *authenticated* comment write paths.
 *
 * `checkRateLimit` used to sit inside the `if (!session)` branch of POST, so a
 * signed-in caller fell straight through to the insert with no ceiling at all,
 * and PATCH/DELETE never called it. One throwaway OAuth account was therefore
 * enough to drain D1's 100k daily row-writes: each accepted comment costs
 * upsertPost + insertComment + bustTreeCache plus one enqueueNotification write
 * per confirmed subscriber, and each edit/delete costs a write, a cache bust and
 * an outbound webhook.
 *
 * Runs against REAL SQLite so the inserts and the reads the handlers do are the
 * real ones, and against the mock Cache API (the limiter's backend) so the
 * bucket arithmetic is exercised rather than stubbed.
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

const SID = "a".repeat(64);
const SID_OTHER = "b".repeat(64);
const USER = "01HU000000000000000000";
const USER_OTHER = "01HU000000000000000001";
const SLUG = "throttle";
const COMMENT = "01HC000000000000000000";

const makeSessions = () => ({
	async get(key: string) {
		const userId =
			key === `sess:${SID}` ? USER : key === `sess:${SID_OTHER}` ? USER_OTHER : null;
		if (!userId) return null;
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
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	user.run(USER, "anon", null, "Tester", 1_700_000_000_000);
	user.run(USER_OTHER, "anon", null, "Other", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Throttle", null, 1_700_000_000_000);
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

const request = (path: string, init: RequestInit) =>
	app().request(
		path,
		init,
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const post = (bodyObj: Record<string, unknown>, sid = SID) =>
	request("/", {
		method: "POST",
		headers: { "content-type": "application/json", cookie: `garrul_sess=${sid}` },
		body: JSON.stringify(bodyObj),
	});

const patch = (id: string, body: string, sid = SID) =>
	request(`/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", cookie: `garrul_sess=${sid}` },
		body: JSON.stringify({ body }),
	});

const del = (id: string, sid = SID) =>
	request(`/${id}`, {
		method: "DELETE",
		headers: { cookie: `garrul_sess=${sid}` },
	});

/** Own comment, fresh enough to be inside the edit window. */
const seedOwnComment = (id = COMMENT, owner = USER) => {
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'x', '<p>x</p>', 1, 'approved', ?, 1)`,
		)
		.run(id, SLUG, owner, Date.now());
	return id;
};

const countComments = (): number =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;

describe("POST /comments — authenticated budget", () => {
	it("throttles a signed-in author once the short window is spent", async () => {
		// AUTHED_COMMENT_LIMITS.short = 3 per 10s.
		for (let i = 0; i < 3; i++) {
			const res = await post({ slug: SLUG, body: `comment ${i}` });
			expect(res.status).toBe(201);
		}
		const blocked = await post({ slug: SLUG, body: "one too many" });
		expect(blocked.status).toBe(429);
		// The point of the fix: the rejected request costs no D1 write.
		expect(countComments()).toBe(3);
	});

	it("meters per user, not per post", async () => {
		for (let i = 0; i < 3; i++) {
			expect((await post({ slug: SLUG, body: `c${i}` })).status).toBe(201);
		}
		// A different slug is a different post row but the same identity.
		const blocked = await post({ slug: "another-post", body: "elsewhere" });
		expect(blocked.status).toBe(429);
	});

	it("does not spend one user's budget on another user's writes", async () => {
		for (let i = 0; i < 3; i++) {
			expect((await post({ slug: SLUG, body: `c${i}` })).status).toBe(201);
		}
		expect((await post({ slug: SLUG, body: "other user" }, SID_OTHER)).status).toBe(
			201,
		);
	});

	it("rejects an anonymous request with no name before spending any budget", async () => {
		// Free local validation must stay free: at 1 request per 10s, a typo that
		// consumed the slot would lock the reader out of their own retry. Two
		// no-name requests in a row must both be 400, never 429.
		const first = await request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ slug: SLUG, body: "anonymous, unnamed" }),
		});
		expect(first.status).toBe(400);
		const second = await request("/", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ slug: SLUG, body: "anonymous, unnamed" }),
		});
		expect(second.status).toBe(400);
	});
});

describe("PATCH /comments/:id — budget", () => {
	it("throttles edits once the short window is spent", async () => {
		// MUTATE_COMMENT_LIMITS.short = 5 per 10s.
		const id = seedOwnComment();
		for (let i = 0; i < 5; i++) {
			expect((await patch(id, `revision ${i}`)).status).toBe(200);
		}
		expect((await patch(id, "one too many")).status).toBe(429);
		const stored = sqlite
			.prepare("SELECT body_md FROM comments WHERE id = ?")
			.get(id) as { body_md: string };
		expect(stored.body_md).toBe("revision 4");
	});

	it("403s an unauthenticated edit without reading the comment row", async () => {
		// Session first, then budget, then the D1 lookup — so a caller with no
		// cookie can't spend a read per request, and can't use the 404-vs-403
		// difference to probe whether a comment id exists.
		const missing = await request(`/${COMMENT}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "nope" }),
		});
		expect(missing.status).toBe(403);
	});
});

describe("DELETE /comments/:id — budget", () => {
	it("throttles deletes once the short window is spent", async () => {
		const ids = Array.from({ length: 6 }, (_, i) =>
			seedOwnComment(`01HC00000000000000000${i}`),
		);
		for (let i = 0; i < 5; i++) {
			expect((await del(ids[i]!)).status).toBe(200);
		}
		expect((await del(ids[5]!)).status).toBe(429);
		const survivor = sqlite
			.prepare("SELECT status FROM comments WHERE id = ?")
			.get(ids[5]!) as { status: string };
		expect(survivor.status).toBe("approved");
	});

	it("shares one bucket with PATCH so alternating them can't double the budget", async () => {
		const id = seedOwnComment();
		const spare = seedOwnComment("01HC000000000000000009");
		for (let i = 0; i < 3; i++) {
			expect((await patch(id, `revision ${i}`)).status).toBe(200);
		}
		expect((await del(id)).status).toBe(200);
		expect((await del(spare)).status).toBe(200);
		// 5 mutations spent; the 6th is over budget regardless of which verb it is.
		expect((await patch(id, "six")).status).toBe(429);
	});
});
