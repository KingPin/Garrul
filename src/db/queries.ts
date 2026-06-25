/**
 * Typed D1 query wrappers.
 *
 * All schema access funnels through this module so columns and types stay in
 * one place. Callers get plain typed records; SQL stays here.
 *
 * Conventions:
 *   - All IDs are ULIDs (26 chars, Crockford base32, see lib/ulid.ts).
 *   - Timestamps are UNIX epoch milliseconds (INTEGER in D1).
 *   - Booleans are 0/1 INTEGER in D1; converted to JS booleans here.
 */
import { ulid } from "../lib/ulid";
import { hostExpr } from "./host-expr";

// Escape SQL LIKE wildcards so admin search inputs are matched as literals.
// SQLite treats `%` and `_` as wildcards inside the pattern; without escaping
// them, searching for "50%" matches "501" too, and a string of `_` chars can
// force a full O(n*m) scan on every row. Pair every call site with an
// `ESCAPE '\\'` clause on the LIKE.
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

export type Post = {
	slug: string;
	title: string | null;
	url: string | null;
	created_at: number;
	/** Operator freeze for this one thread: blocks new comments/replies. */
	closed: boolean;
	/** Host page's real publish time (epoch ms), from data-published. The
	 *  anchor for age-based auto-close; NULL falls back to created_at. */
	published_at: number | null;
};

type PostRow = Omit<Post, "closed"> & { closed: number };

const toPost = (row: PostRow): Post => ({
	...row,
	closed: row.closed === 1,
});

// Every posts SELECT goes through this list so the new lifecycle columns stay
// in one place.
const POST_COLS = "slug, title, url, created_at, closed, published_at";

export type UserRole = "user" | "mod" | "admin";

export const USER_ROLES: readonly UserRole[] = ["user", "mod", "admin"] as const;

export const isUserRole = (v: unknown): v is UserRole =>
	v === "user" || v === "mod" || v === "admin";

export type User = {
	id: string;
	provider: string;
	provider_id: string | null;
	name: string;
	email: string | null;
	avatar_url: string | null;
	is_admin: boolean;
	is_banned: boolean;
	role: UserRole;
	created_at: number;
};

export type CommentStatus = "approved" | "pending" | "spam" | "deleted";

export type Comment = {
	id: string;
	post_slug: string;
	parent_id: string | null;
	user_id: string;
	body_md: string;
	body_html: string;
	renderer_version: number;
	status: CommentStatus;
	edited_at: number | null;
	deleted_at: number | null;
	/** Who removed a deleted comment: 'author' (self/own-thread delete) or
	 *  'moderator' (moderation queue). NULL when not deleted. */
	deleted_by: "author" | "moderator" | null;
	ip_hash: string | null;
	user_agent: string | null;
	created_at: number;
	score_up: number;
	score_down: number;
};

type UserRow = Omit<User, "is_admin" | "is_banned" | "role"> & {
	is_admin: number;
	is_banned: number;
	role: string;
};

const toUser = (row: UserRow): User => ({
	...row,
	is_admin: row.is_admin === 1,
	is_banned: row.is_banned === 1,
	role: isUserRole(row.role) ? row.role : "user",
});

export const upsertPost = async (
	db: D1Database,
	slug: string,
	title: string | null,
	url: string | null,
	publishedAt: number | null = null,
): Promise<Post> => {
	const now = Date.now();
	// title/url: COALESCE(excluded, existing) so the host can refresh them on a
	// later comment, but an omitted value never clobbers what's stored.
	// published_at: COALESCE(existing, excluded) — write-once / first-writer-wins.
	// It anchors age-based auto-close, so once set it must be immutable; otherwise
	// an untrusted client could overwrite an established thread's close-anchor with
	// a bogus date to force it closed. closed is operator-controlled, never set here.
	await db
		.prepare(
			`INSERT INTO posts (slug, title, url, created_at, published_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(slug) DO UPDATE SET
			   title        = COALESCE(excluded.title, posts.title),
			   url          = COALESCE(excluded.url,   posts.url),
			   published_at = COALESCE(posts.published_at, excluded.published_at)`,
		)
		.bind(slug, title, url, now, publishedAt)
		.run();
	const row = await db
		.prepare(`SELECT ${POST_COLS} FROM posts WHERE slug = ?`)
		.bind(slug)
		.first<PostRow>();
	if (!row) throw new Error("upsertPost: post not found after insert");
	return toPost(row);
};

export const getPost = async (
	db: D1Database,
	slug: string,
): Promise<Post | null> => {
	const row = await db
		.prepare(`SELECT ${POST_COLS} FROM posts WHERE slug = ?`)
		.bind(slug)
		.first<PostRow>();
	return row ? toPost(row) : null;
};

/** Operator freeze/unfreeze of a single thread. */
export const setPostClosed = async (
	db: D1Database,
	slug: string,
	closed: boolean,
): Promise<void> => {
	await db
		.prepare(`UPDATE posts SET closed = ? WHERE slug = ?`)
		.bind(closed ? 1 : 0, slug)
		.run();
};

// ---------------------------------------------------------------------------
// Reader reports
// ---------------------------------------------------------------------------

export type Report = {
	id: string;
	comment_id: string;
	reporter_user_id: string | null;
	reporter_ip_hash: string | null;
	reason: string | null;
	status: "open" | "resolved";
	created_at: number;
};

/**
 * Record a reader's report of a comment. Returns true if a new report row was
 * created, false if this reporter (by ip_hash) had already reported this
 * comment — the UNIQUE(comment_id, reporter_ip_hash) makes the second attempt a
 * silent no-op so the caller can return the same {ok:true} either way without
 * leaking prior-report state.
 */
export const insertReport = async (
	db: D1Database,
	args: {
		comment_id: string;
		reporter_user_id?: string | null;
		reporter_ip_hash?: string | null;
		reason?: string | null;
	},
): Promise<boolean> => {
	const res = await db
		.prepare(
			// Scope the silent ignore to the intended dedup conflict only.
			// A bare INSERT OR IGNORE would also swallow e.g. a foreign-key
			// violation as a benign 0-change "duplicate"; ON CONFLICT on the
			// unique pair lets any other error throw instead.
			`INSERT INTO reports
			   (id, comment_id, reporter_user_id, reporter_ip_hash, reason, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?)
			 ON CONFLICT(comment_id, reporter_ip_hash) DO NOTHING`,
		)
		.bind(
			ulid(),
			args.comment_id,
			args.reporter_user_id ?? null,
			args.reporter_ip_hash ?? null,
			args.reason ?? null,
			Date.now(),
		)
		.run();
	// D1 surfaces the affected-row count on meta.changes; the ON CONFLICT
	// DO NOTHING path (this reporter already flagged this comment) reports 0.
	return (res.meta?.changes ?? 0) > 0;
};

/** Open-report counts for a set of comment IDs (queue badges). Empty → {}. */
export const countOpenReportsByComment = async (
	db: D1Database,
	commentIds: string[],
): Promise<Record<string, number>> => {
	if (commentIds.length === 0) return {};
	const placeholders = commentIds.map(() => "?").join(",");
	const rows = await db
		.prepare(
			`SELECT comment_id, COUNT(*) AS n
			   FROM reports
			  WHERE status = 'open' AND comment_id IN (${placeholders})
			  GROUP BY comment_id`,
		)
		.bind(...commentIds)
		.all<{ comment_id: string; n: number }>();
	const out: Record<string, number> = {};
	for (const r of rows.results ?? []) out[r.comment_id] = r.n;
	return out;
};

/** Full report list for one comment (comment-detail page). */
export const listReportsForComment = async (
	db: D1Database,
	commentId: string,
): Promise<Report[]> => {
	const rows = await db
		.prepare(
			`SELECT id, comment_id, reporter_user_id, reporter_ip_hash, reason,
			        status, created_at
			   FROM reports WHERE comment_id = ? ORDER BY created_at DESC`,
		)
		.bind(commentId)
		.all<Report>();
	return rows.results ?? [];
};

/** Resolve (dismiss) all open reports on a comment. Returns rows affected. */
export const resolveReportsForComment = async (
	db: D1Database,
	commentId: string,
): Promise<number> => {
	const res = await db
		.prepare(
			`UPDATE reports SET status = 'resolved'
			  WHERE comment_id = ? AND status = 'open'`,
		)
		.bind(commentId)
		.run();
	return res.meta?.changes ?? 0;
};

/**
 * Returns the existing ghost user for this ip_hash, or creates one.
 *
 * Ghost users are the per-IP anonymous identity used for anonymous comments.
 * provider='anon', provider_id=ip_hash. The (provider, provider_id) UNIQUE
 * constraint means the same browser/IP always reuses the same user_id, so
 * an edit/delete on the session can still find the author.
 */
export const getOrCreateGhost = async (
	db: D1Database,
	ipHash: string,
	displayName: string,
): Promise<User> => {
	const existing = await db
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			 FROM users WHERE provider = 'anon' AND provider_id = ?`,
		)
		.bind(ipHash)
		.first<UserRow>();
	if (existing) return toUser(existing);

	const id = ulid();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email,
			                    avatar_url, is_admin, is_banned, created_at)
			 VALUES (?, 'anon', ?, ?, NULL, NULL, 0, 0, ?)`,
		)
		.bind(id, ipHash, displayName, now)
		.run();

	return {
		id,
		provider: "anon",
		provider_id: ipHash,
		name: displayName,
		email: null,
		avatar_url: null,
		is_admin: false,
		is_banned: false,
		role: "user",
		created_at: now,
	};
};

/**
 * Upsert an OAuth user keyed on (provider, provider_id).
 *
 * On UPDATE we refresh non-security-sensitive display fields (name +
 * avatar_url) so an updated GitHub display name / avatar propagates.
 * We deliberately don't touch `email` or `is_admin` on UPDATE:
 *   - `email` is set once at create-time. Refreshing it from each token's
 *     profile means a compromised or relaxed provider can rewrite the
 *     email stored against an existing account, which has knock-on
 *     consequences (admin promotion via ADMIN_EMAILS, subscription
 *     fast-path matching).
 *   - `is_admin` is promoted only at create-time when the verified email
 *     matches ADMIN_EMAILS. Auto-promotion on every login means the
 *     operator can't safely demote an admin by editing ADMIN_EMAILS —
 *     the next login would re-promote them. Demotion (and out-of-band
 *     promotion) is now a manual SQL operation.
 */
