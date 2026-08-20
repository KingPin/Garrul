/**
 * GET /c/:id — the server-side comment permalink redirect.
 *
 * The behaviour that matters here is the *fragment*: the route's whole job is
 * to land the reader on `<post.url>#garrul-comment-<id>` so the widget's
 * hash handling (src/widget/permalink.ts) can reveal the comment. A stored
 * `post.url` that already carries a fragment is the case that used to break
 * it, so it gets its own case below rather than living only in a comment.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { permalink } from "../src/routes/permalink";
import { commentAnchorId } from "../src/widget/permalink";
import { asD1 } from "./helpers/d1";
import type { TestEnv } from "./helpers/app";

const ID = "01JQZ8X4M2NPQRSTUVWXYZ0123";

/**
 * D1 stub that answers the route's two reads, dispatching on the table name in
 * the SQL. Either row may be `null` to exercise a 404 branch.
 */
const stubDb = (
	comment: Record<string, unknown> | null,
	post: Record<string, unknown> | null,
) =>
	asD1({
		prepare: (sql: string) => ({
			bind: () => ({
				first: async () => (sql.includes("FROM comments") ? comment : post),
			}),
		}),
	});

const aComment = (over: Record<string, unknown> = {}) => ({
	id: ID,
	post_slug: "my-post",
	status: "approved",
	...over,
});

const aPost = (url: string | null) => ({
	slug: "my-post",
	title: "My Post",
	url,
	created_at: "2026-01-01T00:00:00.000Z",
	closed: 0,
	published_at: null,
});

const get = (
	id: string,
	comment: Record<string, unknown> | null,
	post: Record<string, unknown> | null,
) => {
	const app = new Hono<{ Bindings: TestEnv }>();
	app.route("/c", permalink);
	return app.request(`/c/${id}`, {}, { DB: stubDb(comment, post) });
};

describe("GET /c/:id", () => {
	it("redirects to the post URL with the comment anchor", async () => {
		const res = await get(ID, aComment(), aPost("https://blog.example.com/post/"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe(
			`https://blog.example.com/post/#${commentAnchorId(ID)}`,
		);
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
	});

	it("replaces an existing fragment rather than appending to it", async () => {
		// The old string-concatenation build emitted
		// `…/post/#section-2&garrul-comment-<id>`, one fragment named
		// `section-2&garrul-comment-<id>`, which matches no element — and which
		// `commentIdFromHash` correctly refuses to parse, so the widget never
		// revealed the comment either.
		const res = await get(
			ID,
			aComment(),
			aPost("https://blog.example.com/post/#section-2"),
		);
		expect(res.headers.get("location")).toBe(
			`https://blog.example.com/post/#${commentAnchorId(ID)}`,
		);
	});

	it("preserves an existing query string", async () => {
		const res = await get(
			ID,
			aComment(),
			aPost("https://blog.example.com/post/?utm=x"),
		);
		expect(res.headers.get("location")).toBe(
			`https://blog.example.com/post/?utm=x#${commentAnchorId(ID)}`,
		);
	});

	it("400s on an over-long id without touching the database", async () => {
		const res = await get("x".repeat(27), aComment(), aPost("https://blog.example.com/"));
		expect(res.status).toBe(400);
	});

	it("404s when the comment does not exist", async () => {
		const res = await get(ID, null, aPost("https://blog.example.com/"));
		expect(res.status).toBe(404);
	});

	it.each(["deleted", "spam", "pending"])("404s on a %s comment", async (status) => {
		const res = await get(ID, aComment({ status }), aPost("https://blog.example.com/"));
		expect(res.status).toBe(404);
	});

	it("404s when the post has no URL", async () => {
		const res = await get(ID, aComment(), aPost(null));
		expect(res.status).toBe(404);
	});

	it.each(["javascript:alert(1)", "data:text/html,<script>", "//evil.example.com"])(
		"404s rather than redirecting to %s",
		async (hostile) => {
			const res = await get(ID, aComment(), aPost(hostile));
			expect(res.status).toBe(404);
		},
	);
});
