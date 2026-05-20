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

export type Post = {
	slug: string;
	title: string | null;
	url: string | null;
	created_at: number;
};

export type User = {
	id: string;
	provider: string;
	provider_id: string | null;
	name: string;
	email: string | null;
	avatar_url: string | null;
	is_admin: boolean;
	is_banned: boolean;
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
	ip_hash: string | null;
	user_agent: string | null;
	created_at: number;
};

type UserRow = Omit<User, "is_admin" | "is_banned"> & {
	is_admin: number;
	is_banned: number;
};

const toUser = (row: UserRow): User => ({
	...row,
	is_admin: row.is_admin === 1,
	is_banned: row.is_banned === 1,
});

export const upsertPost = async (
	db: D1Database,
	slug: string,
	title: string | null,
	url: string | null,
): Promise<Post> => {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO posts (slug, title, url, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(slug) DO UPDATE SET
			   title = COALESCE(excluded.title, posts.title),
			   url   = COALESCE(excluded.url,   posts.url)`,
		)
		.bind(slug, title, url, now)
		.run();
	const row = await db
		.prepare(`SELECT slug, title, url, created_at FROM posts WHERE slug = ?`)
		.bind(slug)
		.first<Post>();
	if (!row) throw new Error("upsertPost: post not found after insert");
	return row;
};

export const getPost = async (
	db: D1Database,
	slug: string,
): Promise<Post | null> => {
	return await db
		.prepare(`SELECT slug, title, url, created_at FROM posts WHERE slug = ?`)
		.bind(slug)
		.first<Post>();
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
			        is_admin, is_banned, created_at
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
			        is_admin, is_banned, created_at
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
	await db
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email,
			                    avatar_url, is_admin, is_banned, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		)
		.bind(id, provider, provider_id, name, email, avatar_url, is_admin, now)
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
			        is_admin, is_banned, created_at
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
			   renderer_version, status, edited_at, deleted_at,
			   ip_hash, user_agent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
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
		ip_hash: input.ip_hash,
		user_agent: input.user_agent,
		created_at: now,
	};
};

export const getComment = async (
	db: D1Database,
	id: string,
): Promise<Comment | null> => {
	return await db
		.prepare(
			`SELECT id, post_slug, parent_id, user_id, body_md, body_html,
			        renderer_version, status, edited_at, deleted_at,
			        ip_hash, user_agent, created_at
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
			        renderer_version, status, edited_at, deleted_at,
			        ip_hash, user_agent, created_at
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
			        is_admin, is_banned, created_at
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
			        renderer_version, status, edited_at, deleted_at,
			        ip_hash, user_agent, created_at
			 FROM comments
			 WHERE post_slug = ? AND status NOT IN ('spam', 'pending')
			 ORDER BY created_at ASC, id ASC`,
		)
		.bind(post_slug)
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
			        c.renderer_version, c.status, c.edited_at, c.deleted_at,
			        c.ip_hash, c.user_agent, c.created_at, u.name AS author_name
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

/**
 * Admin: page through comments by status, newest first. Cursor is the
 * created_at,id pair of the last row from the previous page.
 */
export const adminListComments = async (
	db: D1Database,
	status: CommentStatus | "all",
	limit: number,
	cursorCreatedAt: number | null,
	cursorId: string | null,
): Promise<Comment[]> => {
	const statusFilter = status === "all" ? "" : "AND status = ?";
	const sql = cursorCreatedAt != null && cursorId != null
		? `SELECT id, post_slug, parent_id, user_id, body_md, body_html,
		          renderer_version, status, edited_at, deleted_at,
		          ip_hash, user_agent, created_at
		     FROM comments
		    WHERE (created_at, id) < (?, ?) ${statusFilter}
		    ORDER BY created_at DESC, id DESC
		    LIMIT ?`
		: `SELECT id, post_slug, parent_id, user_id, body_md, body_html,
		          renderer_version, status, edited_at, deleted_at,
		          ip_hash, user_agent, created_at
		     FROM comments
		    WHERE 1=1 ${statusFilter}
		    ORDER BY created_at DESC, id DESC
		    LIMIT ?`;
	const stmt = db.prepare(sql);
	const binds: (number | string)[] =
		cursorCreatedAt != null && cursorId != null
			? status === "all"
				? [cursorCreatedAt, cursorId, limit]
				: [cursorCreatedAt, cursorId, status, limit]
			: status === "all"
				? [limit]
				: [status, limit];
	const result = await stmt.bind(...binds).all<Comment>();
	return result.results ?? [];
};

export const updateCommentStatus = async (
	db: D1Database,
	id: string,
	status: CommentStatus,
): Promise<void> => {
	const now = Date.now();
	// deleted_at is set when transitioning to 'deleted', cleared otherwise.
	const deletedAt = status === "deleted" ? now : null;
	await db
		.prepare(
			`UPDATE comments
			    SET status = ?, deleted_at = ?
			  WHERE id = ?`,
		)
		.bind(status, deletedAt, id)
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
	const pattern = search ? `${search.toLowerCase()}%` : null;
	const filter = pattern ? "AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)" : "";
	const sql = cursorCreatedAt != null && cursorId != null
		? `SELECT id, provider, provider_id, name, email, avatar_url,
		          is_admin, is_banned, created_at
		     FROM users
		    WHERE (created_at, id) < (?, ?) ${filter}
		    ORDER BY created_at DESC, id DESC
		    LIMIT ?`
		: `SELECT id, provider, provider_id, name, email, avatar_url,
		          is_admin, is_banned, created_at
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
	await db
		.prepare(
			`UPDATE comments
			    SET status = 'deleted', deleted_at = ?
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

export const confirmSubscription = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE subscriptions
			    SET confirmed_at = ?, confirm_token = NULL
			  WHERE id = ?`,
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
