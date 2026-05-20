/**
 * GET /c/:id — permalink to a single comment.
 *
 * Looks up the comment's post, finds its public URL, and 302-redirects
 * to `<post.url>#garrul-comment-<id>` so the widget can scroll to the
 * comment on load.
 *
 * If the post has no `url` set (only seen on dev seeds and orphaned
 * slugs), 404 instead of guessing.
 *
 * Why server-side: the widget DOM has a `data-comment-id` attribute on
 * each thread node, so an anchor like `#garrul-comment-<id>` is reachable
 * once the widget is mounted. Shipping the permalink as a redirect (not
 * a JSON lookup) means a single link works in emails, Slack previews,
 * RSS feeds, etc.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getComment, getPost } from "../db/queries";

const permalink = new Hono<{ Bindings: Bindings }>();

permalink.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!id || id.length > 26) return c.text("invalid id", 400);

	const comment = await getComment(c.env.DB, id);
	if (!comment) return c.text("not found", 404);
	if (
		comment.status === "deleted" ||
		comment.status === "spam" ||
		comment.status === "pending"
	) {
		return c.text("not found", 404);
	}

	const post = await getPost(c.env.DB, comment.post_slug);
	if (!post || !post.url) return c.text("post URL not set", 404);

	// Validate the stored post URL: it came from the embed widget's
	// data-url attribute (caller-supplied), so we re-check the scheme
	// here to avoid acting as an open redirect to `javascript:`, `data:`,
	// or scheme-relative `//evil.example.com` targets.
	let parsed: URL;
	try {
		parsed = new URL(post.url);
	} catch {
		return c.text("post URL invalid", 404);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return c.text("post URL invalid", 404);
	}

	const target = `${post.url}${post.url.includes("#") ? "&" : "#"}garrul-comment-${id}`;
	c.header("cache-control", "public, max-age=300");
	return c.redirect(target, 302);
});

export { permalink };
