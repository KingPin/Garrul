/**
 * Disqus XML importer.
 *
 * Reads a Disqus comment-export XML file and converts it into Garrul's
 * native shape:
 *
 *   <thread>         → posts.slug = derived from <link> or <id>
 *   <post>           → comments.body_md (HTML stripped via the
 *                       allowlist sanitizer, then converted to a flat
 *                       paragraph of text — anything we can't render
 *                       safely is dropped, not preserved as HTML)
 *   <post>/<author>  → users.provider='anon', provider_id derived from
 *                       the author identity, name = display name
 *   <post>/<parent>  → comments.parent_id (resolved by Disqus dsq:id)
 *
 * Idempotency:
 *   Every comment is inserted with import_source='disqus' and an
 *   import_id derived from the Disqus dsq:id. The partial UNIQUE index
 *   on (import_source, import_id) added by migration 0009 means a
 *   re-run inserts zero new rows.
 *
 * Threading:
 *   Disqus emits comments in document order, which is NOT necessarily a
 *   parent-before-child order. We resolve in two passes: first pass
 *   inserts every comment with `parent_id = NULL`, capturing the Disqus
 *   parent reference; second pass updates the parent_id once every
 *   native row has an ID assigned.
 *
 * Security:
 *   * Document size is capped to abort runaway / malformed XML quickly.
 *   * Comment bodies are stripped of HTML and re-rendered through the
 *     existing markdown allowlist. Disqus' raw HTML is never stored.
 *   * Ghost users created by the importer cannot authenticate (provider
 *     is 'anon'; no OAuth identity).
 */
import { CURRENT_RENDERER_VERSION, renderMarkdown } from "./markdown";
import { ulid } from "./ulid";

export type DisqusThread = {
	dsq_id: string;
	link: string | null;
	title: string | null;
	created_at: number;
};

export type DisqusAuthor = {
	name: string;
	email: string | null;
	is_anonymous: boolean;
};

export type DisqusPost = {
	dsq_id: string;
	thread_dsq_id: string;
	parent_dsq_id: string | null;
	created_at: number;
	is_deleted: boolean;
	is_spam: boolean;
	message_html: string;
	author: DisqusAuthor;
};

export type DisqusExport = {
	threads: DisqusThread[];
	posts: DisqusPost[];
};

const MAX_XML_BYTES = 50 * 1024 * 1024;

const stripCdata = (s: string): string => {
	const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
	return m ? m[1]! : s;
};

const decodeEntities = (s: string): string =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");

const innerText = (xml: string, tag: string): string | null => {
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
	const m = xml.match(re);
	if (!m) return null;
	return decodeEntities(stripCdata(m[1]!.trim()));
};

const attr = (xml: string, key: string): string | null => {
	const re = new RegExp(`${key}\\s*=\\s*"([^"]*)"`);
	const m = xml.match(re);
	return m ? decodeEntities(m[1]!) : null;
};

const dsqId = (tag: string): string | null => attr(tag, "dsq:id");

const parseIso = (s: string | null): number => {
	if (!s) return Date.now();
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : Date.now();
};

export const disqusHtmlToMarkdown = (html: string): string => {
	if (!html) return "";
	let text = html;
	text = text.replace(
		/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href: string, inner: string) => {
			const url = decodeEntities(href);
			const label = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
			if (!/^https?:\/\//i.test(url)) return label;
			return label && label !== url ? `[${label}](${url})` : url;
		},
	);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/p>/gi, "\n\n");
	text = text.replace(/<[^>]+>/g, "");
	text = decodeEntities(text);
	return text.trim();
};

const findAll = (xml: string, tag: string): { open: string; inner: string }[] => {
	// Match <tag ...>...</tag>. Disqus tags always close with the same name.
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
	const out: { open: string; inner: string }[] = [];
	const matches = xml.matchAll(re);
	for (const m of matches) {
		const fullStart = m.index ?? 0;
		const openEnd = xml.indexOf(">", fullStart);
		const open = xml.slice(fullStart, openEnd + 1);
		out.push({ open, inner: m[1]! });
	}
	return out;
};

