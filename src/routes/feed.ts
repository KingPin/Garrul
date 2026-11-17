/**
 * GET /feed/:slug — Atom 1.0 feed of the most recent approved comments
 * for a post.
 *
 * Atom over RSS 2.0 because Atom is XML-namespaced (cleaner validation),
 * has a real id field, and is what every modern feed reader prefers.
 *
 * Cached for 5 minutes at the edge (Cache API, so a hit skips D1 but still
 * bills the Worker request). bustTreeCache drops it in the handling colo on
 * every comment mutation; elsewhere new comments show up a few minutes late,
 * which is fine for a feed.
 *
 * body_html is included inline (escaped as XHTML via CDATA). It was
 * already sanitized when the comment was rendered, so re-running an
 * HTML sanitizer here is wasted work.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	type RecentComment,
	getPost,
	listLatestApprovedComments,
	listPostUrls,
	listRecentApprovedComments,
} from "../db/queries";
import { type Translator, tFor } from "../i18n";
import { resolveLocale } from "../i18n/negotiate";
import { allowedPostUrl, parseAllowedOrigins } from "../lib/cors";
import { matchCache, putResponse, tryWaitUntil } from "../lib/response-cache";
import { loadStrings } from "../lib/settings";
import { feedCacheKey, siteFeedCacheKey } from "../lib/tree-cache";
import { commentAnchorId } from "../widget/permalink";

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

// Links to the host page come from `post.url`, which the widget took from its
// data-url attribute. `allowedPostUrl` re-checks scheme and ALLOWED_ORIGINS, so
// a stale or hostile row yields no link rather than a clickable one. Setting
// `hash` replaces any fragment the page URL already carries.
const commentLink = (
	postUrl: string | null | undefined,
	commentId: string,
	allowedOrigins: string | undefined,
): string | null => {
	const safe = allowedPostUrl(postUrl, allowedOrigins);
	if (!safe) return null;
	const u = new URL(safe);
	u.hash = commentAnchorId(commentId);
	return u.toString();
};

const entryId = (host: string, row: { id: string; created_at: number }): string =>
	`tag:${host},${new Date(row.created_at).toISOString().slice(0, 10)}:comment/${row.id}`;

const generator = `<generator uri="https://github.com/KingPin/Garrul">Garrul</generator>`;

const atomEntry = (
	row: Pick<
		RecentComment,
		"id" | "body_html" | "created_at" | "edited_at" | "author_name"
	>,
	link: string | null,
	t: Translator,
	host: string,
): string => `<entry>
  <id>${xmlEscape(entryId(host, row))}</id>
  <title>${xmlEscape(t("feed.entry_title", { author: row.author_name }))}</title>
  <author><name>${xmlEscape(row.author_name)}</name></author>
  <published>${new Date(row.created_at).toISOString()}</published>
  <updated>${new Date(row.edited_at ?? row.created_at).toISOString()}</updated>
${link ? `  <link rel="alternate" type="text/html" href="${xmlEscape(link)}"/>\n` : ""}  <content type="html">${cdata(row.body_html)}</content>
</entry>`;

// Site-wide recent comments, Atom or JSON Feed. `format` and `site` are
// normalized before they reach the cache key, so junk query strings cannot
// mint entries. Operator-default locale only, for the reason the slug route
// gives below.
feed.get("/", async (c) => {
	const rawSite = c.req.query("site") ?? "";
	let site = "";
	if (rawSite !== "") {
		let origin: string | null = null;
		try {
			origin = new URL(rawSite).origin;
		} catch {
			// invalid below
		}
		if (
			origin !== rawSite ||
			!parseAllowedOrigins(c.env.ALLOWED_ORIGINS).has(rawSite)
		) {
			return c.text("invalid site", 400);
		}
		site = rawSite;
	}
	const format = c.req.query("format") === "json" ? "json" : "atom";

	const key = siteFeedCacheKey(c.req.url, format, site);
	const hit = await matchCache(key);
	if (hit) return hit;

	let comments: RecentComment[];
	if (site) {
		const slugs = (await listPostUrls(c.env.DB))
			.filter(({ url }) => {
				const safe = allowedPostUrl(url, c.env.ALLOWED_ORIGINS);
				return safe !== null && new URL(safe).origin === site;
			})
			.map((p) => p.slug);
		comments = await listRecentApprovedComments(c.env.DB, 50, slugs);
	} else {
		comments = await listRecentApprovedComments(c.env.DB, 50, null);
	}

	const { default_locale: operatorDefault } = await loadStrings(c.env);
	const locale = resolveLocale({ operatorDefault });
	const t = tFor(locale);

	const reqUrl = new URL(c.req.url);
	const q = new URLSearchParams();
	if (format === "json") q.set("format", "json");
	if (site) q.set("site", site);
	const qs = q.toString();
	const feedSelf = `${reqUrl.protocol}//${reqUrl.host}/feed${qs ? `?${qs}` : ""}`;
	const title = t("feed.site_title");
	const links = comments.map((row) =>
		commentLink(row.post_url, row.id, c.env.ALLOWED_ORIGINS),
	);

	let res: Response;
	if (format === "json") {
		const doc = {
			version: "https://jsonfeed.org/version/1.1",
			title,
			...(site ? { home_page_url: site } : {}),
			feed_url: feedSelf,
			language: locale,
			items: comments.map((row, i) => ({
				id: entryId(reqUrl.host, row),
				...(links[i] ? { url: links[i] } : {}),
				title: t("feed.entry_title", { author: row.author_name }),
				content_html: row.body_html,
				date_published: new Date(row.created_at).toISOString(),
				...(row.edited_at != null
					? { date_modified: new Date(row.edited_at).toISOString() }
					: {}),
				authors: [{ name: row.author_name }],
				_garrul: {
					post_slug: row.post_slug,
					post_title: row.post_title ?? null,
					post_url: allowedPostUrl(row.post_url, c.env.ALLOWED_ORIGINS),
				},
			})),
		};
		res = new Response(JSON.stringify(doc), {
			headers: {
				"content-type": "application/feed+json; charset=utf-8",
				"cache-control": "public, max-age=300",
				"access-control-allow-origin": "*",
			},
		});
	} else {
		const updated = new Date(comments[0]?.created_at ?? Date.now()).toISOString();
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlEscape(locale)}">
  <id>${xmlEscape(feedSelf)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" type="application/atom+xml" href="${xmlEscape(feedSelf)}"/>
${site ? `  <link rel="alternate" type="text/html" href="${xmlEscape(site)}"/>\n` : ""}  ${generator}
  ${comments.map((row, i) => atomEntry(row, links[i] ?? null, t, reqUrl.host)).join("\n")}
</feed>`;
		res = new Response(xml, {
			headers: {
				"content-type": "application/atom+xml; charset=utf-8",
				"cache-control": "public, max-age=300",
			},
		});
	}
	await putResponse(key, res, tryWaitUntil(c));
	return res;
});

feed.get("/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!slug || slug.length > 200) return c.text("invalid slug", 400);

	const key = feedCacheKey(c.req.url, slug);
	const hit = await matchCache(key);
	if (hit) return hit;

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
	const postLink = allowedPostUrl(post?.url, c.env.ALLOWED_ORIGINS);
	const title = t("feed.title", { title: post?.title ?? slug });
	const updated =
		comments[0] != null
			? new Date(comments[0].created_at).toISOString()
			: new Date(post?.created_at ?? Date.now()).toISOString();

	const entries = comments
		.map((row) =>
			atomEntry(
				row,
				commentLink(post?.url, row.id, c.env.ALLOWED_ORIGINS),
				t,
				reqUrl.host,
			),
		)
		.join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlEscape(locale)}">
  <id>${xmlEscape(feedSelf)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${updated}</updated>
  <link rel="self" type="application/atom+xml" href="${xmlEscape(feedSelf)}"/>
${postLink ? `  <link rel="alternate" type="text/html" href="${xmlEscape(postLink)}"/>\n` : ""}  ${generator}
  ${entries}
</feed>`;

	const res = new Response(xml, {
		headers: {
			"content-type": "application/atom+xml; charset=utf-8",
			"cache-control": "public, max-age=300",
		},
	});
	await putResponse(key, res, tryWaitUntil(c));
	return res;
});

export { feed };
