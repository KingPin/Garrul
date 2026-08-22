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
 *   * Input size is capped to abort runaway / malformed exports quickly, on
 *     the *decompressed* side too — see `decodeImportInput`.
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
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Thrown when an inflate would exceed MAX_IMPORT_BYTES. */
export class ImportTooLargeError extends Error {}

/**
 * An export file's bytes as text, transparently gunzipping a gzipped one.
 *
 * Sources hand out gzipped exports as a matter of course — Remark42's
 * `backup` writes `.gz`, and a Disqus export of any size is worth
 * compressing — so requiring the operator to inflate it first is friction
 * for no gain.
 *
 * ## Why the cap is enforced *here* and not left to the parser
 *
 * The upload route caps the request body, which is the **compressed** size.
 * 50 MB of gzip is gigabytes of XML for any input an attacker controls, and
 * a purpose-built bomb does far better than that — so before this function
 * existed, adding gunzip anywhere downstream would have turned an
 * already-enforced 50 MB limit into an unbounded allocation reachable from
 * an authenticated admin upload. `parseDisqusXml` also checks the cap, but
 * it can only do so once the whole string exists, which is exactly the
 * allocation we are trying not to make.
 *
 * So the inflate is read incrementally and abandoned the moment the
 * decompressed total crosses the same ceiling an uncompressed upload would
 * have hit. Peak memory is bounded by the cap either way, and a bomb costs
 * one chunk more than the limit rather than however much it wanted.
 *
 * `DecompressionStream` is a Workers global and a Node ≥18 global, so this
 * is the same code in the Worker and in scripts/.
 */
export const decodeImportInput = async (
	bytes: ArrayBuffer | Uint8Array,
): Promise<string> => {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	// RFC 1952 §2.3.1: every gzip member starts 1f 8b. Sniffing the bytes
	// rather than trusting a filename or Content-Encoding means an operator
	// who renamed the file still gets the right treatment, and a plain XML
	// file that happens to arrive as .gz is not mangled.
	if (u8[0] !== 0x1f || u8[1] !== 0x8b) {
		return new TextDecoder().decode(u8);
	}

	const source = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(u8);
			c.close();
		},
	});
	const reader = source
		.pipeThrough(new DecompressionStream("gzip"))
		.getReader();
	// Decode as we go: a multibyte character split across two chunks has to
	// be held over, which is what { stream: true } does.
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_IMPORT_BYTES) {
				await reader.cancel();
				throw new ImportTooLargeError(
					`gzipped import expands past the ${MAX_IMPORT_BYTES}-byte limit`,
				);
			}
			parts.push(decoder.decode(value, { stream: true }));
		}
	} catch (err) {
		if (err instanceof ImportTooLargeError) throw err;
		// A truncated or corrupt member. The message is the decompressor's,
		// which says nothing about the content — deliberate, since an export
		// carries names, emails and IPs that must not reach a log or an error
		// body.
		throw new Error(`could not gunzip import: ${(err as Error).message}`);
	}
	parts.push(decoder.decode());
	return parts.join("");
};


export type SourceAuthor = {
	name: string;
	email: string | null;
	is_anonymous: boolean;
	/**
	 * The source's own stable id for this author, when it has one.
	 *
	 * Present or absent changes what two rows have to share to become one
	 * ghost user, so it is the adapter's call, not the core's:
	 *
	 *   absent  — identity is derived from name + email. Correct for Disqus,
	 *             whose export gives an anonymous commenter no id at all, so
	 *             name+email is the only thing there is to key on.
	 *   present — identity is the id. Correct for Remark42, whose export
	 *             carries a real per-user id and whose users can rename
	 *             themselves; keying on name there would fork one person into
	 *             two ghosts on a rename, and merge two people who picked the
	 *             same display name.
	 *
	 * Adapters must not start supplying this for a source that previously
	 * omitted it: the seed feeds an HMAC, so changing it changes every
	 * derived `provider_id`, and a re-import would create a second ghost for
	 * everyone rather than deduping against the first.
	 */
	source_id?: string | null;
	/**
	 * The author was blocked at the source. Becomes `users.is_banned` on a
	 * newly-created ghost, and only on a newly-created one — see the users
	 * insert in `runImport` for why an import never re-bans an existing row.
	 *
	 * Absent means "this source does not say", not "not banned": Disqus'
	 * export carries no ban state at all, so its ghosts are all unbanned
	 * regardless of what the forum did.
	 */
	is_banned?: boolean;
};