export const parseDisqusXml = (xml: string): DisqusExport => {
	if (xml.length > MAX_XML_BYTES) {
		throw new Error(`disqus xml too large: ${xml.length} > ${MAX_XML_BYTES}`);
	}

	const threads: DisqusThread[] = [];
	for (const { open, inner } of findAll(xml, "thread")) {
		const id = dsqId(open);
		if (!id) continue;
		threads.push({
			dsq_id: id,
			link: innerText(inner, "link"),
			title: innerText(inner, "title"),
			created_at: parseIso(innerText(inner, "createdAt")),
		});
	}

	const posts: DisqusPost[] = [];
	for (const { open, inner } of findAll(xml, "post")) {
		const id = dsqId(open);
		if (!id) continue;
		const threadMatch = inner.match(/<thread\b[^/>]*\/?>/);
		const parentMatch = inner.match(/<parent\b[^/>]*\/?>/);
		const thread_dsq_id = threadMatch ? dsqId(threadMatch[0]) : null;
		if (!thread_dsq_id) continue;
		const parent_dsq_id = parentMatch ? dsqId(parentMatch[0]) : null;

		const message_html = innerText(inner, "message") ?? "";
		const created_at = parseIso(innerText(inner, "createdAt"));
		const isDeleted = innerText(inner, "isDeleted") === "true";
		const isSpam = innerText(inner, "isSpam") === "true";

		const authorBlock = inner.match(/<author\b[^>]*>([\s\S]*?)<\/author>/);
		const author: DisqusAuthor = authorBlock
			? {
					name: innerText(authorBlock[1]!, "name") ?? "anonymous",
					email: innerText(authorBlock[1]!, "email"),
					is_anonymous:
						innerText(authorBlock[1]!, "isAnonymous") === "true",
				}
			: { name: "anonymous", email: null, is_anonymous: true };

		posts.push({
			dsq_id: id,
			thread_dsq_id,
			parent_dsq_id,
			created_at,
			is_deleted: isDeleted,
			is_spam: isSpam,
			message_html,
			author,
		});
	}

	return { threads, posts };
};

export type ImportPlan = {
	posts_total: number;
	posts_skipped_deleted: number;
	posts_skipped_spam: number;
	threads_total: number;
	new_posts: number;
	new_users: number;
	new_comments: number;
};

export type ImportOptions = {
	dry_run?: boolean;
	include_deleted?: boolean;
	include_spam?: boolean;
	slug_override?: string | null;
};

export const slugFromLink = (link: string | null, fallback: string): string => {
	if (!link) return fallback;
	try {
		const u = new URL(link);
		const path = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
		return path || fallback;
	} catch {
		return fallback;
	}
};

const authorKey = async (
	author: DisqusAuthor,
	secret: string,
): Promise<string> => {
	const seed = `${author.name}|${author.email ?? ""}`;
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(seed));
	return Array.from(new Uint8Array(sig))
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};

