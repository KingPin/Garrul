/**
 * `DELETE /api/v1/comments/:id` answers with the deleted comment's re-rendered
 * thread, so the widget can swap that one thread in place instead of reloading
 * page one.
 *
 * The widget cannot work out a deleted row's fate itself (placeholder flag,
 * ancestry pruning, hidden rows), so the contract is "the same thread the list
 * would serve". These tests diff against a real `GET /api/v1/comments` made
 * after the delete, with the placeholder flag both ways, rather than asserting a
 * literal shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { localeMiddleware } from "../src/lib/locale";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { makeD1 as sqliteD1 } from "./helpers/admin-sqlite";
import type { Bindings } from "../src/index";

// The admin helper's batch runs every statement as a write; the reaction reads
// go through batch, so answer reads with rows the way bootstrap.test.ts does.
const makeD1 = (db: DatabaseSync) => {
	const d = sqliteD1(db);
	const prepare = d.prepare;
	d.prepare = (sql: string) => Object.assign(prepare(sql), { sql });
	d.batch = async (stmts: { sql: string; all(): Promise<unknown>; run(): Promise<unknown> }[]) => {
		const out = [];
		for (const s of stmts) out.push(await (/^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql) ? s.run() : s.all()));
		return out;
	};
	return d;
};

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const SID = "a".repeat(64);
const USER = "01HU00000000000000VIEWER";
const OTHER = "01HU000000000000000OTHER";
const SLUG = "hello-world";

let sqlite: DatabaseSync;
let env: Bindings;
let clock = 1_700_000_000_000;

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const app = () =>
	new Hono<{ Bindings: Bindings }>()
		.use("/api/*", localeMiddleware())
		.route("/api/v1/comments", comments);

const call = async (path: string, method = "GET") =>
	(await (
		await app().request(
			`http://localhost${path}`,
			{ method, headers: { cookie: `garrul_sess=${SID}` } },
			env as unknown as Record<string, unknown>,
			execCtx,
		)
	).json()) as Record<string, any>;

const add = (
	id: string,
	parent: string | null,
	opts: { user?: string; status?: string } = {},
): string => {
	clock += 1000;
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, ?, ?, 'hi', '<p>hi</p>', 1, ?, ?, ?)`,
		)
		.run(id, SLUG, parent, opts.user ?? USER, opts.status ?? "approved", clock, parent ? 2 : 1);
	return id;
};

const setup = (placeholders: boolean) => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	for (const [id, name] of [
		[USER, "Viewer"],
		[OTHER, "Other"],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, email, avatar_url, is_admin, role, created_at)
				 VALUES (?, 'github', ?, ?, NULL, NULL, 0, 'user', ?)`,
			)
			.run(id, `gh-${id}`, name, clock);
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Hello", null, clock);
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
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
		SHOW_DELETED_PLACEHOLDERS: placeholders ? "true" : "false",
	} as unknown as Bindings;
};

/** Delete `id`, then fetch the list the way a reload would and pull `rootId`. */
const deleteAndList = async (id: string, rootId: string) => {
	const del = await call(`/api/v1/comments/${id}`, "DELETE");
	const list = await call(`/api/v1/comments?slug=${SLUG}`);
	const listed = (list.threads as { id: string }[]).find((t) => t.id === rootId) ?? null;
	return { del, listed };
};

afterEach(() => uninstallMockCaches());

it("a render that throws still answers 200 ok, without a thread", async () => {
	setup(false);
	const id = add("01HC00000000000000000BOOM1", null);
	// Fail only the reads after the delete; the delete itself goes through.
	const prepare = env.DB.prepare.bind(env.DB);
	(env.DB as { prepare: unknown }).prepare = (sql: string) => {
		if (sql.includes("WITH RECURSIVE thread_level")) throw new Error("D1 down");
		return prepare(sql);
	};
	const res = await app().request(
		`http://localhost/api/v1/comments/${id}`,
		{ method: "DELETE", headers: { cookie: `garrul_sess=${SID}` } },
		env as unknown as Record<string, unknown>,
		execCtx,
	);
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true });
	const row = sqlite.prepare("SELECT status FROM comments WHERE id = ?").get(id) as { status: string };
	expect(row.status).toBe("deleted");
});

it("a parent cycle stops at the depth cap and answers ok without a thread", async () => {
	setup(false);
	add("01HC00000000000000000CYCA", null);
	add("01HC00000000000000000CYCB", "01HC00000000000000000CYCA");
	sqlite
		.prepare("UPDATE comments SET parent_id = ? WHERE id = ?")
		.run("01HC00000000000000000CYCB", "01HC00000000000000000CYCA");
	const del = await call("/api/v1/comments/01HC00000000000000000CYCA", "DELETE");
	// No `thread` key: the widget falls back to a reload.
	expect(del).toEqual({ ok: true });
});

for (const placeholders of [true, false]) {
	describe(`DELETE returns the list's thread (placeholders ${placeholders ? "on" : "off"})`, () => {
		beforeEach(() => setup(placeholders));

		it("a deleted leaf reply", async () => {
			const root = add("01HC0000000000000000ROOT1", null, { user: OTHER });
			const leaf = add("01HC0000000000000000LEAF1", root);
			const { del, listed } = await deleteAndList(leaf, root);
			expect(del.ok).toBe(true);
			expect(del.root_id).toBe(root);
			expect(listed).not.toBeNull();
			expect(del.thread).toEqual(listed);
		});

		it("a deleted top-level leaf", async () => {
			const root = add("01HC0000000000000000ROOT2", null);
			add("01HC0000000000000000ROOT3", null, { user: OTHER });
			const { del, listed } = await deleteAndList(root, root);
			expect(del.root_id).toBe(root);
			expect(del.thread).toEqual(listed);
			// Off: the thread is pruned, which the widget reads as "remove it".
			if (!placeholders) expect(del.thread).toBeNull();
		});

		it("a deleted parent with live replies", async () => {
			const root = add("01HC0000000000000000ROOT4", null);
			const kid = add("01HC0000000000000000KID04", root, { user: OTHER });
			// The viewer's own reaction and vote, so `mine` / `my_vote` are compared too.
			sqlite
				.prepare("INSERT INTO reactions (comment_id, user_id, kind, created_at) VALUES (?, ?, 'heart', 1)")
				.run(kid, USER);
			sqlite
				.prepare("INSERT INTO votes (comment_id, user_id, value, created_at) VALUES (?, ?, 1, 1)")
				.run(kid, USER);
			const { del, listed } = await deleteAndList(root, root);
			expect(del.thread.replies[0].my_vote).toBe(1);
			expect(del.thread.replies[0].reactions[0].mine).toBe(true);
			expect(del.root_id).toBe(root);
			expect(listed).not.toBeNull();
			expect(del.thread).toEqual(listed);
		});

		it("the last live reply under a deleted parent", async () => {
			const root = add("01HC0000000000000000ROOT5", null, { status: "deleted" });
			const kid = add("01HC0000000000000000KID05", root);
			const { del, listed } = await deleteAndList(kid, root);
			expect(del.root_id).toBe(root);
			expect(del.thread).toEqual(listed);
			// Off: both rows go, so the whole thread is pruned.
			if (!placeholders) expect(del.thread).toBeNull();
		});
	});
}
