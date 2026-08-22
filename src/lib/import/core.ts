/**
 * Source-agnostic comment importer core.
 *
 * An adapter parses one vendor's export into the normalised shape below; this
 * file does everything after that — slug derivation, the page upsert, ghost-user
 * identity and dedup, the idempotent comment insert, markdown rendering, and the
 * two-pass parent/depth resolution.
 *
 * Adapters produce **markdown**, never HTML. The core's only sanitising step is
 * `renderMarkdown` over the strict allowlist in `src/lib/markdown.ts`, so an
 * adapter that hands over HTML would store it verbatim. Sources that store HTML
 * convert first — see `src/lib/import/html-to-markdown.ts`.
 *
 * Idempotency:
 *   Every comment is inserted with the adapter's `source` tag under
 *   `import_source` and its native id under `import_id`. The partial UNIQUE
 *   index on (import_source, import_id) added by migration 0009 means a re-run
 *   inserts zero new rows, and lets parallel sources coexist in one instance.
 *
 * Threading:
 *   Exports are not reliably parent-before-child, so parents resolve in two
 *   passes: the first inserts every comment with `parent_id = NULL`, capturing
 *   the source's parent reference; the second sets parent_id and depth once
 *   every native row has an id.
 *
 * Security:
 *   * Input size is capped to abort runaway / malformed exports quickly.
 *   * `posts.url` goes through `safePostUrl` — it is what `permalink.ts`
 *     redirects to, so a non-http(s) value there is an open-redirect gadget.
 *   * `posts.title` goes through `sanitizePostTitle` — it reaches mail subject
 *     lines, where a CR is header injection.
 *   * Ghost users created here cannot authenticate (provider is 'anon', no
 *     OAuth identity).
 */
import { CURRENT_RENDERER_VERSION, renderMarkdown } from "../markdown";
import { sanitizePostTitle } from "../post-title";
import { MAX_REPLY_DEPTH } from "../tree";
import { ulid } from "../ulid";

// Single source of truth for the import size cap (issue #15). The admin
// upload route rejects content-length above this before reading the body,
// and the operator page's client-side check + UI hint derive from it too.
export const MAX_XML_BYTES = 50 * 1024 * 1024;

export type SourceAuthor = {
	name: string;
	email: string | null;
	is_anonymous: boolean;
};

export type SourceThread = {
	/** The source's own id for the page/thread. */
	source_id: string;
	link: string | null;
	title: string | null;
	created_at: number;
};

export type SourceComment = {
	/** The source's own id for this comment; becomes `import_id`. */
	source_id: string;
	thread_source_id: string;
	parent_source_id: string | null;
	created_at: number;
	is_deleted: boolean;
	is_spam: boolean;
	/** Markdown. The adapter has already converted; the core never does. */
	body_md: string;
	author: SourceAuthor;
};

export type SourceExport = {
	threads: SourceThread[];
	comments: SourceComment[];
};