export type SourceThread = {
	/** The source's own id for the page/thread. */
	source_id: string;
	link: string | null;
	title: string | null;
	created_at: number;
	/**
	 * The page was closed to new comments at the source. Becomes
	 * `posts.closed`, so a thread an operator froze years ago does not
	 * reopen on the way in.
	 *
	 * Only applied to pages this run creates. `posts.closed` is otherwise
	 * operator-controlled (`setPostClosed`), and an import is not an operator
	 * decision — a re-import must not undo a freeze made on this side.
	 */
	closed?: boolean;
};

/**
 * A comment's moderation state at the source, in Garrul's own vocabulary.
 *
 * Identical to the `comments.status` values, and deliberately so: an adapter
 * that has to invent a mapping should do it once, in the adapter, rather than
 * hand the core a source-shaped flag for the core to guess at. Every source in
 * #104 has at least approved/deleted; most also distinguish a moderation queue
 * from a spam verdict, and the ones that do not simply never emit those.
 *
 * `include_deleted` / `include_spam` gate the last two. `pending` is not
 * gated — a comment awaiting moderation is not junk, it is work the operator
 * has not done yet, and dropping it silently loses a decision they never got
 * to make. It lands in the queue on this side too.
 */
export type SourceStatus = "approved" | "pending" | "spam" | "deleted";