export const upsertOauthUser = async (
	db: D1Database,
	provider: string,
	provider_id: string,
	name: string,
	email: string | null,
	avatar_url: string | null,
	adminEmails: Set<string>,
): Promise<User> => {
	const existing = await db
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			 FROM users WHERE provider = ? AND provider_id = ?`,
		)
		.bind(provider, provider_id)
		.first<UserRow>();

	if (existing) {
		await db
			.prepare(
				`UPDATE users
				    SET name = ?, avatar_url = ?
				  WHERE id = ?`,
			)
			.bind(name, avatar_url, existing.id)
			.run();
		return toUser({
			...existing,
			name,
			avatar_url,
		});
	}

	const shouldPromote = email != null && adminEmails.has(email.toLowerCase());
	const id = ulid();
	const now = Date.now();
	const is_admin = shouldPromote ? 1 : 0;
	const role: UserRole = shouldPromote ? "admin" : "user";
	await db
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email,
			                    avatar_url, is_admin, is_banned, role, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		)
		.bind(id, provider, provider_id, name, email, avatar_url, is_admin, role, now)
		.run();
	return {
		id,
		provider,
		provider_id,
		name,
		email,
		avatar_url,
		is_admin: is_admin === 1,
		is_banned: false,
		role,
		created_at: now,
	};
};

export const getUser = async (
	db: D1Database,
	id: string,
): Promise<User | null> => {
	const row = await db
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			 FROM users WHERE id = ?`,
		)
		.bind(id)
		.first<UserRow>();
	return row ? toUser(row) : null;
};

type InsertCommentInput = {
	post_slug: string;
	parent_id: string | null;
	user_id: string;
	body_md: string;
	body_html: string;
	renderer_version: number;
	status?: CommentStatus;
	ip_hash: string | null;
	user_agent: string | null;
};

export const insertComment = async (
	db: D1Database,
	input: InsertCommentInput,
): Promise<Comment> => {
	const id = ulid();
	const now = Date.now();
	const status: CommentStatus = input.status ?? "approved";
	await db
		.prepare(
			`INSERT INTO comments (
			   id, post_slug, parent_id, user_id, body_md, body_html,
			   renderer_version, status, edited_at, deleted_at, deleted_by,
			   ip_hash, user_agent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
		)
		.bind(
			id,
			input.post_slug,
			input.parent_id,
			input.user_id,
			input.body_md,
			input.body_html,
			input.renderer_version,
			status,
			input.ip_hash,
			input.user_agent,
			now,
		)
		.run();
	return {
		id,
		post_slug: input.post_slug,
		parent_id: input.parent_id,
		user_id: input.user_id,
		body_md: input.body_md,
		body_html: input.body_html,
		renderer_version: input.renderer_version,
		status,
		edited_at: null,
		deleted_at: null,
		deleted_by: null,
		ip_hash: input.ip_hash,
		user_agent: input.user_agent,
		created_at: now,
		score_up: 0,
		score_down: 0,
	};
};

export const getComment = async (
	db: D1Database,
	id: string,
): Promise<Comment | null> => {
	return await db
		.prepare(
			`SELECT id, post_slug, parent_id, user_id, body_md, body_html,
			        renderer_version, status, edited_at, deleted_at, deleted_by,
			        ip_hash, user_agent, created_at, score_up, score_down
			 FROM comments WHERE id = ?`,
		)
		.bind(id)
		.first<Comment>();
};

/**
 * Batch-fetch comments by ID. Used by the digest job to avoid N+1 lookups
 * when rendering one digest with M comments.
 */
export const getCommentsByIds = async (
	db: D1Database,
	ids: string[],
): Promise<Map<string, Comment>> => {
	if (ids.length === 0) return new Map();
	const placeholders = ids.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT id, post_slug, parent_id, user_id, body_md, body_html,
			        renderer_version, status, edited_at, deleted_at, deleted_by,
			        ip_hash, user_agent, created_at, score_up, score_down
			   FROM comments WHERE id IN (${placeholders})`,
		)
		.bind(...ids)
		.all<Comment>();
	const out = new Map<string, Comment>();
	for (const row of result.results ?? []) out.set(row.id, row);
	return out;
};

/**
 * Batch-fetch users by ID. Companion to getCommentsByIds for the digest job.
 */
export const getUsersByIds = async (
	db: D1Database,
	ids: string[],
): Promise<Map<string, User>> => {
	if (ids.length === 0) return new Map();
	const placeholders = ids.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, role, created_at
			   FROM users WHERE id IN (${placeholders})`,
		)
		.bind(...ids)
		.all<UserRow>();
	const out = new Map<string, User>();
	for (const row of result.results ?? []) out.set(row.id, toUser(row));
	return out;
};

/**
 * Fetch publicly visible comments for a post. Excludes `spam` and
 * `pending` — both are stored in D1 and visible in the admin queue,
 * but never leak via the public tree. Returned `deleted` comments are
 * kept so the tree builder can preserve chain ancestry; their body_html
 * is blanked at render time.
 */
export const listCommentsForPost = async (
	db: D1Database,
	post_slug: string,
): Promise<Comment[]> => {
	const result = await db
		.prepare(
			`SELECT id, post_slug, parent_id, user_id, body_md, body_html,
			        renderer_version, status, edited_at, deleted_at, deleted_by,
			        ip_hash, user_agent, created_at, score_up, score_down
			 FROM comments
			 WHERE post_slug = ? AND status NOT IN ('spam', 'pending')
			 ORDER BY created_at ASC, id ASC`,
		)
		.bind(post_slug)
		.all<Comment>();
	return result.results ?? [];
};

/**
 * Fetch a single viewer's own `pending` comments for a post. Merged into
 * the public tree only for the authenticated author so they can see their
 * comment is queued for moderation — never exposed to other viewers (the
 * caller scopes this to `session.user_id`). Signed-in list responses bypass
 * the edge cache, so these rows never leak into the anonymous cached copy.
 */
export const listOwnPendingForPost = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
): Promise<Comment[]> => {
	const result = await db
		.prepare(
			`SELECT id, post_slug, parent_id, user_id, body_md, body_html,
			        renderer_version, status, edited_at, deleted_at, deleted_by,
			        ip_hash, user_agent, created_at, score_up, score_down
			 FROM comments
			 WHERE post_slug = ? AND user_id = ? AND status = 'pending'
			 ORDER BY created_at ASC, id ASC`,
		)
		.bind(post_slug, user_id)
		.all<Comment>();
	return result.results ?? [];
};

/**
 * Latest N approved comments for a post, joined with author name, for
 * the per-post RSS feed.
 */
export const listLatestApprovedComments = async (
	db: D1Database,
	post_slug: string,
	limit: number,
): Promise<(Comment & { author_name: string })[]> => {
	const result = await db
		.prepare(
			`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
			        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
			        c.ip_hash, c.user_agent, c.created_at, c.score_up, c.score_down,
			        u.name AS author_name
			   FROM comments c
			   JOIN users u ON u.id = c.user_id
			  WHERE c.post_slug = ? AND c.status = 'approved'
			  ORDER BY c.created_at DESC, c.id DESC
			  LIMIT ?`,
		)
		.bind(post_slug, limit)
		.all<Comment & { author_name: string }>();
	return result.results ?? [];
};

/**
 * Approved comment counts for multiple slugs in one round-trip.
 * Returns a Map keyed by slug; missing/zero slugs are not present.
 */
export const countApprovedCommentsBySlugs = async (
	db: D1Database,
	slugs: string[],
): Promise<Map<string, number>> => {
	if (slugs.length === 0) return new Map();
	const placeholders = slugs.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT post_slug, COUNT(*) AS count
			   FROM comments
			  WHERE status = 'approved' AND post_slug IN (${placeholders})
			  GROUP BY post_slug`,
		)
		.bind(...slugs)
		.all<{ post_slug: string; count: number }>();
	const out = new Map<string, number>();
	for (const row of result.results ?? []) {
		out.set(row.post_slug, row.count);
	}
	return out;
};

/**
 * Read every operator-set row from the `settings` key/value store as a plain
 * map. Absent keys mean "inherit env/default" — the resolution layer
 * (src/lib/settings.ts) decides precedence, not this function.
 */
export const getAllSettings = async (
	db: D1Database,
): Promise<Record<string, string>> => {
	const result = await db
		.prepare("SELECT key, value FROM settings")
		.all<{ key: string; value: string }>();
	const out: Record<string, string> = {};
	for (const row of result.results ?? []) {
		out[row.key] = row.value;
	}
	return out;
};

/**
 * Upsert a single operator setting. Callers validate the key against the
 * known flag allowlist before writing; this wrapper does not.
 */
export const setSetting = async (
	db: D1Database,
	key: string,
	value: string,
): Promise<void> => {
	await db
		.prepare(
			`INSERT INTO settings (key, value, updated_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			                               updated_at = excluded.updated_at`,
		)
		.bind(key, value, Date.now())
		.run();
};

/**
 * Delete operator settings rows by key, restoring env/default inheritance for
 * those flags. No-op for an empty list.
 */
export const deleteSettings = async (
	db: D1Database,
	keys: string[],
): Promise<void> => {
	if (keys.length === 0) return;
	const placeholders = keys.map(() => "?").join(",");
	await db
		.prepare(`DELETE FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.run();
};

export const updateCommentBody = async (
	db: D1Database,
	id: string,
	body_md: string,
	body_html: string,
	renderer_version: number,
): Promise<void> => {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE comments
			    SET body_md = ?, body_html = ?, renderer_version = ?,
			        edited_at = ?
			  WHERE id = ?`,
		)
		.bind(body_md, body_html, renderer_version, now, id)
		.run();
};

/**
 * Toggle a (comment_id, user_id, kind) reaction. Returns the new state:
 *   { added: true }  — the row was inserted (user just reacted)
 *   { added: false } — the row existed and was deleted (user un-reacted)
 *
 * One round-trip via INSERT … ON CONFLICT … DO NOTHING + a follow-up
 * delete when the conflict path fires. D1 doesn't surface ROW_CHANGED
 * reliably across versions, so we use changes() from the run() metadata.
 */
export const toggleReaction = async (
	db: D1Database,
	comment_id: string,
	user_id: string,
	kind: string,
): Promise<{ added: boolean }> => {
	const now = Date.now();
	const ins = await db
		.prepare(
			`INSERT INTO reactions (comment_id, user_id, kind, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(comment_id, user_id, kind) DO NOTHING`,
		)
		.bind(comment_id, user_id, kind, now)
		.run();
	if (ins.meta.changes && ins.meta.changes > 0) {
		return { added: true };
	}
	await db
		.prepare(
			`DELETE FROM reactions
			 WHERE comment_id = ? AND user_id = ? AND kind = ?`,
		)
		.bind(comment_id, user_id, kind)
		.run();
	return { added: false };
};

export type ReactionSummary = {
	comment_id: string;
	kind: string;
	count: number;
};

