/**
 * GET /feed/:slug — Atom 1.0 feed of the most recent approved comments
 * for a post.
 *
 * Atom over RSS 2.0 because Atom is XML-namespaced (cleaner validation),
 * has a real id field, and is what every modern feed reader prefers.
 *
 * Cached for 5 minutes at the edge. New comments showing up a few minutes
 * late in a reader is fine; this is RSS, not a chat.
 *
 * body_html is included inline (escaped as XHTML via CDATA). It was
 * already sanitized when the comment was rendered, so re-running an
 * HTML sanitizer here is wasted work.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getPost, listLatestApprovedComments } from "../db/queries";

const feed = new Hono<{ Bindings: Bindings }>();

const xmlEscape = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
};

feed.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!slug || slug.length > 200) return c.text("invalid slug", 400);

	const post = await getPost(c.env.DB, slug);
	const comments = await listLatestApprovedComments(c.env.DB, slug, 50);

	const reqUrl = new URL(c.req.url);
	const feedSelf = `${reqUrl.protocol}//${reqUrl.host}/feed/${encodeURIComponent(slug)}`;
	const postLink = post?.url ?? feedSelf;
	const title = post?.title
		? `Comments on ${post.title}`
		: `Comments on ${slug}`;
	const updated =
		comments[0] != null
			? new Date(comments[0].created_at).toISOString()
			: new Date(post?.created_at ?? Date.now()).toISOString();

	const entries = comments
		.map((row) => {
			const id = `tag:${reqUrl.host},${new Date(row.created_at).toISOString().slice(0, 10)}:comment/${row.id}`;
			const permalink = `${postLink}${postLink.includes("#") ? "&" : "#"}garrul-comment-${row.id}`;
			return `<entry>
  <id>${xmlEscape(id)}</id>
  <title>${xmlEscape(row.author_name)} commented</title>
  <author><name>${xmlEscape(row.author_name)}</name></author>
  <published>${new Date(row.created_at).toISOString()}</published>
  <updated>${new Date(row.edited_at ?? row.created_at).toISOString()}</updated>
  <link rel="alternate" type="text/html" href="${xmlEscape(permalink)}"/>
  <content type="html"><![CDATA[${row.body_html}]]></content>
</entry>`;
		})
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(feedSelf)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" type="application/atom+xml" href="${xmlEscape(feedSelf)}"/>
  <link rel="alternate" type="text/html" href="${xmlEscape(postLink)}"/>
  <generator uri="https://github.com/KingPin/Garrul">Garrul</generator>
  ${entries}
</feed>`;

	c.header("content-type", "application/atom+xml; charset=utf-8");
	c.header("cache-control", "public, max-age=300");
	return c.body(xml);
});

export { feed };
