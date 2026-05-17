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
 * Fetch all visible (non-spam, non-deleted-without-replies) comments for a
 * post. Caller assembles the tree; this just returns a flat ordered list.
 *
 * `deleted` comments ARE returned — the route layer replaces body_html with a
 * `[deleted]` placeholder iff the comment has surviving children, otherwise
 * filters it out entirely. Doing the visibility logic here would require an
 * extra query for child-existence per node.
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
			 WHERE post_slug = ? AND status != 'spam'
			 ORDER BY created_at ASC, id ASC`,
		)
		.bind(post_slug)
		.all<Comment>();
	return result.results ?? [];
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