/**
 * Aggregate reactions for every comment on a post: (comment_id, kind, count).
 * Caller pivots to per-comment buckets.
 */
export const listReactionsForPost = async (
	db: D1Database,
	post_slug: string,
): Promise<ReactionSummary[]> => {
	const result = await db
		.prepare(
			`SELECT r.comment_id, r.kind, COUNT(*) AS count
			 FROM reactions r
			 JOIN comments c ON c.id = r.comment_id
			 WHERE c.post_slug = ?
			 GROUP BY r.comment_id, r.kind`,
		)
		.bind(post_slug)
		.all<{ comment_id: string; kind: string; count: number }>();
	return result.results ?? [];
};

/**
 * Returns the set of (comment_id, kind) pairs the given user has reacted
 * with on the given post. Returned as `comment_id|kind` strings so the
 * caller can do an O(1) presence check.
 */
export const listUserReactionsOnPost = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
): Promise<Set<string>> => {
	const result = await db
		.prepare(
			`SELECT r.comment_id, r.kind
			 FROM reactions r
			 JOIN comments c ON c.id = r.comment_id
			 WHERE c.post_slug = ? AND r.user_id = ?`,
		)
		.bind(post_slug, user_id)
		.all<{ comment_id: string; kind: string }>();
	const out = new Set<string>();
	for (const row of result.results ?? []) {
		out.add(`${row.comment_id}|${row.kind}`);
	}
	return out;
};

// -- Page-level engagement (react / vote on the article itself) -------------
//
// Mirrors the comment-level reaction/vote helpers above but keys on
// posts(slug). The caller must ensure the post row exists (upsertPost) before
// inserting, since both tables FK to posts(slug). Identity is the same
// ghost-by-ip_hash model as comments.

/**
 * Toggle a page reaction. Returns whether the row was added (true) or removed
 * (false) — a repeat click from the same user/kind toggles it off.
 */
export const togglePageReaction = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
	kind: string,
): Promise<{ added: boolean }> => {
	const now = Date.now();
	const ins = await db
		.prepare(
			`INSERT INTO page_reactions (post_slug, user_id, kind, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(post_slug, user_id, kind) DO NOTHING`,
		)
		.bind(post_slug, user_id, kind, now)
		.run();
	if (ins.meta.changes && ins.meta.changes > 0) {
		return { added: true };
	}
	await db
		.prepare(
			`DELETE FROM page_reactions
			 WHERE post_slug = ? AND user_id = ? AND kind = ?`,
		)
		.bind(post_slug, user_id, kind)
		.run();
	return { added: false };
};

export type PageReactionSummary = { kind: string; count: number };

/** Totals per reaction kind for one post. */
export const listPageReactions = async (
	db: D1Database,
	post_slug: string,
): Promise<PageReactionSummary[]> => {
	const result = await db
		.prepare(
			`SELECT kind, COUNT(*) AS count
			   FROM page_reactions
			  WHERE post_slug = ?
			  GROUP BY kind`,
		)
		.bind(post_slug)
		.all<{ kind: string; count: number }>();
	return result.results ?? [];
};

/** The set of reaction kinds the given user has applied to one post. */
export const listUserPageReactions = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
): Promise<Set<string>> => {
	const result = await db
		.prepare(
			`SELECT kind FROM page_reactions
			  WHERE post_slug = ? AND user_id = ?`,
		)
		.bind(post_slug, user_id)
		.all<{ kind: string }>();
	const out = new Set<string>();
	for (const row of result.results ?? []) out.add(row.kind);
	return out;
};

export type PageVoteResult = {
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
};

const reselectPageVote = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
): Promise<PageVoteResult> => {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM page_votes WHERE post_slug = ?1 AND value =  1) AS score_up,
			   (SELECT COUNT(*) FROM page_votes WHERE post_slug = ?1 AND value = -1) AS score_down,
			   COALESCE((SELECT value FROM page_votes
			              WHERE post_slug = ?1 AND user_id = ?2), 0) AS my_vote`,
		)
		.bind(post_slug, user_id)
		.first<{ score_up: number; score_down: number; my_vote: number }>();
	if (!row) return { score_up: 0, score_down: 0, my_vote: 0 };
	const mv = row.my_vote === 1 || row.my_vote === -1 ? row.my_vote : 0;
	return { score_up: row.score_up, score_down: row.score_down, my_vote: mv };
};

/**
 * Cast (value=±1) or clear (value=0) the caller's page vote, then return the
 * recomputed tally and their now-vote. Unlike comment votes there's no
 * denormalized counter on `posts`, so the tally is computed on read — page
 * votes are far lower-volume than per-comment votes.
 */
export const castPageVote = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
	value: VoteValue,
): Promise<PageVoteResult> => {
	if (value === 0) {
		await db
			.prepare(`DELETE FROM page_votes WHERE post_slug = ? AND user_id = ?`)
			.bind(post_slug, user_id)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO page_votes (post_slug, user_id, value, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(post_slug, user_id) DO UPDATE SET
				   value      = excluded.value,
				   created_at = excluded.created_at`,
			)
			.bind(post_slug, user_id, value, Date.now())
			.run();
	}
	return reselectPageVote(db, post_slug, user_id);
};

/** Public read of a post's vote tally + the viewer's own vote (0 if none). */
export const getPageVote = async (
	db: D1Database,
	post_slug: string,
	user_id: string | null,
): Promise<PageVoteResult> =>
	reselectPageVote(db, post_slug, user_id ?? "");

export type PageVoteTally = { score_up: number; score_down: number };

/**
 * Page-vote tallies for many slugs in one round-trip — the batch sibling of
 * getPageVote, viewer-agnostic (no my_vote). Used by /api/v1/counts. Slugs
 * with no votes are omitted; the caller defaults missing keys to a zero tally.
 */
export const countPageVotesBySlugs = async (
	db: D1Database,
	slugs: string[],
): Promise<Map<string, PageVoteTally>> => {
	if (slugs.length === 0) return new Map();
	const placeholders = slugs.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT post_slug,
			        SUM(CASE WHEN value =  1 THEN 1 ELSE 0 END) AS score_up,
			        SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS score_down
			   FROM page_votes
			  WHERE post_slug IN (${placeholders})
			  GROUP BY post_slug`,
		)
		.bind(...slugs)
		.all<{ post_slug: string; score_up: number; score_down: number }>();
	const out = new Map<string, PageVoteTally>();
	for (const row of result.results ?? []) {
		out.set(row.post_slug, {
			score_up: row.score_up ?? 0,
			score_down: row.score_down ?? 0,
		});
	}
	return out;
};

/**
 * Page-reaction totals (per kind) for many slugs in one round-trip — the
 * batch sibling of listPageReactions. Used by /api/v1/counts. Slugs with no
 * reactions are omitted; the caller defaults missing keys to an empty map.
 */
export const countPageReactionsBySlugs = async (
	db: D1Database,
	slugs: string[],
): Promise<Map<string, Record<string, number>>> => {
	if (slugs.length === 0) return new Map();
	const placeholders = slugs.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT post_slug, kind, COUNT(*) AS count
			   FROM page_reactions
			  WHERE post_slug IN (${placeholders})
			  GROUP BY post_slug, kind`,
		)
		.bind(...slugs)
		.all<{ post_slug: string; kind: string; count: number }>();
	const out = new Map<string, Record<string, number>>();
	for (const row of result.results ?? []) {
		const byKind = out.get(row.post_slug) ?? {};
		byKind[row.kind] = row.count;
		out.set(row.post_slug, byKind);
	}
	return out;
};

/**
 * Admin: page through comments by status, newest first. Cursor is the
 * created_at,id pair of the last row from the previous page.
 */
export type AdminComment = Comment & {
	author_name: string | null;
	author_email: string | null;
	author_avatar_url: string | null;
	author_provider: string | null;
	author_is_admin: boolean;
	author_is_banned: boolean;
	host: string;
	// Optional so the other toAdminComment producers (comment-detail SELECTs)
	// that don't fetch these columns stay valid — only the queue query selects
	// them, to link a row back to the page it was posted on.
	post_url?: string | null;
	post_title?: string | null;
};

type AdminCommentRow = Omit<
	AdminComment,
	"author_is_admin" | "author_is_banned"
> & {
	author_is_admin: number | null;
	author_is_banned: number | null;
};

const toAdminComment = (row: AdminCommentRow): AdminComment => ({
	...row,
	author_is_admin: row.author_is_admin === 1,
	author_is_banned: row.author_is_banned === 1,
});

export type AdminCommentFilter = {
	status?: CommentStatus | "all";
	q?: string;
	post_slug?: string;
	user_id?: string;
	from?: number;
	to?: number;
	host?: string;
	/** Restrict to comments that have at least one OPEN reader report. */
	reported?: boolean;
};