export const runDisqusImport = async (
	db: D1Database,
	xml: string,
	secret: string,
	opts: ImportOptions = {},
): Promise<ImportPlan> => {
	const parsed = parseDisqusXml(xml);
	const plan: ImportPlan = {
		posts_total: parsed.posts.length,
		posts_skipped_deleted: 0,
		posts_skipped_spam: 0,
		threads_total: parsed.threads.length,
		new_posts: 0,
		new_users: 0,
		new_comments: 0,
	};

	const threadBySlugCandidate = new Map<string, DisqusThread>();
	const slugByThreadDsq = new Map<string, string>();
	for (const t of parsed.threads) {
		const slug = opts.slug_override ?? slugFromLink(t.link, `disqus-${t.dsq_id}`);
		slugByThreadDsq.set(t.dsq_id, slug);
		if (!threadBySlugCandidate.has(slug)) threadBySlugCandidate.set(slug, t);
	}

	for (const [slug, t] of threadBySlugCandidate) {
		const existing = await db
			.prepare(`SELECT slug FROM posts WHERE slug = ?`)
			.bind(slug)
			.first<{ slug: string }>();
		if (existing) continue;
		if (opts.dry_run) {
			plan.new_posts += 1;
			continue;
		}
		await db
			.prepare(
				`INSERT INTO posts (slug, title, url, created_at)
				 VALUES (?, ?, ?, ?)`,
			)
			.bind(slug, t.title ?? slug, t.link ?? null, t.created_at)
			.run();
		plan.new_posts += 1;
	}

	const userIdByAuthorKey = new Map<string, string>();
	const usersToInsert: { id: string; provider_id: string; name: string }[] = [];
	for (const p of parsed.posts) {
		if (!opts.include_deleted && p.is_deleted) continue;
		if (!opts.include_spam && p.is_spam) continue;
		const key = await authorKey(p.author, secret);
		if (userIdByAuthorKey.has(key)) continue;

		const existing = await db
			.prepare(
				`SELECT id FROM users WHERE provider = 'anon' AND provider_id = ?`,
			)
			.bind(key)
			.first<{ id: string }>();
		if (existing) {
			userIdByAuthorKey.set(key, existing.id);
			continue;
		}
		const id = ulid();
		userIdByAuthorKey.set(key, id);
		usersToInsert.push({ id, provider_id: key, name: p.author.name });
	}

	if (!opts.dry_run && usersToInsert.length > 0) {
		const now = Date.now();
		for (const u of usersToInsert) {
			await db
				.prepare(
					`INSERT INTO users (id, provider, provider_id, name, email,
					                    avatar_url, is_admin, is_banned, created_at,
					                    import_source)
					 VALUES (?, 'anon', ?, ?, NULL, NULL, 0, 0, ?, 'disqus')`,
				)
				.bind(u.id, u.provider_id, u.name, now)
				.run();
		}
	}
	plan.new_users = usersToInsert.length;

	const nativeIdByDsq = new Map<string, string>();
	for (const p of parsed.posts) {
		if (!opts.include_deleted && p.is_deleted) {
			plan.posts_skipped_deleted += 1;
			continue;
		}
		if (!opts.include_spam && p.is_spam) {
			plan.posts_skipped_spam += 1;
			continue;
		}
		const slug = slugByThreadDsq.get(p.thread_dsq_id);
		if (!slug) continue;
		const key = await authorKey(p.author, secret);
		const user_id = userIdByAuthorKey.get(key)!;

		const existing = await db
			.prepare(
				`SELECT id FROM comments WHERE import_source = 'disqus' AND import_id = ?`,
			)
			.bind(p.dsq_id)
			.first<{ id: string }>();
		if (existing) {
			nativeIdByDsq.set(p.dsq_id, existing.id);
			continue;
		}

		const md = disqusHtmlToMarkdown(p.message_html);
		const html = renderMarkdown(md);
		const id = ulid();
		nativeIdByDsq.set(p.dsq_id, id);
		if (opts.dry_run) {
			plan.new_comments += 1;
			continue;
		}
		await db
			.prepare(
				`INSERT INTO comments (
				   id, post_slug, parent_id, user_id, body_md, body_html,
				   renderer_version, status, ip_hash, user_agent, created_at,
				   import_source, import_id)
				 VALUES (?, ?, NULL, ?, ?, ?, ?, 'approved', NULL, NULL, ?, ?, ?)`,
			)
			.bind(
				id,
				slug,
				user_id,
				md,
				html,
				CURRENT_RENDERER_VERSION,
				p.created_at,
				"disqus",
				p.dsq_id,
			)
			.run();
		plan.new_comments += 1;
	}

	if (!opts.dry_run) {
		for (const p of parsed.posts) {
			if (!p.parent_dsq_id) continue;
			const child = nativeIdByDsq.get(p.dsq_id);
			const parent = nativeIdByDsq.get(p.parent_dsq_id);
			if (!child || !parent) continue;
			await db
				.prepare(`UPDATE comments SET parent_id = ? WHERE id = ?`)
				.bind(parent, child)
				.run();
		}
	}

	return plan;
};
