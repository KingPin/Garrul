/**
 * GET /api/v1/comments/:id/source — raw markdown for the edit form.
 *
 * The tree payload only carries `body_html`; the widget's Edit form needs the
 * original `body_md` to prefill. This endpoint hands it back, gated exactly like
 * the PATCH: only the author, only within the edit window. This is an authZ
 * contract — a comment's source must never leak to other users, anonymous
 * viewers, or the author after the window closes.
 *
 * No Miniflare: a hand-rolled D1 stub returns a single comment by id from
 * `.first()`, and a SESSIONS KV double + cookie simulates sessions.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { comments } from "../src/routes/api.comments";
import type { Bindings } from "../src/index";

const AUTHOR = "01HU000000000000000000";
const OTHER = "01HU000000000000000001";
const SID_AUTHOR = "a".repeat(64);
const SID_OTHER = "b".repeat(64);
const COMMENT_ID = "01HUCOMMENT0000000000A";

const mkComment = (created_at: number, status = "approved") => ({
	id: COMMENT_ID,
	post_slug: "hello",
	parent_id: null,
	user_id: AUTHOR,
	body_md: "the **original** source",
	body_html: "<p>the <strong>original</strong> source</p>",
	renderer_version: 1,
	status,
	edited_at: null,
	deleted_at: null,
	deleted_by: null,
	ip_hash: null,
	user_agent: null,
	created_at,
	score_up: 0,
	score_down: 0,
});

// D1 double: getComment issues `SELECT ... FROM comments WHERE id = ?` + first().
// `sqlLog` lets a test prove the route answered without touching D1 at all.
const makeDb = (
	comment: ReturnType<typeof mkComment> | null,
	sqlLog: string[] = [],
) => ({
	prepare: (sql: string) => {
		sqlLog.push(sql);
		return {
			bind(..._args: unknown[]) {
				return this;
			},
			async first() {
				if (sql.includes("FROM comments WHERE id = ?")) return comment;
				return null;
			},
			async all() {
				return { results: [] };
			},
		};
	},
});

const makeSessions = () => {
	const map: Record<string, string> = {
		[`sess:${SID_AUTHOR}`]: AUTHOR,
		[`sess:${SID_OTHER}`]: OTHER,
	};
	return {
		async get(key: string) {
			const uid = map[key];
			if (!uid) return null;
			return JSON.stringify({ user_id: uid, expires_at: 4_102_444_800_000 });
		},
		async put() {},
		async delete() {},
	};
};

// The edit window is a runtime setting now (DB > env > default), so the route
// resolves it through loadNumbers — which needs the KV it caches into.
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
	};
};

const mkEnv = (
	comment: ReturnType<typeof mkComment> | null,
	sqlLog: string[] = [],
) =>
	({
		DB: makeDb(comment, sqlLog),
		SESSIONS: makeSessions(),
		TREE_CACHE: makeKv(),
		EDIT_WINDOW_MINUTES: "5",
	}) as unknown as Bindings;

const getSource = async (env: Bindings, cookie?: string) => {
	const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
	const res = await app.request(
		`/${COMMENT_ID}/source`,
		cookie ? { headers: { cookie } } : {},
		env as unknown as Record<string, unknown>,
	);
	return res;
};

describe("GET /comments/:id/source", () => {
	it("returns body_md to the author within the edit window", async () => {
		const env = mkEnv(mkComment(Date.now() - 60_000)); // 1 min ago
		const res = await getSource(env, `__Host-garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { body_md: string };
		expect(body.body_md).toBe("the **original** source");
	});

	it("403s for a different signed-in user", async () => {
		const env = mkEnv(mkComment(Date.now() - 60_000));
		const res = await getSource(env, `__Host-garrul_sess=${SID_OTHER}`);
		expect(res.status).toBe(403);
	});

	it("403s for anonymous viewers", async () => {
		const env = mkEnv(mkComment(Date.now() - 60_000));
		const res = await getSource(env);
		expect(res.status).toBe(403);
	});

	it("403s once the edit window has expired", async () => {
		const env = mkEnv(mkComment(Date.now() - 10 * 60_000)); // 10 min ago
		const res = await getSource(env, `__Host-garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(403);
	});

	it("404s for a missing comment", async () => {
		const env = mkEnv(null);
		const res = await getSource(env, `__Host-garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(404);
	});

	it("403s an anonymous caller whether or not the comment exists", async () => {
		// The existence oracle: the lookup used to run before the session check,
		// so an unauthenticated prober got 404 for an unknown id and 403 for a
		// real one. Both must now answer 403, and neither may spend a D1 read.
		const presentSql: string[] = [];
		const absentSql: string[] = [];
		const present = mkEnv(mkComment(Date.now() - 60_000), presentSql);
		const absent = mkEnv(null, absentSql);
		expect((await getSource(present)).status).toBe(403);
		expect((await getSource(absent)).status).toBe(403);
		expect(presentSql).toEqual([]);
		expect(absentSql).toEqual([]);
	});

	it("404s a spam comment for its own author", async () => {
		// PATCH answers 404 for `spam` so a quarantine isn't confirmed. A 200
		// here would have leaked the same fact from the read side.
		const env = mkEnv(mkComment(Date.now() - 60_000, "spam"));
		const res = await getSource(env, `__Host-garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(404);
	});

	it("still serves a pending comment to its author", async () => {
		// `pending` stays readable: PATCH accepts an edit to it, and the widget
		// shows the author their own held comment.
		const env = mkEnv(mkComment(Date.now() - 60_000, "pending"));
		const res = await getSource(env, `__Host-garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(200);
	});
});