export const adminListComments = async (
	db: D1Database,
	filter: AdminCommentFilter,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<AdminComment[]> => {
	const where: string[] = ["1=1"];
	const binds: (number | string)[] = [];

	if (cursorCreatedAt != null && cursorId != null) {
		where.push("(c.created_at, c.id) < (?, ?)");
		binds.push(cursorCreatedAt, cursorId);
	}
	const status = filter.status ?? "all";
	if (status !== "all") {
		where.push("c.status = ?");
		binds.push(status);
	}
	if (filter.q) {
		where.push("LOWER(c.body_md) LIKE ? ESCAPE '\\'");
		binds.push(`%${escapeLike(filter.q.toLowerCase())}%`);
	}
	if (filter.post_slug) {
		where.push("c.post_slug = ?");
		binds.push(filter.post_slug);
	}
	if (filter.user_id) {
		where.push("c.user_id = ?");
		binds.push(filter.user_id);
	}
	if (filter.from != null) {
		where.push("c.created_at >= ?");
		binds.push(filter.from);
	}
	if (filter.to != null) {
		where.push("c.created_at < ?");
		binds.push(filter.to);
	}
	if (filter.host) {
		where.push(`${hostExpr("p.url")} = ?`);
		binds.push(filter.host);
	}
	if (filter.reported) {
		where.push(
			"EXISTS (SELECT 1 FROM reports r WHERE r.comment_id = c.id AND r.status = 'open')",
		);
	}

	const sql = `
		SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
		       c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
		       c.ip_hash, c.user_agent, c.created_at, c.score_up, c.score_down,
		       u.name       AS author_name,
		       u.email      AS author_email,
		       u.avatar_url AS author_avatar_url,
		       u.provider   AS author_provider,
		       u.is_admin   AS author_is_admin,
		       u.is_banned  AS author_is_banned,
		       ${hostExpr("p.url")} AS host,
		       p.url        AS post_url,
		       p.title      AS post_title
		  FROM comments c
		  LEFT JOIN users u ON u.id = c.user_id
		  LEFT JOIN posts p ON p.slug = c.post_slug
		 WHERE ${where.join(" AND ")}
		 ORDER BY c.created_at DESC, c.id DESC
		 LIMIT ?`;
	binds.push(limit);
	const result = await db
		.prepare(sql)
		.bind(...binds)
		.all<AdminCommentRow>();
	return (result.results ?? []).map(toAdminComment);
};

/**
 * Distinct page hosts (derived from posts.url) used by every admin surface
 * that filters by domain. Includes the NO_URL_BUCKET sentinel when posts
 * without a url exist.
 */
export const adminListHosts = async (db: D1Database): Promise<string[]> => {
	const sql = `SELECT DISTINCT ${hostExpr("url")} AS host FROM posts ORDER BY host`;
	const result = await db.prepare(sql).all<{ host: string }>();
	return (result.results ?? []).map((r) => r.host);
};

export const updateCommentStatus = async (
	db: D1Database,
	id: string,
	status: CommentStatus,
): Promise<void> => {
	const now = Date.now();
	// deleted_at / deleted_by are set when transitioning to 'deleted',
	// cleared otherwise. This path is the moderation queue, so attribute the
	// removal to a moderator.
	const deletedAt = status === "deleted" ? now : null;
	const deletedBy = status === "deleted" ? "moderator" : null;
	await db
		.prepare(
			`UPDATE comments
			    SET status = ?, deleted_at = ?, deleted_by = ?
			  WHERE id = ?`,
		)
		.bind(status, deletedAt, deletedBy, id)
		.run();
};

/**
 * Admin: page through users, newest first. `search` matches on name OR
 * email (case-insensitive prefix). Pass null to list everyone.
 */
export const adminListUsers = async (
	db: D1Database,
	search: string | null,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<User[]> => {
	const pattern = search ? `${escapeLike(search.toLowerCase())}%` : null;
	const filter = pattern
		? "AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')"
		: "";
	const sql = cursorCreatedAt != null && cursorId != null
		? `SELECT id, provider, provider_id, name, email, avatar_url,
		          is_admin, is_banned, role, created_at
		     FROM users
		    WHERE (created_at, id) < (?, ?) ${filter}
		    ORDER BY created_at DESC, id DESC
		    LIMIT ?`
		: `SELECT id, provider, provider_id, name, email, avatar_url,
		          is_admin, is_banned, role, created_at
		     FROM users
		    WHERE 1=1 ${filter}
		    ORDER BY created_at DESC, id DESC
		    LIMIT ?`;
	const binds: (string | number)[] = [];
	if (cursorCreatedAt != null && cursorId != null) {
		binds.push(cursorCreatedAt, cursorId);
	}
	if (pattern) binds.push(pattern, pattern);
	binds.push(limit);
	const result = await db
		.prepare(sql)
		.bind(...binds)
		.all<UserRow>();
	return (result.results ?? []).map(toUser);
};

export const setUserBanned = async (
	db: D1Database,
	id: string,
	banned: boolean,
): Promise<void> => {
	await db
		.prepare(`UPDATE users SET is_banned = ? WHERE id = ?`)
		.bind(banned ? 1 : 0, id)
		.run();
};

// Writes role and is_admin together so the invariant `is_admin=1 ⇔ role='admin'`
// is preserved while is_admin remains the public-facing column for /me.
export const setUserRole = async (
	db: D1Database,
	id: string,
	role: UserRole,
): Promise<void> => {
	const is_admin = role === "admin" ? 1 : 0;
	await db
		.prepare(`UPDATE users SET role = ?, is_admin = ? WHERE id = ?`)
		.bind(role, is_admin, id)
		.run();
};

// Used by the role-change endpoint to refuse a demotion that would leave
// the instance with zero admins. Self-demotion is already blocked, so
// this guards the parallel-demotion edge case (two admins each demoting
// the other simultaneously).
export const countAdmins = async (db: D1Database): Promise<number> => {
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
		.first<{ n: number }>();
	return row?.n ?? 0;
};

export type AdminStats = {
	total_comments: number;
	pending_comments: number;
	spam_comments: number;
	total_users: number;
	banned_users: number;
};

export const adminStats = async (db: D1Database): Promise<AdminStats> => {
	const row = await db
		.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM comments)                          AS total_comments,
			   (SELECT COUNT(*) FROM comments WHERE status = 'pending') AS pending_comments,
			   (SELECT COUNT(*) FROM comments WHERE status = 'spam')    AS spam_comments,
			   (SELECT COUNT(*) FROM users)                             AS total_users,
			   (SELECT COUNT(*) FROM users WHERE is_banned = 1)         AS banned_users`,
		)
		.first<AdminStats>();
	return (
		row ?? {
			total_comments: 0,
			pending_comments: 0,
			spam_comments: 0,
			total_users: 0,
			banned_users: 0,
		}
	);
};

export const softDeleteComment = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = Date.now();
	// The public delete route: the author removing their own comment (or an
	// admin acting on the author's behalf via the same endpoint). Attributed
	// to 'author' to distinguish from a moderation-queue removal.
	await db
		.prepare(
			`UPDATE comments
			    SET status = 'deleted', deleted_at = ?, deleted_by = 'author'
			  WHERE id = ?`,
		)
		.bind(now, id)
		.run();
};

export type Subscription = {
	id: string;
	post_slug: string;
	email: string;
	token: string;
	created_at: number;
	unsubscribed_at: number | null;
	last_notified_at: number | null;
	confirm_token: string | null;
	confirmed_at: number | null;
};

/**
 * Upsert a subscription for (post_slug, email).
 *
 * `auto_confirm` is passed by the route only when the caller is a logged-in
 * user submitting their own provider-verified email — that path skips the
 * email-loop because the user has already proved control of the inbox.
 *
 * Re-subscribing the same address:
 *   - rotates the unsubscribe `token` and clears `unsubscribed_at` so the
 *     row is live again,
 *   - leaves `confirmed_at` alone if it was already set (you don't have to
 *     re-confirm an already-confirmed address — but you DO have to confirm
 *     a never-confirmed re-attempt; we rotate `confirm_token` for that case).
 */
export const upsertSubscription = async (
	db: D1Database,
	post_slug: string,
	email: string,
	token: string,
	confirm_token: string | null,
	auto_confirm: boolean,
): Promise<Subscription> => {
	const now = Date.now();
	const id = ulid();
	const confirmed_at_on_insert = auto_confirm ? now : null;
	await db
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, created_at,
			    unsubscribed_at, last_notified_at,
			    confirm_token, confirmed_at)
			 VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
			 ON CONFLICT(post_slug, email) DO UPDATE SET
			   token = excluded.token,
			   unsubscribed_at = NULL,
			   -- only refresh confirm_token if the row is still unconfirmed;
			   -- if already confirmed we don't reset it (preserves one-shot).
			   confirm_token = CASE WHEN subscriptions.confirmed_at IS NULL
			                        THEN excluded.confirm_token
			                        ELSE subscriptions.confirm_token END,
			   confirmed_at  = CASE WHEN excluded.confirmed_at IS NOT NULL
			                        THEN excluded.confirmed_at
			                        ELSE subscriptions.confirmed_at END`,
		)
		.bind(
			id,
			post_slug,
			email.toLowerCase(),
			token,
			now,
			confirm_token,
			confirmed_at_on_insert,
		)
		.run();
	const row = await db
		.prepare(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at
			   FROM subscriptions
			  WHERE post_slug = ? AND email = ?`,
		)
		.bind(post_slug, email.toLowerCase())
		.first<Subscription>();
	if (!row) throw new Error("upsertSubscription: not found after insert");
	return row;
};

export const getSubscriptionByToken = async (
	db: D1Database,
	token: string,
): Promise<Subscription | null> => {
	return await db
		.prepare(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at
			   FROM subscriptions WHERE token = ?`,
		)
		.bind(token)
		.first<Subscription>();
};

export const getSubscriptionByConfirmToken = async (
	db: D1Database,
	confirm_token: string,
): Promise<Subscription | null> => {
	return await db
		.prepare(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at
			   FROM subscriptions WHERE confirm_token = ?`,
		)
		.bind(confirm_token)
		.first<Subscription>();
};

// We deliberately do NOT clear `confirm_token` here. Mail clients
// (Gmail, Outlook, corporate link-scanners) routinely prefetch every
// URL in an inbound email — if the first GET nulled the token, the
// human's later click would land on a 404 "link expired" page even
// though the address was already confirmed by the bot's prefetch.
// Leaving the token alive makes the GET handler idempotent: the
// re-click finds the row, sees confirmed_at is set, and renders the
// success page again. The token never grants more than the same
// (already-exercised) confirm capability, so leaving it valid is safe.
export const confirmSubscription = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE subscriptions
			    SET confirmed_at = ?
			  WHERE id = ? AND confirmed_at IS NULL`,
		)
		.bind(now, id)
		.run();
};

export const countPendingSubscriptionsForEmail = async (
	db: D1Database,
	email: string,
): Promise<number> => {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM subscriptions
			  WHERE email = ? AND confirmed_at IS NULL`,
		)
		.bind(email.toLowerCase())
		.first<{ n: number }>();
	return row?.n ?? 0;
};

export const markSubscriptionUnsubscribed = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = Date.now();
	await db
		.prepare(`UPDATE subscriptions SET unsubscribed_at = ? WHERE id = ?`)
		.bind(now, id)
		.run();
};

export const listActiveSubscriptionsForPost = async (
	db: D1Database,
	post_slug: string,
): Promise<Subscription[]> => {
	const result = await db
		.prepare(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at
			   FROM subscriptions
			  WHERE post_slug = ?
			    AND unsubscribed_at IS NULL
			    AND confirmed_at IS NOT NULL`,
		)
		.bind(post_slug)
		.all<Subscription>();
	return result.results ?? [];
};