export type ImportAdapter = {
	/** The `import_source` tag written on every row this adapter produces. */
	source: string;
	/**
	 * Prefix for the synthetic slug used when a thread has no usable link —
	 * replaces what used to be a hardcoded `disqus-${id}`.
	 */
	slugFallbackPrefix: string;
	parse(input: string): SourceExport;
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

/**
 * A thread link reduced to something safe to store in `posts.url`, or null.
 *
 * `posts.url` is what `permalink.ts` redirects a reader to, so a non-http(s)
 * value there is an open-redirect / `javascript:` gadget reachable from a
 * comment permalink. POST /api/v1/comments has applied this check to its
 * `post_url` since before the importer existed (api.comments.ts:513-527); the
 * importer wrote the link straight through, so a hand-edited export — or a
 * forum whose thread links were themselves attacker-set — landed an
 * unvalidated URL in the same column by the other door.
 */
export const safePostUrl = (link: string | null): string | null => {
	if (!link) return null;
	try {
		const u = new URL(link);
		return u.protocol === "https:" || u.protocol === "http:" ? link : null;
	} catch {
		return null;
	}
};

const authorKey = async (
	author: SourceAuthor,
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

export const runImport = async (
	db: D1Database,
	adapter: ImportAdapter,
	input: string,
	secret: string,
	opts: ImportOptions = {},
): Promise<ImportPlan> => {
	const parsed = adapter.parse(input);
	const plan: ImportPlan = {
		posts_total: parsed.comments.length,
		posts_skipped_deleted: 0,
		posts_skipped_spam: 0,
		threads_total: parsed.threads.length,
		new_posts: 0,
		new_users: 0,
		new_comments: 0,
	};

	const threadBySlugCandidate = new Map<string, SourceThread>();
	const slugByThreadSourceId = new Map<string, string>();
	for (const t of parsed.threads) {
		const slug =
			opts.slug_override ??
			slugFromLink(t.link, `${adapter.slugFallbackPrefix}${t.source_id}`);
		slugByThreadSourceId.set(t.source_id, slug);
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
			// Both columns go through the same guards the Worker's write path
			// applies: the title through M1's sanitizer (it reaches mail subject
			// lines, where a CR is header injection) and the link through the
			// scheme check. Neither ran on this path before.
			.bind(
				slug,
				sanitizePostTitle(t.title) ?? slug,
				safePostUrl(t.link),
				t.created_at,
			)
			.run();
		plan.new_posts += 1;
	}

	const userIdByAuthorKey = new Map<string, string>();
	const usersToInsert: { id: string; provider_id: string; name: string }[] = [];
	for (const c of parsed.comments) {
		if (!opts.include_deleted && c.is_deleted) continue;
		if (!opts.include_spam && c.is_spam) continue;
		const key = await authorKey(c.author, secret);
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
		usersToInsert.push({ id, provider_id: key, name: c.author.name });
	}

	if (!opts.dry_run && usersToInsert.length > 0) {
		const now = Date.now();
		for (const u of usersToInsert) {
			await db
				.prepare(
					`INSERT INTO users (id, provider, provider_id, name, email,
					                    avatar_url, is_admin, is_banned, created_at,
					                    import_source)
					 VALUES (?, 'anon', ?, ?, NULL, NULL, 0, 0, ?, ?)`,
				)
				.bind(u.id, u.provider_id, u.name, now, adapter.source)
				.run();
		}
	}
	plan.new_users = usersToInsert.length;

	const nativeIdBySourceId = new Map<string, string>();
	for (const c of parsed.comments) {
		if (!opts.include_deleted && c.is_deleted) {
			plan.posts_skipped_deleted += 1;
			continue;
		}
		if (!opts.include_spam && c.is_spam) {
			plan.posts_skipped_spam += 1;
			continue;
		}
		const slug = slugByThreadSourceId.get(c.thread_source_id);
		if (!slug) continue;
		const key = await authorKey(c.author, secret);
		const user_id = userIdByAuthorKey.get(key)!;

		const existing = await db
			.prepare(
				`SELECT id FROM comments WHERE import_source = ? AND import_id = ?`,
			)
			.bind(adapter.source, c.source_id)
			.first<{ id: string }>();
		if (existing) {
			nativeIdBySourceId.set(c.source_id, existing.id);
			continue;
		}

		const html = renderMarkdown(c.body_md);
		const id = ulid();
		nativeIdBySourceId.set(c.source_id, id);
		if (opts.dry_run) {
			plan.new_comments += 1;
			continue;
		}
		await db
			.prepare(
				// parent_id and depth are both NULL/1 here: parents are linked in a
			// second pass below, once every source id has a native id, and depth is
			// only knowable then.
			`INSERT INTO comments (
				   id, post_slug, parent_id, user_id, body_md, body_html,
				   renderer_version, status, ip_hash, user_agent, created_at,
				   import_source, import_id, depth)
				 VALUES (?, ?, NULL, ?, ?, ?, ?, 'approved', NULL, NULL, ?, ?, ?, 1)`,
			)
			.bind(
				id,
				slug,
				user_id,
				c.body_md,
				html,
				CURRENT_RENDERER_VERSION,
				c.created_at,
				adapter.source,
				c.source_id,
			)
			.run();
		plan.new_comments += 1;
	}

	if (!opts.dry_run) {
		// Effective parent links: only pairs where BOTH sides were imported. A
		// comment whose parent was skipped stays a root, and depth has to reflect
		// that, so resolve depth from this map rather than from parent_source_id.
		const effectiveParent = new Map<string, string>();
		for (const c of parsed.comments) {
			if (!c.parent_source_id) continue;
			if (!nativeIdBySourceId.has(c.source_id)) continue;
			if (!nativeIdBySourceId.has(c.parent_source_id)) continue;
			effectiveParent.set(c.source_id, c.parent_source_id);
		}

		// 1-based depth over that map, memoized. The visited set makes a
		// malformed export with a parent cycle terminate instead of hanging the
		// import — no source should produce one, but this walks untrusted input.
		const depthBySourceId = new Map<string, number>();
		const depthOf = (sourceId: string): number => {
			// `chain` walks child → ancestor, so chain[0] is the deepest and
			// chain[last] the shallowest entry we visited.
			const chain: string[] = [];
			const seen = new Set<string>();
			let cur: string | undefined = sourceId;
			// Depth that chain[last] ends up at. 1 when the walk reached a root
			// (or hit a cycle and bailed); memo+1 when it stopped on an already-
			// resolved ancestor, since chain[last] sits one below it.
			let baseDepth = 1;
			while (cur !== undefined && !seen.has(cur)) {
				const memo = depthBySourceId.get(cur);
				if (memo !== undefined) {
					baseDepth = memo + 1;
					break;
				}
				seen.add(cur);
				chain.push(cur);
				cur = effectiveParent.get(cur);
			}
			for (let i = chain.length - 1; i >= 0; i--) {
				depthBySourceId.set(chain[i]!, baseDepth + (chain.length - 1 - i));
			}
			return depthBySourceId.get(sourceId) ?? 1;
		};

		for (const [childSourceId, parentSourceId] of effectiveParent) {
			const child = nativeIdBySourceId.get(childSourceId)!;
			let parentEffective = parentSourceId;
			let depth = depthOf(childSourceId);
			// Past the cap, re-parent to the deepest permitted ancestor rather
			// than dropping the comment. This is the same flattening the renderer
			// already applies past MAX_DEPTH, and it keeps the invariant every
			// row satisfies — depth <= MAX_REPLY_DEPTH — true for imports too,
			// which is what keeps the read path's cost bounded.
			while (depth > MAX_REPLY_DEPTH) {
				const next = effectiveParent.get(parentEffective);
				if (next === undefined) break;
				parentEffective = next;
				depth -= 1;
			}
			const parent = nativeIdBySourceId.get(parentEffective)!;
			await db
				.prepare(`UPDATE comments SET parent_id = ?, depth = ? WHERE id = ?`)
				.bind(parent, Math.min(depth, MAX_REPLY_DEPTH), child)
				.run();
		}
	}

	return plan;
};
