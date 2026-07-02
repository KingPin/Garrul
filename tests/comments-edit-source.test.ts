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

const mkComment = (created_at: number) => ({
	id: COMMENT_ID,
	post_slug: "hello",
	parent_id: null,
	user_id: AUTHOR,
	body_md: "the **original** source",
	body_html: "<p>the <strong>original</strong> source</p>",
	renderer_version: 1,
	status: "approved",
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
const makeDb = (comment: ReturnType<typeof mkComment> | null) => ({
	prepare: (sql: string) => ({
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
	}),
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

const mkEnv = (comment: ReturnType<typeof mkComment> | null) =>
	({
		DB: makeDb(comment),
		SESSIONS: makeSessions(),
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
		const res = await getSource(env, `garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { body_md: string };
		expect(body.body_md).toBe("the **original** source");
	});

	it("403s for a different signed-in user", async () => {
		const env = mkEnv(mkComment(Date.now() - 60_000));
		const res = await getSource(env, `garrul_sess=${SID_OTHER}`);
		expect(res.status).toBe(403);
	});

	it("403s for anonymous viewers", async () => {
		const env = mkEnv(mkComment(Date.now() - 60_000));
		const res = await getSource(env);
		expect(res.status).toBe(403);
	});

	it("403s once the edit window has expired", async () => {
		const env = mkEnv(mkComment(Date.now() - 10 * 60_000)); // 10 min ago
		const res = await getSource(env, `garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(403);
	});

	it("404s for a missing comment", async () => {
		const env = mkEnv(null);
		const res = await getSource(env, `garrul_sess=${SID_AUTHOR}`);
		expect(res.status).toBe(404);
	});
});