export const enqueueNotification = async (
	db: D1Database,
	subscription_id: string,
	comment_id: string,
): Promise<void> => {
	const id = ulid();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
			 VALUES (?, ?, ?, ?, NULL)`,
		)
		.bind(id, subscription_id, comment_id, now)
		.run();
};

export type PendingDigest = {
	subscription_id: string;
	email: string;
	token: string;
	post_slug: string;
	notification_ids: string[];
	comment_ids: string[];
};

/**
 * Group pending notifications by subscription. Returns one digest per
 * subscriber with their queued notifications. Each digest is the
 * cron job's atomic unit: send the email, then mark the listed
 * notification_ids as sent.
 *
 * `older_than` filters out notifications newer than the debounce window
 * so a burst of replies coalesces into the next cron tick.
 */
export const listPendingDigests = async (
	db: D1Database,
	older_than: number,
	limit: number,
): Promise<PendingDigest[]> => {
	const result = await db
		.prepare(
			`SELECT n.id          AS notification_id,
			        n.comment_id  AS comment_id,
			        s.id          AS subscription_id,
			        s.email       AS email,
			        s.token       AS token,
			        s.post_slug   AS post_slug
			   FROM notifications n
			   JOIN subscriptions s ON s.id = n.subscription_id
			  WHERE n.sent_at IS NULL
			    AND n.created_at < ?
			    AND s.unsubscribed_at IS NULL
			    AND s.confirmed_at IS NOT NULL
			  ORDER BY n.created_at ASC`,
		)
		.bind(older_than)
		.all<{
			notification_id: string;
			comment_id: string;
			subscription_id: string;
			email: string;
			token: string;
			post_slug: string;
		}>();
	const groups = new Map<string, PendingDigest>();
	for (const row of result.results ?? []) {
		let g = groups.get(row.subscription_id);
		if (!g) {
			g = {
				subscription_id: row.subscription_id,
				email: row.email,
				token: row.token,
				post_slug: row.post_slug,
				notification_ids: [],
				comment_ids: [],
			};
			groups.set(row.subscription_id, g);
		}
		g.notification_ids.push(row.notification_id);
		g.comment_ids.push(row.comment_id);
		if (groups.size >= limit) break;
	}
	return Array.from(groups.values());
};

export const markNotificationsSent = async (
	db: D1Database,
	ids: string[],
): Promise<void> => {
	if (ids.length === 0) return;
	const now = Date.now();
	const placeholders = ids.map(() => "?").join(",");
	await db
		.prepare(`UPDATE notifications SET sent_at = ? WHERE id IN (${placeholders})`)
		.bind(now, ...ids)
		.run();
};

export const updateSubscriptionLastNotified = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = Date.now();
	await db
		.prepare(`UPDATE subscriptions SET last_notified_at = ? WHERE id = ?`)
		.bind(now, id)
		.run();
};

/**
 * Page through comments whose renderer_version is below `target`. Used by
 * scripts/rerender.ts. Returns (id, body_md) only; the script re-renders and
 * calls updateCommentBody.
 */
export const listStaleRendererComments = async (
	db: D1Database,
	target: number,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<{ id: string; body_md: string; created_at: number }[]> => {
	const stmt =
		cursorCreatedAt != null && cursorId != null
			? db
					.prepare(
						`SELECT id, body_md, created_at FROM comments
						 WHERE renderer_version < ?
						   AND (created_at, id) > (?, ?)
						 ORDER BY created_at ASC, id ASC
						 LIMIT ?`,
					)
					.bind(target, cursorCreatedAt, cursorId, limit)
			: db
					.prepare(
						`SELECT id, body_md, created_at FROM comments
						 WHERE renderer_version < ?
						 ORDER BY created_at ASC, id ASC
						 LIMIT ?`,
					)
					.bind(target, limit);
	const result = await stmt.all<{
		id: string;
		body_md: string;
		created_at: number;
	}>();
	return result.results ?? [];
};

// ---------------------------------------------------------------------------
// Admin observability — audit log, spam verdicts, dashboard aggregates,
// detail-page rollups, subscriptions admin. Backed by migration 0004.
// ---------------------------------------------------------------------------

export type AuditTargetKind =
	| "comment"
	| "user"
	| "subscription"
	| "webhook"
	| "saved_reply"
	| "post"
	| "system";

export const ADMIN_ACTIONS = [
	"approve",
	"spam",
	"delete",
	"restore",
	"edit",
	"ban",
	"unban",
	"rerender",
	"seed-demo",
	"sub.unsubscribe",
	"sub.resend",
	"bulk.approve",
	"bulk.spam",
	"bulk.delete",
	"bulk.restore",
	"webhook.create",
	"webhook.update",
	"webhook.delete",
	"role.grant_mod",
	"role.revoke_mod",
	"role.grant_admin",
	"role.revoke_admin",
	"saved_reply.create",
	"saved_reply.update",
	"saved_reply.delete",
	"saved_reply.post",
	"import.disqus",
	"settings.update",
	"post.close",
	"post.open",
	"report.resolve",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export type AuditRow = {
	id: string;
	admin_id: string;
	action: string;
	target_kind: AuditTargetKind;
	target_id: string | null;
	reason: string | null;
	meta: string | null;
	created_at: number;
};

export type AuditRowWithAdmin = AuditRow & { admin_name: string | null };

export const adminInsertAudit = async (
	db: D1Database,
	args: {
		admin_id: string;
		action: AdminAction | string;
		target_kind: AuditTargetKind;
		target_id?: string | null;
		reason?: string | null;
		meta?: Record<string, unknown> | null;
	},
): Promise<void> => {
	const id = ulid();
	await db
		.prepare(
			`INSERT INTO audit_log
			   (id, admin_id, action, target_kind, target_id, reason, meta, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			args.admin_id,
			args.action,
			args.target_kind,
			args.target_id ?? null,
			args.reason ?? null,
			args.meta ? JSON.stringify(args.meta) : null,
			Date.now(),
		)
		.run();
};

export type AdminAuditFilter = {
	admin_id?: string;
	action?: string;
	target_kind?: AuditTargetKind;
	target_id?: string;
	from?: number;
	to?: number;
	host?: string;
};

