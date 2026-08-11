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
import { tFor } from "../i18n";
import { resolveLocale } from "../i18n/negotiate";
import { loadStrings } from "../lib/settings";

const feed = new Hono<{ Bindings: Bindings }>();

// XML 1.0 cannot represent most C0 controls at all — not even as a numeric
// character reference — so one of them anywhere in the document is a *fatal*
// well-formedness error and every conforming reader rejects the entire feed,
// cached 5 minutes at the edge. One comment whose author name ends in a
// U+0001 was enough. Tab, LF and CR are the three C0 chars XML allows.
//
// Strip at the serialization boundary rather than only on the write paths:
// OAuth display names come from the provider, and a database upgraded from an
// earlier version can already hold rows written before any sanitizer existed.
const XML_ILLEGAL = new RegExp(
	"[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]",
	"g",
);

const xmlEscape = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(XML_ILLEGAL, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
};

// CDATA is not an escaping mechanism, it's a delimiter: the one sequence it
// can't carry is its own terminator. Splitting the section around `]]>` keeps
// the payload byte-identical to a reader while making the document well-formed.
// The markdown renderer emits `&gt;` for a literal `>`, so this should be
// unreachable — it costs one string op to stop being load-bearing on that.
const cdata = (html: string): string =>
	`<![CDATA[${html
		.replace(XML_ILLEGAL, "")
		.split("]]>")
		.join("]]]]><![CDATA[>")}]]>`;

// The feed's own links. `post.url` came from the widget's data-url attribute, so
// re-check the scheme here the way permalink.ts does — an http(s) fallback keeps
// a `javascript:` row from becoming a clickable link inside a feed reader.
const safeLink = (url: string | null | undefined, fallback: string): string => {
	if (!url) return fallback;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return fallback;
		}
	} catch {
		return fallback;
	}
	return url;
};

feed.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!slug || slug.length > 200) return c.text("invalid slug", 400);

	const post = await getPost(c.env.DB, slug);
	const comments = await listLatestApprovedComments(c.env.DB, slug, 50);

	// The operator's default only — no `?lang=`. This response is cached at the
	// edge for 5 minutes under a URL that carries no locale, so honoring a
	// per-request locale here would serve whichever language happened to warm
	// the cache to everyone else. A feed also has one canonical URL per post by
	// definition; a reader's copy is not the place to fork it.
	const { default_locale: operatorDefault } = await loadStrings(c.env);
	const locale = resolveLocale({ operatorDefault });
	const t = tFor(locale);

	const reqUrl = new URL(c.req.url);
	const feedSelf = `${reqUrl.protocol}//${reqUrl.host}/feed/${encodeURIComponent(slug)}`;
	const postLink = safeLink(post?.url, feedSelf);
	const title = t("feed.title", { title: post?.title ?? slug });
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
  <title>${xmlEscape(t("feed.entry_title", { author: row.author_name }))}</title>
  <author><name>${xmlEscape(row.author_name)}</name></author>
  <published>${new Date(row.created_at).toISOString()}</published>
  <updated>${new Date(row.edited_at ?? row.created_at).toISOString()}</updated>
  <link rel="alternate" type="text/html" href="${xmlEscape(permalink)}"/>
  <content type="html">${cdata(row.body_html)}</content>
</entry>`;
		})
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlEscape(locale)}">
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
