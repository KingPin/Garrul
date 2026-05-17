/**
 * /api/v1/comments — anonymous comment CRUD.
 *
 * M2 scope: anonymous-only path. OAuth (M5) will add a branch that skips
 * Turnstile + uses the session user_id instead of a ghost user.
 *
 * Routes:
 *   POST   /api/v1/comments              create
 *   GET    /api/v1/comments?slug=<slug>  list (flat; tree assembled M4)
 *   PATCH  /api/v1/comments/:id          edit (within EDIT_WINDOW_MINUTES)
 *   DELETE /api/v1/comments/:id          soft-delete
 *
 * Auth:
 *   - Anonymous identity = ghost user keyed on hashed-IP (lib/db/queries.ts).
 *   - Session cookie holds user_id; cookie ⇒ KV-resolved ⇒ user_id check.
 *   - Anonymous POST requires Turnstile; rate-limited per-IP-hash.
 *
 * Body is sanitized to HTML and stored alongside the raw markdown so the
 * sanitizer can be re-run via scripts/rerender.ts (renderer_version bump).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	getOrCreateGhost,
	getComment,
	getPost,
	insertComment,
	listCommentsForPost,
	softDeleteComment,
	updateCommentBody,
	upsertPost,
	type Comment,
	type User,
} from "../db/queries";
import { identiconSvg } from "../lib/identicon";
import { clientIp, hashIp } from "../lib/ip-hash";
import { CURRENT_RENDERER_VERSION, renderMarkdown, validateBody } from "../lib/markdown";
import { checkRateLimit } from "../lib/ratelimit";
import { readSession } from "../lib/session";
import { verifyTurnstile } from "../lib/turnstile";
import { t } from "../i18n";

type SessionVars = {
	userId: string | null;
	sessionId: string | null;
};

// D1 stores booleans as 0/1 INTEGER; we widen to a row type for `.first<…>()`
// and `.all<…>()` callsites that hit the users table directly, then convert
// at the boundary. (db/queries.ts has its own copy for its internal use.)
type UserRow = Omit<User, "is_admin" | "is_banned"> & {
	is_admin: number;
	is_banned: number;
};

const rowToUser = (row: UserRow): User => ({
	...row,
	is_admin: row.is_admin === 1,
	is_banned: row.is_banned === 1,
});

const comments = new Hono<{ Bindings: Bindings; Variables: SessionVars }>();

const MAX_NAME = 40;
const SLUG_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;
const HONEYPOT_FIELD = "website";

type CreateBody = {
	slug?: string;
	parent_id?: string | null;
	name?: string;
	body?: string;
	turnstile_token?: string;
	post_title?: string | null;
	post_url?: string | null;
	[HONEYPOT_FIELD]?: string;
};

const editWindowMs = (env: Bindings): number => {
	const minutes = Number.parseInt(env.EDIT_WINDOW_MINUTES, 10);
	return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 5 * 60_000;
};

const validName = (raw: string | undefined): { ok: true; name: string } | { ok: false; key: "err.name.required" | "err.name.too_long"; max?: number } => {
	const name = (raw ?? "").trim();
	if (!name) return { ok: false, key: "err.name.required" };
	if (name.length > MAX_NAME) return { ok: false, key: "err.name.too_long", max: MAX_NAME };
	return { ok: true, name };
};

const serializeComment = (c: Comment, author: User) => {
	const visible = c.status === "deleted";
	return {
		id: c.id,
		post_slug: c.post_slug,
		parent_id: c.parent_id,
		body_html: visible ? "" : c.body_html,
		status: c.status,
		edited_at: c.edited_at,
		deleted_at: c.deleted_at,
		created_at: c.created_at,
		author: {
			id: author.id,
			name: author.name,
			provider: author.provider,
			is_admin: author.is_admin,
			avatar_svg: author.avatar_url ? null : identiconSvg(author.id),
			avatar_url: author.avatar_url,
		},
	};
};

comments.post("/", async (c) => {
	const body = await c.req.json<CreateBody>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);

	if (body[HONEYPOT_FIELD]) {
		return c.json({ error: t("err.honeypot") }, 400);
	}

	const slug = (body.slug ?? "").trim();
	if (!slug) return c.json({ error: t("err.post.required") }, 400);
	if (!SLUG_RE.test(slug)) return c.json({ error: t("err.post.invalid") }, 400);

	const bodyCheck = validateBody(body.body ?? "");
	if (!bodyCheck.ok) {
		const args = bodyCheck.max != null ? { max: bodyCheck.max } : undefined;
		return c.json({ error: t(bodyCheck.key, args) }, 400);
	}

	const session = await readSession(c);

	// Anonymous path: name + Turnstile + rate-limit required.
	let author: User;
	const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_HASH_SECRET);

	if (!session) {
		const nameCheck = validName(body.name);
		if (!nameCheck.ok) {
			const args = nameCheck.max != null ? { max: nameCheck.max } : undefined;
			return c.json({ error: t(nameCheck.key, args) }, 400);
		}

		if (!body.turnstile_token) {
			return c.json({ error: t("err.turnstile.required") }, 400);
		}
		const ts = await verifyTurnstile(
			body.turnstile_token,
			c.env.TURNSTILE_SECRET,
			clientIp(c.req.raw),
		);
		if (!ts) return c.json({ error: t("err.turnstile.invalid") }, 400);

		const rl = await checkRateLimit(c.env, ipHash);
		if (!rl.ok) return c.json({ error: t("err.ratelimit") }, 429);

		author = await getOrCreateGhost(c.env.DB, ipHash, nameCheck.name);
		if (author.is_banned) return c.json({ error: t("err.banned") }, 403);
	} else {
		const u = await c.env.DB
			.prepare(
				`SELECT id, provider, provider_id, name, email, avatar_url,
				        is_admin, is_banned, created_at
				 FROM users WHERE id = ?`,
			)
			.bind(session.user_id)
			.first<UserRow>();
		if (!u) return c.json({ error: t("err.session.expired") }, 401);
		author = rowToUser(u);
		if (author.is_banned) return c.json({ error: t("err.banned") }, 403);
	}

	// Make sure the post row exists so the FK on comments resolves.
	await upsertPost(c.env.DB, slug, body.post_title ?? null, body.post_url ?? null);

	// Parent must exist and live on the same post.
	let parent_id: string | null = null;
	if (body.parent_id) {
		const parent = await getComment(c.env.DB, body.parent_id);
		if (!parent) return c.json({ error: t("err.parent.not_found") }, 400);
		if (parent.post_slug !== slug) {
			return c.json({ error: t("err.parent.different_post") }, 400);
		}
		parent_id = parent.id;
	}

	const body_html = renderMarkdown(bodyCheck.body);
	const inserted = await insertComment(c.env.DB, {
		post_slug: slug,
		parent_id,
		user_id: author.id,
		body_md: bodyCheck.body,
		body_html,
		renderer_version: CURRENT_RENDERER_VERSION,
		ip_hash: ipHash,
		user_agent: c.req.header("user-agent") ?? null,
	});

	// Bust tree cache (M4 will populate). We delete unconditionally so the
	// cache layer doesn't need to know about insert paths.
	await c.env.TREE_CACHE.delete(`tree:${slug}`);

	return c.json({ comment: serializeComment(inserted, author) }, 201);
});

comments.get("/", async (c) => {
	const slug = (c.req.query("slug") ?? "").trim();
	if (!slug) return c.json({ error: t("err.post.required") }, 400);
	if (!SLUG_RE.test(slug)) return c.json({ error: t("err.post.invalid") }, 400);

	const post = await getPost(c.env.DB, slug);
	const rows = await listCommentsForPost(c.env.DB, slug);

	if (rows.length === 0) {
		return c.json({ post, comments: [] });
	}

	// Batch-load all referenced authors in one query.
	const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
	const placeholders = userIds.map(() => "?").join(",");
	const authorRows = await c.env.DB
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, created_at
			 FROM users WHERE id IN (${placeholders})`,
		)
		.bind(...userIds)
		.all<UserRow>();
	const authorsById = new Map<string, User>();
	for (const u of authorRows.results ?? []) {
		authorsById.set(u.id, rowToUser(u));
	}

	const serialized = rows
		.map((r) => {
			const author = authorsById.get(r.user_id);
			if (!author) return null;
			return serializeComment(r, author);
		})
		.filter((x): x is NonNullable<typeof x> => x !== null);

	return c.json({ post, comments: serialized });
});

comments.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId || sessionUserId !== existing.user_id) {
		return c.json({ error: t("err.edit.not_author") }, 403);
	}

	if (Date.now() - existing.created_at > editWindowMs(c.env)) {
		return c.json({ error: t("err.edit.window_expired") }, 403);
	}

	const body = await c.req.json<{ body?: string }>().catch(() => null);
	if (!body) return c.json({ error: t("err.internal") }, 400);
	const bodyCheck = validateBody(body.body ?? "");
	if (!bodyCheck.ok) {
		const args = bodyCheck.max != null ? { max: bodyCheck.max } : undefined;
		return c.json({ error: t(bodyCheck.key, args) }, 400);
	}

	const body_html = renderMarkdown(bodyCheck.body);
	await updateCommentBody(
		c.env.DB,
		id,
		bodyCheck.body,
		body_html,
		CURRENT_RENDERER_VERSION,
	);
	await c.env.TREE_CACHE.delete(`tree:${existing.post_slug}`);
	const updated = await getComment(c.env.DB, id);
	if (!updated) return c.json({ error: t("err.internal") }, 500);
	const authorRow = await c.env.DB
		.prepare(
			`SELECT id, provider, provider_id, name, email, avatar_url,
			        is_admin, is_banned, created_at
			 FROM users WHERE id = ?`,
		)
		.bind(updated.user_id)
		.first<UserRow>();
	if (!authorRow) return c.json({ error: t("err.internal") }, 500);
	return c.json({ comment: serializeComment(updated, rowToUser(authorRow)) });
});

comments.delete("/:id", async (c) => {
	const id = c.req.param("id");
	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: t("err.not_found") }, 404);

	const session = await readSession(c);
	const sessionUserId = session?.user_id;
	if (!sessionUserId || sessionUserId !== existing.user_id) {
		return c.json({ error: t("err.delete.not_author") }, 403);
	}

	await softDeleteComment(c.env.DB, id);
	await c.env.TREE_CACHE.delete(`tree:${existing.post_slug}`);
	return c.json({ ok: true });
});

export { comments };