export const adminListAudit = async (
	db: D1Database,
	filter: AdminAuditFilter,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<AuditRowWithAdmin[]> => {
	const where: string[] = ["1=1"];
	const binds: (string | number)[] = [];
	if (cursorCreatedAt != null && cursorId != null) {
		where.push("(a.created_at, a.id) < (?, ?)");
		binds.push(cursorCreatedAt, cursorId);
	}
	if (filter.admin_id) {
		where.push("a.admin_id = ?");
		binds.push(filter.admin_id);
	}
	if (filter.action) {
		where.push("a.action = ?");
		binds.push(filter.action);
	}
	if (filter.target_kind) {
		where.push("a.target_kind = ?");
		binds.push(filter.target_kind);
	}
	if (filter.target_id) {
		where.push("a.target_id = ?");
		binds.push(filter.target_id);
	}
	if (filter.from != null) {
		where.push("a.created_at >= ?");
		binds.push(filter.from);
	}
	if (filter.to != null) {
		where.push("a.created_at < ?");
		binds.push(filter.to);
	}
	if (filter.host) {
		// Host derivation lives on posts, so the filter only narrows
		// comment-targeted audit rows. User/post/etc. action rows are
		// excluded when a host is active — the dropdown UX advertises this.
		where.push(
			`a.target_kind = 'comment' AND a.target_id IN (
				SELECT c.id FROM comments c
				LEFT JOIN posts p ON p.slug = c.post_slug
				 WHERE ${hostExpr("p.url")} = ?
			)`,
		);
		binds.push(filter.host);
	}
	const sql = `
		SELECT a.id, a.admin_id, a.action, a.target_kind, a.target_id,
		       a.reason, a.meta, a.created_at,
		       u.name AS admin_name
		  FROM audit_log a
		  LEFT JOIN users u ON u.id = a.admin_id
		 WHERE ${where.join(" AND ")}
		 ORDER BY a.created_at DESC, a.id DESC
		 LIMIT ?`;
	binds.push(limit);
	const result = await db
		.prepare(sql)
		.bind(...binds)
		.all<AuditRowWithAdmin>();
	return result.results ?? [];
};

export const adminAuditForTarget = async (
	db: D1Database,
	target_kind: AuditTargetKind,
	target_id: string,
	limit: number,
): Promise<AuditRowWithAdmin[]> => {
	const result = await db
		.prepare(
			`SELECT a.id, a.admin_id, a.action, a.target_kind, a.target_id,
			        a.reason, a.meta, a.created_at,
			        u.name AS admin_name
			   FROM audit_log a
			   LEFT JOIN users u ON u.id = a.admin_id
			  WHERE a.target_kind = ? AND a.target_id = ?
			  ORDER BY a.created_at DESC, a.id DESC
			  LIMIT ?`,
		)
		.bind(target_kind, target_id, limit)
		.all<AuditRowWithAdmin>();
	return result.results ?? [];
};

// Map of {target_id: latestAuditRow} for a batch of comment IDs. Used to
// render the "approved by X · 3h ago" strip under each queue row in one
// extra query rather than N. Returns only the latest row per target.
export const adminLatestAuditByTarget = async (
	db: D1Database,
	target_kind: AuditTargetKind,
	target_ids: string[],
): Promise<Map<string, AuditRowWithAdmin>> => {
	if (target_ids.length === 0) return new Map();
	const placeholders = target_ids.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT a.id, a.admin_id, a.action, a.target_kind, a.target_id,
			        a.reason, a.meta, a.created_at,
			        u.name AS admin_name
			   FROM audit_log a
			   LEFT JOIN users u ON u.id = a.admin_id
			  WHERE a.target_kind = ?
			    AND a.target_id IN (${placeholders})
			  ORDER BY a.created_at DESC, a.id DESC`,
		)
		.bind(target_kind, ...target_ids)
		.all<AuditRowWithAdmin>();
	const out = new Map<string, AuditRowWithAdmin>();
	for (const row of result.results ?? []) {
		if (row.target_id && !out.has(row.target_id)) {
			out.set(row.target_id, row);
		}
	}
	return out;
};

// ---------------------------------------------------------------------------
// Spam verdicts
// ---------------------------------------------------------------------------

export type SpamVerdictSource = "akismet" | "workers-ai" | "heuristics";
export type SpamVerdictValue = "spam" | "ham" | "uncertain";

export type SpamVerdictRow = {
	id: string;
	comment_id: string;
	source: string;
	verdict: string;
	score: number | null;
	raw: string | null;
	created_at: number;
};

export const adminInsertSpamVerdict = async (
	db: D1Database,
	args: {
		comment_id: string;
		source: SpamVerdictSource | string;
		verdict: SpamVerdictValue | string;
		score?: number | null;
		raw?: unknown;
	},
): Promise<void> => {
	const id = ulid();
	const rawJson =
		args.raw == null
			? null
			: typeof args.raw === "string"
				? args.raw
				: JSON.stringify(args.raw);
	await db
		.prepare(
			`INSERT INTO spam_verdicts
			   (id, comment_id, source, verdict, score, raw, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			args.comment_id,
			args.source,
			args.verdict,
			args.score ?? null,
			rawJson,
			Date.now(),
		)
		.run();
};

export const adminListSpamVerdicts = async (
	db: D1Database,
	comment_id: string,
): Promise<SpamVerdictRow[]> => {
	const result = await db
		.prepare(
			`SELECT id, comment_id, source, verdict, score, raw, created_at
			   FROM spam_verdicts
			  WHERE comment_id = ?
			  ORDER BY created_at DESC, id DESC`,
		)
		.bind(comment_id)
		.all<SpamVerdictRow>();
	return result.results ?? [];
};

// Latest verdict per source for a batch of comment IDs. Used to render
// verdict pills on queue rows in one extra query.
export const adminLatestVerdictsByComment = async (
	db: D1Database,
	comment_ids: string[],
): Promise<Map<string, SpamVerdictRow[]>> => {
	if (comment_ids.length === 0) return new Map();
	const placeholders = comment_ids.map(() => "?").join(",");
	const result = await db
		.prepare(
			`SELECT id, comment_id, source, verdict, score, raw, created_at
			   FROM spam_verdicts
			  WHERE comment_id IN (${placeholders})
			  ORDER BY created_at DESC, id DESC`,
		)
		.bind(...comment_ids)
		.all<SpamVerdictRow>();
	const out = new Map<string, SpamVerdictRow[]>();
	const seenSources = new Map<string, Set<string>>();
	for (const row of result.results ?? []) {
		const key = row.comment_id;
		let sources = seenSources.get(key);
		if (!sources) {
			sources = new Set();
			seenSources.set(key, sources);
		}
		if (sources.has(row.source)) continue; // keep only latest per source
		sources.add(row.source);
		const list = out.get(key) ?? [];
		list.push(row);
		out.set(key, list);
	}
	return out;
};

// ---------------------------------------------------------------------------
// Dashboard aggregates
// ---------------------------------------------------------------------------

export type TimelinePoint = { day: string; count: number };

export const adminTimeline = async (
	db: D1Database,
	days: number,
): Promise<TimelinePoint[]> => {
	const from = Date.now() - days * 24 * 3600 * 1000;
	const result = await db
		.prepare(
			`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
			        COUNT(*) AS count
			   FROM comments
			  WHERE created_at >= ?
			  GROUP BY day
			  ORDER BY day ASC`,
		)
		.bind(from)
		.all<TimelinePoint>();
	return result.results ?? [];
};

export type TopPost = {
	post_slug: string;
	count: number;
	title: string | null;
};

export const adminTopPosts = async (
	db: D1Database,
	days: number,
	limit: number,
): Promise<TopPost[]> => {
	const from = Date.now() - days * 24 * 3600 * 1000;
	const result = await db
		.prepare(
			`SELECT c.post_slug AS post_slug,
			        COUNT(*)    AS count,
			        p.title     AS title
			   FROM comments c
			   LEFT JOIN posts p ON p.slug = c.post_slug
			  WHERE c.created_at >= ?
			    AND c.status = 'approved'
			  GROUP BY c.post_slug
			  ORDER BY count DESC
			  LIMIT ?`,
		)
		.bind(from, limit)
		.all<TopPost>();
	return result.results ?? [];
};

export type TopCommenter = {
	user_id: string;
	name: string;
	avatar_url: string | null;
	count: number;
};

export const adminTopCommenters = async (
	db: D1Database,
	days: number,
	limit: number,
): Promise<TopCommenter[]> => {
	const from = Date.now() - days * 24 * 3600 * 1000;
	const result = await db
		.prepare(
			`SELECT c.user_id      AS user_id,
			        u.name         AS name,
			        u.avatar_url   AS avatar_url,
			        COUNT(*)       AS count
			   FROM comments c
			   JOIN users u ON u.id = c.user_id
			  WHERE c.created_at >= ?
			    AND c.status = 'approved'
			  GROUP BY c.user_id
			  ORDER BY count DESC
			  LIMIT ?`,
		)
		.bind(from, limit)
		.all<TopCommenter>();
	return result.results ?? [];
};

export const adminOldestPending = async (
	db: D1Database,
): Promise<{ id: string; created_at: number } | null> => {
	const row = await db
		.prepare(
			`SELECT id, created_at FROM comments
			  WHERE status = 'pending'
			  ORDER BY created_at ASC
			  LIMIT 1`,
		)
		.first<{ id: string; created_at: number }>();
	return row ?? null;
};

export type CommentsByHostRow = {
	host: string;
	total: number;
	pending: number;
	spam: number;
};

export const adminCommentsByHost = async (
	db: D1Database,
): Promise<CommentsByHostRow[]> => {
	const sql = `
		SELECT ${hostExpr("p.url")} AS host,
		       COUNT(*)                                          AS total,
		       SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending,
		       SUM(CASE WHEN c.status = 'spam'    THEN 1 ELSE 0 END) AS spam
		  FROM comments c
		  LEFT JOIN posts p ON p.slug = c.post_slug
		 GROUP BY host
		 ORDER BY total DESC, host ASC`;
	const result = await db.prepare(sql).all<CommentsByHostRow>();
	return result.results ?? [];
};

export type SpamRate = { total: number; spam: number };

export const adminSpamRate = async (
	db: D1Database,
	days: number,
): Promise<SpamRate> => {
	const from = Date.now() - days * 24 * 3600 * 1000;
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN status = 'spam' THEN 1 ELSE 0 END) AS spam
			   FROM comments
			  WHERE created_at >= ?`,
		)
		.bind(from)
		.first<{ total: number; spam: number | null }>();
	return { total: row?.total ?? 0, spam: row?.spam ?? 0 };
};

// ---------------------------------------------------------------------------
// Detail pages
// ---------------------------------------------------------------------------

export type AdminCommentDetail = {
	comment: AdminComment;
	parent: AdminComment | null;
	replies: AdminComment[];
	ip_siblings: AdminComment[];
	user_recent: AdminComment[];
	verdicts: SpamVerdictRow[];
	reports: Report[];
	audit: AuditRowWithAdmin[];
};

export const adminGetCommentDetail = async (
	db: D1Database,
	id: string,
): Promise<AdminCommentDetail | null> => {
	const commentRow = await db
		.prepare(
			`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
			        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
			        c.ip_hash, c.user_agent, c.created_at,
			        u.name       AS author_name,
			        u.email      AS author_email,
			        u.avatar_url AS author_avatar_url,
			        u.provider   AS author_provider,
			        u.is_admin   AS author_is_admin,
			        u.is_banned  AS author_is_banned,
			        ${hostExpr("p.url")} AS host
			   FROM comments c
			   LEFT JOIN users u ON u.id = c.user_id
			   LEFT JOIN posts p ON p.slug = c.post_slug
			  WHERE c.id = ?`,
		)
		.bind(id)
		.first<AdminCommentRow>();
	if (!commentRow) return null;
	const comment = toAdminComment(commentRow);

	const parent = comment.parent_id
		? await db
				.prepare(
					`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
					        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
					        c.ip_hash, c.user_agent, c.created_at,
					        u.name       AS author_name,
					        u.email      AS author_email,
					        u.avatar_url AS author_avatar_url,
					        u.provider   AS author_provider,
					        u.is_admin   AS author_is_admin,
					        u.is_banned  AS author_is_banned
					   FROM comments c
					   LEFT JOIN users u ON u.id = c.user_id
					  WHERE c.id = ?`,
				)
				.bind(comment.parent_id)
				.first<AdminCommentRow>()
				.then((r) => (r ? toAdminComment(r) : null))
		: null;

	const repliesResult = await db
		.prepare(
			`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
			        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
			        c.ip_hash, c.user_agent, c.created_at,
			        u.name       AS author_name,
			        u.email      AS author_email,
			        u.avatar_url AS author_avatar_url,
			        u.provider   AS author_provider,
			        u.is_admin   AS author_is_admin,
			        u.is_banned  AS author_is_banned,
			        ${hostExpr("p.url")} AS host
			   FROM comments c
			   LEFT JOIN users u ON u.id = c.user_id
			   LEFT JOIN posts p ON p.slug = c.post_slug
			  WHERE c.parent_id = ?
			  ORDER BY c.created_at ASC
			  LIMIT 20`,
		)
		.bind(id)
		.all<AdminCommentRow>();
	const replies = (repliesResult.results ?? []).map(toAdminComment);

	const ipSiblings = comment.ip_hash
		? await db
				.prepare(
					`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
					        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
					        c.ip_hash, c.user_agent, c.created_at,
					        u.name       AS author_name,
					        u.email      AS author_email,
					        u.avatar_url AS author_avatar_url,
					        u.provider   AS author_provider,
					        u.is_admin   AS author_is_admin,
					        u.is_banned  AS author_is_banned
					   FROM comments c
					   LEFT JOIN users u ON u.id = c.user_id
					  WHERE c.ip_hash = ? AND c.id != ?
					  ORDER BY c.created_at DESC
					  LIMIT 10`,
				)
				.bind(comment.ip_hash, id)
				.all<AdminCommentRow>()
				.then((r) => (r.results ?? []).map(toAdminComment))
		: [];

	const userRecent = await db
		.prepare(
			`SELECT c.id, c.post_slug, c.parent_id, c.user_id, c.body_md, c.body_html,
			        c.renderer_version, c.status, c.edited_at, c.deleted_at, c.deleted_by,
			        c.ip_hash, c.user_agent, c.created_at,
			        u.name       AS author_name,
			        u.email      AS author_email,
			        u.avatar_url AS author_avatar_url,
			        u.provider   AS author_provider,
			        u.is_admin   AS author_is_admin,
			        u.is_banned  AS author_is_banned,
			        ${hostExpr("p.url")} AS host
			   FROM comments c
			   LEFT JOIN users u ON u.id = c.user_id
			   LEFT JOIN posts p ON p.slug = c.post_slug
			  WHERE c.user_id = ? AND c.id != ?
			  ORDER BY c.created_at DESC
			  LIMIT 5`,
		)
		.bind(comment.user_id, id)
		.all<AdminCommentRow>()
		.then((r) => (r.results ?? []).map(toAdminComment));

	const verdicts = await adminListSpamVerdicts(db, id);
	const reports = await listReportsForComment(db, id);
	const audit = await adminAuditForTarget(db, "comment", id, 50);

	return {
		comment,
		parent,
		replies,
		ip_siblings: ipSiblings,
		user_recent: userRecent,
		verdicts,
		reports,
		audit,
	};
};

export type AdminUserDetail = {
	user: User;
	comments: AdminComment[];
	next_cursor: string | null;
	reactions_received: number;
	audit: AuditRowWithAdmin[];
};

export const adminGetUserDetail = async (
	db: D1Database,
	id: string,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<AdminUserDetail | null> => {
	const user = await getUser(db, id);
	if (!user) return null;

	const rows = await adminListComments(
		db,
		{ user_id: id },
		limit + 1,
		cursorCreatedAt,
		cursorId,
	);
	const trimmed = rows.slice(0, limit);
	const last = trimmed[trimmed.length - 1];
	const next_cursor =
		rows.length > limit && last ? `${last.created_at}|${last.id}` : null;

	const reactionsRow = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM reactions r
			   JOIN comments c ON c.id = r.comment_id
			  WHERE c.user_id = ?`,
		)
		.bind(id)
		.first<{ n: number }>();

	const audit = await adminAuditForTarget(db, "user", id, 50);

	return {
		user,
		comments: trimmed,
		next_cursor,
		reactions_received: reactionsRow?.n ?? 0,
		audit,
	};
};

