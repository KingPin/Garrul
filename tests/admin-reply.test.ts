/**
 * Ad hoc moderator replies — POST /admin/api/comments/:id/reply.
 *
 * The endpoint that replaced `POST /admin/api/saved-replies/:id/post`, which was
 * keyed on a preset the mod had to invent first. Free text is now the canonical
 * input and a saved reply is an optional *prefill* whose id survives only as
 * audit provenance. Driven end-to-end against REAL SQLite with every migration
 * applied, so the subscription filtering and the audit write are the production
 * SQL, not a re-implementation.
 *
 * Covered:
 *
 *   - insert shape: nested under the target (parent_id/depth), authored by the
 *     mod, status=approved, no ip_hash/user_agent, current renderer version;
 *   - body is re-rendered through the sanitizer at post time — a <script> or
 *     <img onerror> in body_md never reaches body_html;
 *   - validation: empty body, body over MAX_BODY_CHARS, MAX_REPLY_DEPTH;
 *   - notification fan-out: on by default, one row per *confirmed, subscribed*
 *     subscriber, skipping the replying mod's own address; `notify: false`
 *     writes none but still posts;
 *   - audit provenance: `comment.reply` with saved_reply_id in the prefilled
 *     case and null in the ad hoc case, and a claim on a saved reply the mod
 *     can't see is refused;
 *   - guards: no session → 401, non-mod → 403, cross-origin → 403, unknown or
 *     deleted target → 404/400.
 *
 * `waitUntil` collects the fan-out promise so assertions can await it — a no-op
 * waitUntil would race the enqueue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_ACTIONS, insertComment } from "../src/db/queries";
import type { Bindings } from "../src/index";
import { CURRENT_RENDERER_VERSION, MAX_BODY_CHARS } from "../src/lib/markdown";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import { admin } from "../src/routes/admin";

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
const MOD_ID = "01HMOD00000000000000000AB";
const USER_ID = "01HPLAIN000000000000000AB";
const AUTHOR_ID = "01HAUTHOR000000000000000AB";
const MOD_EMAIL = "mod@example.com";
const TS = 1_700_000_000_000;

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return { sqlite, db: makeD1(sqlite) };
};

/** Session KV: SID maps to the mod by default, or to whichever id is set. */
let sessionUserId = MOD_ID;
const makeSessions = () => ({
	async get(key: string) {
		if (key !== `sess:${SID}`) return null;
		return JSON.stringify({
			user_id: sessionUserId,
			expires_at: 4_102_444_800_000,
		});
	},
	async put() {},
	async delete() {},
});