export type SourceComment = {
	/** The source's own id for this comment; becomes `import_id`. */
	source_id: string;
	thread_source_id: string;
	parent_source_id: string | null;
	created_at: number;
	status: SourceStatus;
	/**
	 * When the comment was last edited at the source, if it ever was.
	 *
	 * Becomes `comments.edited_at`, which is what the feed reports as
	 * `<updated>` and what the widget hangs its "edited" marker off. The core
	 * drops any value that is not strictly after `created_at`: sources vary on
	 * whether an unedited comment gets a zero, a null or a copy of its own
	 * creation time, and the last of those would mark every imported comment
	 * as edited.
	 */
	edited_at?: number | null;
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

/**
 * What an import run did, or would do under `dry_run`.
 *
 * The counter names deliberately say "pages" and "comments" rather than
 * "threads" and "posts". Every source in #104 uses that second pair, and
 * the two systems mean opposite things by it: a Disqus *post* is one
 * comment and a Disqus *thread* is the page it hangs off, while a
 * WordPress or Remark42 post is the page. Naming the counters after the
 * source's vocabulary put `posts_total` (comments) next to `new_posts`
 * (pages) in the same object, which read as a bug in the code and
 * reported as a bug in the operator UI, where the plan is rendered as
 * raw JSON. Garrul's own nouns are unambiguous, so use them: pages are
 * rows in `posts`, comments are rows in `comments`.
 */
export type ImportPlan = {
	pages_total: number;
	comments_total: number;
	skipped_deleted: number;
	skipped_spam: number;
	new_pages: number;
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

/**
 * The seed the ghost `provider_id` HMAC is taken over.
 *
 * Namespaced by source in the id branch so two systems that both number
 * their users from 1 cannot collide onto one ghost in an instance that
 * imported from both.
 *
 * The name+email branch is deliberately *not* namespaced. It predates the
 * source-agnostic core and every `provider_id` already in a self-hoster's
 * `users` table was derived from exactly these bytes; adding a prefix would
 * orphan all of them, so a re-import would double every imported commenter
 * instead of finding the existing row. Leave it alone.
 */
export const authorSeed = (source: string, author: SourceAuthor): string =>
	author.source_id
		? `${source}:id:${author.source_id}`
		: `${author.name}|${author.email ?? ""}`;

/**
 * Whether a comment in this state is left behind, and which counter it lands
 * in. `null` means import it.
 *
 * One predicate for both passes, deliberately. The ghost-collection pass and
 * the insert pass each have to make this call, and they have to agree: a
 * comment the first pass keeps and the second drops leaves an orphan ghost
 * user with no comments, while the reverse throws on a missing user id. They
 * were two copies of the same pair of conditions before, which is a
 * silent-drift shape.
 */
const isSkipped = (
	status: SourceStatus,
	opts: ImportOptions,
): "deleted" | "spam" | null => {
	if (status === "deleted" && !opts.include_deleted) return "deleted";
	if (status === "spam" && !opts.include_spam) return "spam";
	return null;
};

/**
 * The `comments.edited_at` value for a source comment, or null.
 *
 * Only a timestamp strictly after `created_at` survives. Sources disagree on
 * what an unedited comment carries — null, 0, or a copy of its own creation
 * time — and the shared consequence of taking any of those at face value is an
 * "edited" marker on every imported comment, plus a feed where `<updated>`
 * equals `<published>` for the whole archive. A value *before* creation is
 * incoherent rather than merely unhelpful, and gets the same treatment.
 */
const editedAt = (c: SourceComment): number | null => {
	const at = c.edited_at;
	if (at == null || !Number.isFinite(at) || at <= c.created_at) return null;
	return at;
};

const authorKey = async (
	source: string,
	author: SourceAuthor,
	secret: string,
): Promise<string> => {
	const seed = authorSeed(source, author);
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
		pages_total: parsed.threads.length,
		comments_total: parsed.comments.length,
		skipped_deleted: 0,
		skipped_spam: 0,
		new_pages: 0,
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
			plan.new_pages += 1;
			continue;
		}
		await db
			.prepare(
				`INSERT INTO posts (slug, title, url, created_at, closed)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			// Title and url go through the same guards the Worker's write path
			// applies: the title through M1's sanitizer (it reaches mail subject
			// lines, where a CR is header injection) and the link through the
			// scheme check. Neither ran on this path before.
			.bind(
				slug,
				sanitizePostTitle(t.title) ?? slug,
				safePostUrl(t.link),
				t.created_at,
				t.closed ? 1 : 0,
			)
			.run();
		plan.new_pages += 1;
	}

	const userIdByAuthorKey = new Map<string, string>();
	type PendingUser = {
		id: string;
		provider_id: string;
		name: string;
		is_banned: boolean;
	};
	const usersToInsert = new Map<string, PendingUser>();
	for (const c of parsed.comments) {
		if (isSkipped(c.status, opts)) continue;
		const key = await authorKey(adapter.source, c.author, secret);
		const pending = usersToInsert.get(key);
		if (pending) {
			// Ban state is a property of the author, but every source attaches it
			// to the comment, so one person's comments can disagree — an export
			// taken mid-moderation, or a source that only stamps it on rows
			// written after the block. OR the flags rather than letting whichever
			// comment happened to come first decide.
			if (c.author.is_banned) pending.is_banned = true;
			continue;
		}
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
		usersToInsert.set(key, {
			id,
			provider_id: key,
			name: c.author.name,
			is_banned: c.author.is_banned === true,
		});
	}

	if (!opts.dry_run && usersToInsert.size > 0) {
		const now = Date.now();
		for (const u of usersToInsert.values()) {
			await db
				.prepare(
					`INSERT INTO users (id, provider, provider_id, name, email,
					                    avatar_url, is_admin, is_banned, created_at,
					                    import_source)
					 VALUES (?, 'anon', ?, ?, NULL, NULL, 0, ?, ?, ?)`,
				)
				// is_banned is written on INSERT only. The branch above returns early
				// for a user who already exists, and deliberately: that row may be a
				// ghost an operator has since banned or unbanned on this side, and a
				// re-import silently overwriting their decision with the source's
				// stale one is a moderation regression, not a fidelity improvement.
				.bind(
					u.id,
					u.provider_id,
					u.name,
					u.is_banned ? 1 : 0,
					now,
					adapter.source,
				)
				.run();
		}
	}
	plan.new_users = usersToInsert.size;

	const nativeIdBySourceId = new Map<string, string>();
	for (const c of parsed.comments) {
		const skip = isSkipped(c.status, opts);
		if (skip) {
			if (skip === "deleted") plan.skipped_deleted += 1;
			else plan.skipped_spam += 1;
			continue;
		}
		const slug = slugByThreadSourceId.get(c.thread_source_id);
		if (!slug) continue;
		const key = await authorKey(adapter.source, c.author, secret);
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
				   edited_at, import_source, import_id, depth)
				 VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1)`,
			)
			// status was a hard-coded 'approved' until adapters could report
			// moderation state. deleted_at and deleted_by stay at their NULL
			// defaults even for an imported tombstone: the read path prunes on
			// `status`, not on either of them, and no source's export says *when*
			// or *by whom* the comment was removed — writing created_at there
			// would be inventing a fact to fill a column nothing reads.
			.bind(
				id,
				slug,
				user_id,
				c.body_md,
				html,
				CURRENT_RENDERER_VERSION,
				c.status,
				c.created_at,
				editedAt(c),
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