// ---------------------------------------------------------------------------
// Bulk comment status update (used by the queue's bulk-actions bar)
// ---------------------------------------------------------------------------

export const adminBulkUpdateCommentStatus = async (
	db: D1Database,
	ids: string[],
	status: CommentStatus,
): Promise<string[]> => {
	if (ids.length === 0) return [];
	const now = Date.now();
	const deletedAt = status === "deleted" ? now : null;
	const placeholders = ids.map(() => "?").join(",");
	// Only update rows that currently exist; return their IDs so the caller
	// can audit-log exactly the rows that were touched.
	const existing = await db
		.prepare(`SELECT id FROM comments WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<{ id: string }>();
	const presentIds = (existing.results ?? []).map((r) => r.id);
	if (presentIds.length === 0) return [];
	const presentPlaceholders = presentIds.map(() => "?").join(",");
	await db
		.prepare(
			`UPDATE comments
			    SET status = ?, deleted_at = ?
			  WHERE id IN (${presentPlaceholders})`,
		)
		.bind(status, deletedAt, ...presentIds)
		.run();
	return presentIds;
};

// ---------------------------------------------------------------------------
// Subscriptions admin
// ---------------------------------------------------------------------------

export type AdminSubscriptionFilter = {
	q?: string;
	post_slug?: string;
	confirmed?: boolean;
	unsubscribed?: boolean;
	host?: string;
};

export const adminListSubscriptions = async (
	db: D1Database,
	filter: AdminSubscriptionFilter,
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<Subscription[]> => {
	const where: string[] = ["1=1"];
	const binds: (string | number)[] = [];
	if (cursorCreatedAt != null && cursorId != null) {
		where.push("(created_at, id) < (?, ?)");
		binds.push(cursorCreatedAt, cursorId);
	}
	if (filter.q) {
		where.push("LOWER(email) LIKE ? ESCAPE '\\'");
		binds.push(`%${escapeLike(filter.q.toLowerCase())}%`);
	}
	if (filter.post_slug) {
		where.push("post_slug = ?");
		binds.push(filter.post_slug);
	}
	if (filter.confirmed === true) where.push("confirmed_at IS NOT NULL");
	if (filter.confirmed === false) where.push("confirmed_at IS NULL");
	if (filter.unsubscribed === true) where.push("unsubscribed_at IS NOT NULL");
	if (filter.unsubscribed === false) where.push("unsubscribed_at IS NULL");
	if (filter.host) {
		where.push(
			`post_slug IN (SELECT slug FROM posts WHERE ${hostExpr("url")} = ?)`,
		);
		binds.push(filter.host);
	}

	const sql = `
		SELECT id, post_slug, email, token, created_at,
		       unsubscribed_at, last_notified_at,
		       confirm_token, confirmed_at
		  FROM subscriptions
		 WHERE ${where.join(" AND ")}
		 ORDER BY created_at DESC, id DESC
		 LIMIT ?`;
	binds.push(limit);
	const result = await db
		.prepare(sql)
		.bind(...binds)
		.all<Subscription>();
	return result.results ?? [];
};

export const adminGetSubscription = async (
	db: D1Database,
	id: string,
): Promise<Subscription | null> => {
	return await db
		.prepare(
			`SELECT id, post_slug, email, token, created_at,
			        unsubscribed_at, last_notified_at,
			        confirm_token, confirmed_at
			   FROM subscriptions WHERE id = ?`,
		)
		.bind(id)
		.first<Subscription>();
};

export const adminRotateSubscriptionConfirmToken = async (
	db: D1Database,
	id: string,
	new_token: string,
): Promise<void> => {
	await db
		.prepare(
			`UPDATE subscriptions
			    SET confirm_token = ?, confirmed_at = NULL
			  WHERE id = ?`,
		)
		.bind(new_token, id)
		.run();
};

// -----------------------------------------------------------------------------
// Webhook endpoints + deliveries (migration 0006).
// -----------------------------------------------------------------------------

export type WebhookAdapter = "generic" | "slack" | "discord";

export const isWebhookAdapter = (v: unknown): v is WebhookAdapter =>
	v === "generic" || v === "slack" || v === "discord";

export type WebhookEndpoint = {
	id: string;
	url: string;
	secret: string | null;
	events: string[] | null; // null = all events
	adapter: WebhookAdapter;
	enabled: boolean;
	fail_count: number;
	disabled_at: number | null;
	created_at: number;
	updated_at: number;
};

type WebhookEndpointRow = {
	id: string;
	url: string;
	secret: string | null;
	events: string | null;
	adapter: string;
	enabled: number;
	fail_count: number;
	disabled_at: number | null;
	created_at: number;
	updated_at: number;
};

const toWebhookEndpoint = (row: WebhookEndpointRow): WebhookEndpoint => ({
	id: row.id,
	url: row.url,
	secret: row.secret,
	events:
		row.events == null || row.events === ""
			? null
			: row.events
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
	adapter: isWebhookAdapter(row.adapter) ? row.adapter : "generic",
	enabled: row.enabled === 1,
	fail_count: row.fail_count,
	disabled_at: row.disabled_at,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

export const listWebhookEndpoints = async (
	db: D1Database,
): Promise<WebhookEndpoint[]> => {
	const rs = await db
		.prepare(
			`SELECT id, url, secret, events, adapter, enabled, fail_count,
			        disabled_at, created_at, updated_at
			   FROM webhook_endpoints
			  ORDER BY created_at ASC`,
		)
		.all<WebhookEndpointRow>();
	return (rs.results ?? []).map(toWebhookEndpoint);
};

export const listEnabledWebhookEndpoints = async (
	db: D1Database,
): Promise<WebhookEndpoint[]> => {
	const rs = await db
		.prepare(
			`SELECT id, url, secret, events, adapter, enabled, fail_count,
			        disabled_at, created_at, updated_at
			   FROM webhook_endpoints
			  WHERE enabled = 1
			  ORDER BY created_at ASC`,
		)
		.all<WebhookEndpointRow>();
	return (rs.results ?? []).map(toWebhookEndpoint);
};

export const getWebhookEndpoint = async (
	db: D1Database,
	id: string,
): Promise<WebhookEndpoint | null> => {
	const row = await db
		.prepare(
			`SELECT id, url, secret, events, adapter, enabled, fail_count,
			        disabled_at, created_at, updated_at
			   FROM webhook_endpoints WHERE id = ?`,
		)
		.bind(id)
		.first<WebhookEndpointRow>();
	return row ? toWebhookEndpoint(row) : null;
};

export type WebhookEndpointInput = {
	url: string;
	secret: string | null;
	events: string[] | null;
	adapter: WebhookAdapter;
	enabled: boolean;
};

const serializeEvents = (events: string[] | null): string | null =>
	events == null || events.length === 0 ? null : events.join(",");

export const createWebhookEndpoint = async (
	db: D1Database,
	input: WebhookEndpointInput,
): Promise<WebhookEndpoint> => {
	const id = ulid();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO webhook_endpoints
			   (id, url, secret, events, adapter, enabled, fail_count,
			    disabled_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
		)
		.bind(
			id,
			input.url,
			input.secret,
			serializeEvents(input.events),
			input.adapter,
			input.enabled ? 1 : 0,
			now,
			now,
		)
		.run();
	const created = await getWebhookEndpoint(db, id);
	if (!created) throw new Error("webhook endpoint vanished after insert");
	return created;
};

export const updateWebhookEndpoint = async (
	db: D1Database,
	id: string,
	input: Partial<WebhookEndpointInput>,
): Promise<void> => {
	// Build the SET clause dynamically so callers can patch one field
	// (e.g. just enabled, just secret) without overwriting siblings.
	const sets: string[] = ["updated_at = ?"];
	const values: (string | number | null)[] = [Date.now()];
	if (input.url !== undefined) {
		sets.push("url = ?");
		values.push(input.url);
	}
	if (input.secret !== undefined) {
		sets.push("secret = ?");
		values.push(input.secret);
	}
	if (input.events !== undefined) {
		sets.push("events = ?");
		values.push(serializeEvents(input.events));
	}
	if (input.adapter !== undefined) {
		sets.push("adapter = ?");
		values.push(input.adapter);
	}
	if (input.enabled !== undefined) {
		sets.push("enabled = ?");
		values.push(input.enabled ? 1 : 0);
		// Re-enabling clears the auto-disable marker + counter so the next
		// failure cycle starts fresh, not from wherever it was paused.
		if (input.enabled) {
			sets.push("disabled_at = NULL");
			sets.push("fail_count = 0");
		}
	}
	values.push(id);
	await db
		.prepare(`UPDATE webhook_endpoints SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...values)
		.run();
};

export const deleteWebhookEndpoint = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	// ON DELETE CASCADE on webhook_deliveries.endpoint_id wipes the queue.
	await db
		.prepare(`DELETE FROM webhook_endpoints WHERE id = ?`)
		.bind(id)
		.run();
};

export const incrementWebhookFailCount = async (
	db: D1Database,
	id: string,
	autoDisableAt: number | null,
): Promise<void> => {
	await db
		.prepare(
			`UPDATE webhook_endpoints
			    SET fail_count = fail_count + 1,
			        disabled_at = COALESCE(disabled_at, ?),
			        enabled = CASE WHEN ? IS NULL THEN enabled ELSE 0 END,
			        updated_at = ?
			  WHERE id = ?`,
		)
		.bind(autoDisableAt, autoDisableAt, Date.now(), id)
		.run();
};

export const resetWebhookFailCount = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	await db
		.prepare(
			`UPDATE webhook_endpoints
			    SET fail_count = 0, disabled_at = NULL, updated_at = ?
			  WHERE id = ?`,
		)
		.bind(Date.now(), id)
		.run();
};

export type WebhookDeliveryStatus = "pending" | "delivered" | "giveup";

export type WebhookDelivery = {
	id: string;
	endpoint_id: string;
	event: string;
	payload: string;
	status: WebhookDeliveryStatus;
	attempts: number;
	last_error: string | null;
	next_attempt_at: number;
	created_at: number;
	delivered_at: number | null;
};