const makeKv = () => {
	const store = new Map<string, string>([
		["meta:latest-release", JSON.stringify({ kind: "null", fetchedAt: 1 })],
		["meta:recent-releases", JSON.stringify({ kind: "null", fetchedAt: 1 })],
	]);
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
let db: any;
let env: Bindings;
let deferred: Promise<unknown>[];

const execCtx = () =>
	({
		waitUntil(p: Promise<unknown>) {
			deferred.push(p);
		},
		passThroughOnException() {},
	}) as unknown as ExecutionContext;

const settle = async (): Promise<void> => {
	await Promise.all(deferred);
	deferred = [];
};

const seedComment = async (
	opts: { depth?: number; status?: string; parent?: string | null } = {},
): Promise<string> => {
	const c = await insertComment(db, {
		post_slug: "hello",
		parent_id: opts.parent ?? null,
		user_id: AUTHOR_ID,
		body_md: "a comment",
		body_html: "<p>a comment</p>",
		renderer_version: CURRENT_RENDERER_VERSION,
		status: (opts.status ?? "approved") as never,
		ip_hash: null,
		user_agent: null,
		depth: opts.depth ?? 1,
	});
	return c.id;
};

const seedSubscription = (opts: {
	id: string;
	email: string;
	confirmed?: boolean;
	unsubscribed?: boolean;
}): void => {
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, created_at, confirmed_at, unsubscribed_at)
			 VALUES (?, 'hello', ?, ?, ?, ?, ?)`,
		)
		.run(
			opts.id,
			opts.email,
			`tok_${opts.id}`,
			TS,
			opts.confirmed === false ? null : TS,
			opts.unsubscribed ? TS : null,
		);
};

const seedSavedReply = (opts: {
	id: string;
	owner: string;
	scope: "private" | "shared";
	body?: string;
}): void => {
	sqlite
		.prepare(
			`INSERT INTO saved_replies
			   (id, owner_id, title, body_md, scope, created_at, updated_at)
			 VALUES (?, ?, 'Preset', ?, ?, ?, ?)`,
		)
		.run(opts.id, opts.owner, opts.body ?? "Preset body", opts.scope, TS, TS);
};

const commentRow = (id: string): Record<string, unknown> =>
	sqlite.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;

const replies = (): Record<string, unknown>[] =>
	sqlite
		.prepare("SELECT * FROM comments WHERE user_id = ? ORDER BY created_at")
		.all(MOD_ID) as Record<string, unknown>[];

/** Subscription ids that have a queued notification for `commentId`. */
const notifiedSubs = (commentId: string): string[] =>
	(
		sqlite
			.prepare(
				"SELECT subscription_id FROM notifications WHERE comment_id = ? ORDER BY subscription_id",
			)
			.all(commentId) as { subscription_id: string }[]
	).map((r) => r.subscription_id);

const lastReplyAudit = (): { meta: string | null } | undefined =>
	sqlite
		.prepare(
			"SELECT meta FROM audit_log WHERE action = 'comment.reply' ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.get() as { meta: string | null } | undefined;

beforeEach(() => {
	const fresh = freshDb();
	sqlite = fresh.sqlite;
	db = fresh.db;
	deferred = [];
	sessionUserId = MOD_ID;
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, is_admin, role, created_at)
			 VALUES (?, 'github', '1', 'Mod', ?, 0, 'mod', ?)`,
		)
		.run(MOD_ID, MOD_EMAIL, TS);
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, is_admin, role, created_at)
			 VALUES (?, 'github', '2', 'Reader', 'reader@example.com', 0, 'user', ?)`,
		)
		.run(USER_ID, TS);
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES (?, 'anon', NULL, 'Author', ?)",
		)
		.run(AUTHOR_ID, TS);
	sqlite
		.prepare("INSERT INTO posts (slug, created_at) VALUES ('hello', ?)")
		.run(TS);
	env = {
		DB: db,
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const reply = (
	id: string,
	payload: Record<string, unknown>,
	opts: { cookie?: boolean; origin?: string | null } = {},
) => {
	const { cookie = true, origin = "http://localhost" } = opts;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (cookie) headers.cookie = `__Host-garrul_sess=${SID}`;
	if (origin) headers.origin = origin;
	return app().request(
		`/admin/api/comments/${id}/reply`,
		{ method: "POST", headers, body: JSON.stringify(payload) },
		env as unknown as Record<string, unknown>,
		execCtx(),
	);
};

/** Post a reply that is expected to succeed, returning the new comment's id. */
const replyId = async (
	id: string,
	payload: Record<string, unknown>,
): Promise<string> => {
	const res = await reply(id, payload);
	expect(res.status).toBe(200);
	return ((await res.json()) as { id: string }).id;
};

describe("POST /admin/api/comments/:id/reply — insert shape", () => {
	it("posts ad hoc free text nested under the target, authored by the mod", async () => {
		const target = await seedComment({ depth: 2 });
		const res = await reply(target, { body_md: "**thanks** for the report" });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { ok: boolean; id: string };
		expect(json.ok).toBe(true);
		await settle();

		const row = commentRow(json.id);
		expect(row.parent_id).toBe(target);
		expect(row.depth).toBe(3);
		expect(row.user_id).toBe(MOD_ID);
		expect(row.post_slug).toBe("hello");
		expect(row.status).toBe("approved");
		expect(row.renderer_version).toBe(CURRENT_RENDERER_VERSION);
		// Posted by a signed-in mod through the admin panel: there is no reader
		// request to fingerprint, and storing the mod's own would be new PII.
		expect(row.ip_hash).toBeNull();
		expect(row.user_agent).toBeNull();
		expect(row.body_md).toBe("**thanks** for the report");
		expect(row.body_html).toContain("<strong>thanks</strong>");
	});

	it("works with no saved reply in the database at all", async () => {
		// The whole point of the feature: replying must not require inventing a
		// preset first.
		const target = await seedComment();
		const res = await reply(target, { body_md: "one-off answer" });
		expect(res.status).toBe(200);
		await settle();
		expect(replies()).toHaveLength(1);
	});
});

describe("POST /admin/api/comments/:id/reply — sanitization", () => {
	it("strips a <script> from the stored html", async () => {
		const target = await seedComment();
		const res = await reply(target, {
			body_md: "Hi <script>alert(1)</script> there",
		});
		const { id } = (await res.json()) as { id: string };
		await settle();
		const html = commentRow(id).body_html as string;
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("</script>");
	});

	it("strips <img onerror=..> from the stored html", async () => {
		const target = await seedComment();
		const res = await reply(target, { body_md: '<img src=x onerror="x()">' });
		const { id } = (await res.json()) as { id: string };
		await settle();
		const html = commentRow(id).body_html as string;
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("<img");
	});
});

describe("POST /admin/api/comments/:id/reply — validation", () => {
	it("rejects an empty body", async () => {
		const target = await seedComment();
		const res = await reply(target, { body_md: "   " });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "body_required" });
		expect(replies()).toHaveLength(0);
	});

	it("rejects a missing body_md", async () => {
		const target = await seedComment();
		const res = await reply(target, {});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "body_required" });
	});

	it("accepts a body at MAX_BODY_CHARS and rejects one char more", async () => {
		const target = await seedComment();
		const ok = await reply(target, { body_md: "x".repeat(MAX_BODY_CHARS) });
		expect(ok.status).toBe(200);

		const tooLong = await reply(target, {
			body_md: "x".repeat(MAX_BODY_CHARS + 1),
		});
		expect(tooLong.status).toBe(400);
		expect(await tooLong.json()).toEqual({
			error: "body_too_long",
			max: MAX_BODY_CHARS,
		});
		await settle();
		expect(replies()).toHaveLength(1);
	});

	it("rejects a non-boolean notify instead of coercing it", async () => {
		// The failure this guards is one-directional: a client meaning "don't
		// email" that sends `"false"` or `0` would otherwise mail the thread.
		const target = await seedComment();
		for (const notify of ["false", 0, "true", {}]) {
			const res = await reply(target, { body_md: "hi", notify });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_body" });
		}
		expect(replies()).toHaveLength(0);
	});

	it("refuses to exceed MAX_REPLY_DEPTH", async () => {
		const target = await seedComment({ depth: MAX_REPLY_DEPTH });
		const res = await reply(target, { body_md: "too deep" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "thread_too_deep" });
		expect(replies()).toHaveLength(0);
	});

	it("404s an unknown target and 400s a deleted one", async () => {
		const missing = await reply("01HNOPE0000000000000000000", {
			body_md: "hi",
		});
		expect(missing.status).toBe(404);

		const gone = await seedComment({ status: "deleted" });
		const res = await reply(gone, { body_md: "hi" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "comment_deleted" });
		expect(replies()).toHaveLength(0);
	});
});

describe("POST /admin/api/comments/:id/reply — notification fan-out", () => {
	it("notifies confirmed subscribers by default and skips the mod's own address", async () => {
		seedSubscription({ id: "sub_a", email: "a@example.com" });
		seedSubscription({ id: "sub_b", email: "b@example.com" });
		seedSubscription({ id: "sub_self", email: MOD_EMAIL });
		const target = await seedComment();

		const res = await reply(target, { body_md: "answered" });
		expect(await res.json()).toMatchObject({ ok: true, notified: true });
		const id = await replyId(target, { body_md: "again" });
		await settle();

		expect(notifiedSubs(id)).toEqual(["sub_a", "sub_b"]);
	});

	it("writes no notifications when notify is false, but still posts", async () => {
		seedSubscription({ id: "sub_a", email: "a@example.com" });
		const target = await seedComment();

		const res = await reply(target, { body_md: "quiet note", notify: false });
		expect(await res.json()).toMatchObject({ notified: false });
		await settle();

		expect(replies()).toHaveLength(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM notifications").get(),
		).toEqual({ n: 0 });
	});

	it("skips unconfirmed and unsubscribed subscriptions", async () => {
		// Asserts we inherited listActiveSubscriptionsForPost's filtering rather
		// than re-rolling the WHERE clause in the admin route.
		seedSubscription({ id: "sub_live", email: "live@example.com" });
		seedSubscription({
			id: "sub_pending",
			email: "pending@example.com",
			confirmed: false,
		});
		seedSubscription({
			id: "sub_gone",
			email: "gone@example.com",
			unsubscribed: true,
		});
		const target = await seedComment();

		const id = await replyId(target, { body_md: "hello" });
		await settle();

		expect(notifiedSubs(id)).toEqual(["sub_live"]);
	});

	it("does not notify subscribers of a different post", async () => {
		sqlite
			.prepare("INSERT INTO posts (slug, created_at) VALUES ('other', ?)")
			.run(TS);
		sqlite
			.prepare(
				`INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirmed_at)
				 VALUES ('sub_other', 'other', 'other@example.com', 'tok_other', ?, ?)`,
			)
			.run(TS, TS);
		const target = await seedComment();

		const id = await replyId(target, { body_md: "hello" });
		await settle();

		expect(notifiedSubs(id)).toEqual([]);
	});
});

describe("POST /admin/api/comments/:id/reply — audit provenance", () => {
	it("records comment.reply with no saved reply for ad hoc text", async () => {
		const target = await seedComment();
		const id = await replyId(target, { body_md: "ad hoc" });
		await settle();

		const meta = JSON.parse(lastReplyAudit()?.meta ?? "{}");
		expect(meta.from_saved_reply).toBe(false);
		expect(meta.saved_reply_id).toBeNull();
		expect(meta.parent_id).toBe(target);
		expect(meta.post_slug).toBe("hello");
		expect(meta.notify_subscribers).toBe(true);
		expect(
			sqlite
				.prepare(
					"SELECT target_id FROM audit_log WHERE action = 'comment.reply'",
				)
				.get(),
		).toEqual({ target_id: id });
	});

	it("records the saved reply that prefilled the body", async () => {
		seedSavedReply({ id: "sr_own", owner: MOD_ID, scope: "private" });
		const target = await seedComment();
		const res = await reply(target, {
			body_md: "Preset body",
			saved_reply_id: "sr_own",
		});
		expect(res.status).toBe(200);
		await settle();

		const meta = JSON.parse(lastReplyAudit()?.meta ?? "{}");
		expect(meta.from_saved_reply).toBe(true);
		expect(meta.saved_reply_id).toBe("sr_own");
	});

	it("accepts a shared saved reply owned by someone else", async () => {
		seedSavedReply({ id: "sr_shared", owner: AUTHOR_ID, scope: "shared" });
		const target = await seedComment();
		const res = await reply(target, {
			body_md: "Preset body",
			saved_reply_id: "sr_shared",
		});
		expect(res.status).toBe(200);
		await settle();
		expect(JSON.parse(lastReplyAudit()?.meta ?? "{}").saved_reply_id).toBe(
			"sr_shared",
		);
	});

	it("refuses to credit a saved reply the mod cannot see", async () => {
		seedSavedReply({ id: "sr_private", owner: AUTHOR_ID, scope: "private" });
		const target = await seedComment();
		const res = await reply(target, {
			body_md: "borrowed",
			saved_reply_id: "sr_private",
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "saved_reply_not_visible" });
		expect(replies()).toHaveLength(0);
	});

	it("refuses an unknown saved reply id, and a non-string one", async () => {
		const target = await seedComment();
		const missing = await reply(target, {
			body_md: "x",
			saved_reply_id: "sr_nope",
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ error: "saved_reply_not_visible" });

		const wrongType = await reply(target, { body_md: "x", saved_reply_id: 7 });
		expect(wrongType.status).toBe(400);
		expect(await wrongType.json()).toEqual({ error: "invalid_body" });
		expect(replies()).toHaveLength(0);
	});
});

describe("POST /admin/api/comments/:id/reply — guards", () => {
	it("rejects an unauthenticated request", async () => {
		const target = await seedComment();
		const res = await reply(target, { body_md: "hi" }, { cookie: false });
		expect(res.status).toBe(401);
		expect(replies()).toHaveLength(0);
	});

	it("rejects a plain (non-mod) user", async () => {
		sessionUserId = USER_ID;
		const target = await seedComment();
		const res = await reply(target, { body_md: "hi" });
		expect(res.status).toBe(403);
		expect(replies()).toHaveLength(0);
	});

	it("rejects a cross-origin request (CSRF)", async () => {
		const target = await seedComment();
		const res = await reply(
			target,
			{ body_md: "hi" },
			{ origin: "https://evil.example" },
		);
		expect(res.status).toBe(403);
		expect(replies()).toHaveLength(0);
	});
});

describe("POST /admin/api/preview", () => {
	const preview = (payload: Record<string, unknown>, cookie = true) => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			origin: "http://localhost",
		};
		if (cookie) headers.cookie = `__Host-garrul_sess=${SID}`;
		return app().request(
			"/admin/api/preview",
			{ method: "POST", headers, body: JSON.stringify(payload) },
			env as unknown as Record<string, unknown>,
			execCtx(),
		);
	};

	it("renders markdown through the same sanitizer, without persisting", async () => {
		const res = await preview({
			body_md: "**bold** <script>alert(1)</script>",
		});
		expect(res.status).toBe(200);
		const { html } = (await res.json()) as { html: string };
		expect(html).toContain("<strong>bold</strong>");
		expect(html).not.toContain("<script>");
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get(),
		).toEqual({ n: 0 });
	});

	it("rejects an empty body and an unauthenticated caller", async () => {
		expect((await preview({ body_md: " " })).status).toBe(400);
		expect((await preview({ body_md: "hi" }, false)).status).toBe(401);
	});
});

describe("ADMIN_ACTIONS", () => {
	it("offers comment.reply to the audit filter", async () => {
		expect(ADMIN_ACTIONS).toContain("comment.reply");
	});

	it("keeps saved_reply.post so historical rows stay filterable", async () => {
		// Nothing writes it since the saved-reply post endpoint was removed, but
		// this array is the allowlist the audit dropdown and the `?action=` query
		// validate against — dropping it would make old rows unfilterable.
		expect(ADMIN_ACTIONS).toContain("saved_reply.post");
	});

	it("offers all four import sources to the audit filter, not just Disqus", () => {
		// import.remark42, import.comentario and import.isso all wrote audit
		// rows well before any of the three was added here — those rows were
		// unfilterable on the audit page and via `?action=` the whole time.
		expect(ADMIN_ACTIONS).toContain("import.disqus");
		expect(ADMIN_ACTIONS).toContain("import.remark42");
		expect(ADMIN_ACTIONS).toContain("import.comentario");
		expect(ADMIN_ACTIONS).toContain("import.isso");
	});
});
