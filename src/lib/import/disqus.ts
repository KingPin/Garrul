/**
 * Disqus XML adapter.
 *
 * Reads a Disqus comment-export XML file and normalises it for the importer
 * core:
 *
 *   <thread>         → SourceThread  (posts.slug derived from <link> or <id>)
 *   <post>           → SourceComment (body HTML converted to markdown, then
 *                       re-rendered through the allowlist by the core —
 *                       Disqus' raw HTML is never stored)
 *   <post>/<author>  → SourceAuthor  (users.provider='anon')
 *   <post>/<parent>  → parent_source_id, resolved by Disqus dsq:id
 *
 * Disqus is the only supported source that stores comment bodies as HTML with
 * no markdown alongside, so it is the one adapter whose main path runs through
 * `htmlToMarkdown`. (Remark42 uses the same converter, but only as a fallback.)
 *
 * `parseDisqusXml` returns the Disqus-native shape and is tested directly;
 * `DISQUS_ADAPTER.parse` maps that onto the core's normalised shape.
 */
import {
	type ImportAdapter,
	type ImportOptions,
	type ImportPlan,
	MAX_XML_BYTES,
	type SourceExport,
	runImport,
} from "./core";
import { decodeEntities, htmlToMarkdown } from "./html-to-markdown";

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

const stripCdata = (s: string): string => {
	const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
	return m ? m[1]! : s;
};

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

export const DISQUS_ADAPTER: ImportAdapter = {
	source: "disqus",
	slugFallbackPrefix: "disqus-",
	parse(input: string): SourceExport {
		const parsed = parseDisqusXml(input);
		return {
			threads: parsed.threads.map((t) => ({
				source_id: t.dsq_id,
				link: t.link,
				title: t.title,
				created_at: t.created_at,
			})),
			comments: parsed.posts.map((p) => ({
				source_id: p.dsq_id,
				thread_source_id: p.thread_dsq_id,
				parent_source_id: p.parent_dsq_id,
				created_at: p.created_at,
				// Deleted wins over spam: a comment Disqus flagged and then
				// removed is gone either way, and the two flags are independent
				// booleans there, so something has to break the tie. Disqus never
				// yields 'pending' — the export's <isApproved> is not read, so a
				// comment sitting in a Disqus moderation queue still imports as
				// approved, exactly as it did before the status field existed.
				status: p.is_deleted ? "deleted" : p.is_spam ? "spam" : "approved",
				body_md: htmlToMarkdown(p.message_html),
				author: p.author,
			})),
		};
	},
};

export const runDisqusImport = (
	db: D1Database,
	xml: string,
	secret: string,
	opts: ImportOptions = {},
): Promise<ImportPlan> => runImport(db, DISQUS_ADAPTER, xml, secret, opts);