type WebhookDeliveryRow = Omit<WebhookDelivery, "status"> & { status: string };

const toWebhookDelivery = (row: WebhookDeliveryRow): WebhookDelivery => {
	const status: WebhookDeliveryStatus =
		row.status === "delivered" || row.status === "giveup"
			? row.status
			: "pending";
	return { ...row, status };
};

export const enqueueWebhookDelivery = async (
	db: D1Database,
	endpoint_id: string,
	event: string,
	payload: string,
	next_attempt_at: number,
): Promise<string> => {
	const id = ulid();
	await db
		.prepare(
			`INSERT INTO webhook_deliveries
			   (id, endpoint_id, event, payload, status, attempts,
			    last_error, next_attempt_at, created_at, delivered_at)
			 VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)`,
		)
		.bind(id, endpoint_id, event, payload, next_attempt_at, Date.now())
		.run();
	return id;
};

export const listPendingWebhookDeliveries = async (
	db: D1Database,
	now: number,
	limit: number,
): Promise<WebhookDelivery[]> => {
	const rs = await db
		.prepare(
			`SELECT id, endpoint_id, event, payload, status, attempts,
			        last_error, next_attempt_at, created_at, delivered_at
			   FROM webhook_deliveries
			  WHERE status = 'pending' AND next_attempt_at <= ?
			  ORDER BY next_attempt_at ASC
			  LIMIT ?`,
		)
		.bind(now, limit)
		.all<WebhookDeliveryRow>();
	return (rs.results ?? []).map(toWebhookDelivery);
};

export const markWebhookDelivered = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	await db
		.prepare(
			`UPDATE webhook_deliveries
			    SET status = 'delivered',
			        attempts = attempts + 1,
			        delivered_at = ?,
			        last_error = NULL
			  WHERE id = ?`,
		)
		.bind(Date.now(), id)
		.run();
};

export const markWebhookFailed = async (
	db: D1Database,
	id: string,
	next_attempt_at: number | null, // null → giveup
	last_error: string,
): Promise<void> => {
	const status = next_attempt_at == null ? "giveup" : "pending";
	const nextTs = next_attempt_at ?? 0;
	await db
		.prepare(
			`UPDATE webhook_deliveries
			    SET status = ?,
			        attempts = attempts + 1,
			        last_error = ?,
			        next_attempt_at = ?
			  WHERE id = ?`,
		)
		.bind(status, last_error, nextTs, id)
		.run();
};

export const pruneWebhookDeliveries = async (
	db: D1Database,
	olderThan: number,
): Promise<number> => {
	// Keep the deliveries table from growing unbounded — delivered + giveup
	// rows older than the threshold are removed. Pending rows are always
	// kept so a long backoff schedule can't be silently dropped.
	const rs = await db
		.prepare(
			`DELETE FROM webhook_deliveries
			  WHERE status IN ('delivered', 'giveup')
			    AND created_at < ?`,
		)
		.bind(olderThan)
		.run();
	return (rs.meta as { changes?: number }).changes ?? 0;
};

// -- votes -------------------------------------------------------------------
//
// Voting is exclusive: at most one row per (comment_id, user_id) with value
// -1 or 1. The reactions table is the wrong shape (multi-emoji per user)
// because a malicious client could send both up and down — see the
// votes migration for the full rationale.

export type Vote = {
	comment_id: string;
	user_id: string;
	value: -1 | 1;
	created_at: number;
};

export type VoteValue = -1 | 0 | 1;

export type VoteResult = {
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
};

const reselectScores = async (
	db: D1Database,
	comment_id: string,
	user_id: string,
): Promise<VoteResult> => {
	const row = await db
		.prepare(
			`SELECT c.score_up, c.score_down,
			        COALESCE((SELECT value FROM votes
			                   WHERE comment_id = c.id AND user_id = ?), 0) AS my_vote
			   FROM comments c WHERE c.id = ?`,
		)
		.bind(user_id, comment_id)
		.first<{ score_up: number; score_down: number; my_vote: number }>();
	if (!row) return { score_up: 0, score_down: 0, my_vote: 0 };
	const mv = row.my_vote === 1 || row.my_vote === -1 ? row.my_vote : 0;
	return { score_up: row.score_up, score_down: row.score_down, my_vote: mv };
};

/**
 * Atomically upsert a vote and recompute the denormalized counters on the
 * parent comment. value=0 means "clear my vote". The denormalization keeps
 * the public list query as a single SELECT against `comments` — no JOIN to
 * an aggregation against `votes` per page load.
 *
 * Returns the post-write counters and the requester's now-vote so the
 * widget can patch the DOM without busting the per-post tree cache.
 *
 * Perf note (issue #12): the two `(SELECT COUNT(*) …)` subqueries scan
 * the comment's full vote set on every cast — a PK-index range scan on
 * comment_id plus a row fetch per vote to read `value`, so O(N) per
 * write. That's deliberate:
 * recomputing from the source of truth means the denormalized counters
 * can never drift, and there's no read-modify-write race surface like
 * delta updates (`score_up = score_up + ?`) would introduce. For the
 * target audience (small self-hosted instances) N stays in the hundreds
 * and this is noise. It would only matter under brigade load — thousands
 * of votes/min serializing on ONE hot comment — at which point switch to
 * deltas computed from the prior vote value read inside the batch.
 */
export const castVote = async (
	db: D1Database,
	comment_id: string,
	user_id: string,
	value: VoteValue,
): Promise<VoteResult> => {
	const now = Date.now();
	if (value === 0) {
		await db.batch([
			db
				.prepare(`DELETE FROM votes WHERE comment_id = ? AND user_id = ?`)
				.bind(comment_id, user_id),
			db
				.prepare(
					`UPDATE comments SET
					   score_up   = (SELECT COUNT(*) FROM votes WHERE comment_id = ? AND value =  1),
					   score_down = (SELECT COUNT(*) FROM votes WHERE comment_id = ? AND value = -1)
					 WHERE id = ?`,
				)
				.bind(comment_id, comment_id, comment_id),
		]);
	} else {
		await db.batch([
			db
				.prepare(
					`INSERT INTO votes (comment_id, user_id, value, created_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(comment_id, user_id) DO UPDATE SET
					   value      = excluded.value,
					   created_at = excluded.created_at`,
				)
				.bind(comment_id, user_id, value, now),
			db
				.prepare(
					`UPDATE comments SET
					   score_up   = (SELECT COUNT(*) FROM votes WHERE comment_id = ? AND value =  1),
					   score_down = (SELECT COUNT(*) FROM votes WHERE comment_id = ? AND value = -1)
					 WHERE id = ?`,
				)
				.bind(comment_id, comment_id, comment_id),
		]);
	}
	return reselectScores(db, comment_id, user_id);
};

/**
 * Returns the calling user's vote on each (comment_id) for one post, as
 * a Map keyed by comment_id. Used to populate `my_vote` on the public
 * list endpoint for authenticated viewers; anonymous viewers bypass this
 * (the cached payload has no my_vote field).
 */
export const getUserVotesOnPost = async (
	db: D1Database,
	post_slug: string,
	user_id: string,
): Promise<Map<string, -1 | 1>> => {
	const result = await db
		.prepare(
			`SELECT v.comment_id, v.value
			   FROM votes v
			   JOIN comments c ON c.id = v.comment_id
			  WHERE c.post_slug = ? AND v.user_id = ?`,
		)
		.bind(post_slug, user_id)
		.all<{ comment_id: string; value: number }>();
	const out = new Map<string, -1 | 1>();
	for (const r of result.results ?? []) {
		if (r.value === 1 || r.value === -1) out.set(r.comment_id, r.value);
	}
	return out;
};

// -- saved replies ----------------------------------------------------------
//
// Canned moderator responses. The picker fetches the visible-to-me set
// (`listSavedRepliesForUser`) which is `OWNER = me OR scope = 'shared'`.
// Mutations are owner-only: even an admin should not be able to silently
// edit a different mod's private reply through the API (we audit-log the
// post action separately).

export type SavedReplyScope = "private" | "shared";

export type SavedReply = {
	id: string;
	owner_id: string;
	title: string;
	body_md: string;
	scope: SavedReplyScope;
	created_at: number;
	updated_at: number;
};

export const isSavedReplyScope = (v: unknown): v is SavedReplyScope =>
	v === "private" || v === "shared";

export const listSavedRepliesForUser = async (
	db: D1Database,
	user_id: string,
): Promise<SavedReply[]> => {
	const result = await db
		.prepare(
			`SELECT id, owner_id, title, body_md, scope, created_at, updated_at
			   FROM saved_replies
			  WHERE owner_id = ? OR scope = 'shared'
			  ORDER BY created_at DESC`,
		)
		.bind(user_id)
		.all<SavedReply>();
	return result.results ?? [];
};

export const getSavedReply = async (
	db: D1Database,
	id: string,
): Promise<SavedReply | null> => {
	return await db
		.prepare(
			`SELECT id, owner_id, title, body_md, scope, created_at, updated_at
			   FROM saved_replies WHERE id = ?`,
		)
		.bind(id)
		.first<SavedReply>();
};

export const insertSavedReply = async (
	db: D1Database,
	input: {
		owner_id: string;
		title: string;
		body_md: string;
		scope: SavedReplyScope;
	},
): Promise<SavedReply> => {
	const id = ulid();
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO saved_replies
			   (id, owner_id, title, body_md, scope, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, input.owner_id, input.title, input.body_md, input.scope, now, now)
		.run();
	return {
		id,
		owner_id: input.owner_id,
		title: input.title,
		body_md: input.body_md,
		scope: input.scope,
		created_at: now,
		updated_at: now,
	};
};

export const updateSavedReply = async (
	db: D1Database,
	id: string,
	owner_id: string,
	patch: { title: string; body_md: string; scope: SavedReplyScope },
): Promise<boolean> => {
	const now = Date.now();
	const result = await db
		.prepare(
			`UPDATE saved_replies
			    SET title = ?, body_md = ?, scope = ?, updated_at = ?
			  WHERE id = ? AND owner_id = ?`,
		)
		.bind(patch.title, patch.body_md, patch.scope, now, id, owner_id)
		.run();
	return (result.meta?.changes ?? 0) > 0;
};

export const deleteSavedReply = async (
	db: D1Database,
	id: string,
	owner_id: string,
): Promise<boolean> => {
	const result = await db
		.prepare(`DELETE FROM saved_replies WHERE id = ? AND owner_id = ?`)
		.bind(id, owner_id)
		.run();
	return (result.meta?.changes ?? 0) > 0;
};
