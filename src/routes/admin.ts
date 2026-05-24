/**
 * Admin UI (HTML pages) + JSON action endpoints.
 *
 * Layout:
 *   GET  /admin                  → dashboard with stats + nav
 *   GET  /admin/queue?status=…   → comment moderation list
 *   GET  /admin/users?q=…        → user list with ban toggle
 *   GET  /admin/settings         → read-only env summary
 *   POST /admin/api/comments/:id { action: approve|spam|delete|restore }
 *   POST /admin/api/users/:id    { banned: true|false }
 *
 * Auth: session cookie + is_admin=true. Anything else → 403 (or 401 if
 * no session). Action POSTs go through the same Origin-header CSRF
 * middleware as the public API.
 *
 * Rendering lives in src/admin-ui/ — this file is the routing layer only.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Bindings } from "../index";
import { readSession } from "../lib/session";
import {
	adminBulkUpdateCommentStatus,
	adminListComments,
	adminListUsers,
	adminStats,
	getComment,
	getUser,
	setUserBanned,
	updateCommentStatus,
	type CommentStatus,
	type User,
} from "../db/queries";
import { fireWebhook, type WebhookEvent } from "../lib/webhook";
import {
	peekCachedLatestVersion,
	versionCheckMiddleware,
} from "../lib/version-check";
import { accessDeniedHtml, layout } from "../admin-ui/layout";
import { ADMIN_CSP } from "../admin-ui/styles";
import { renderDashboard } from "../admin-ui/pages/dashboard";
import { renderQueue, type QueueFilters } from "../admin-ui/pages/queue";
import { renderUsers } from "../admin-ui/pages/users";
import { renderSettings } from "../admin-ui/pages/settings";

const admin = new Hono<{ Bindings: Bindings }>();

type Ctx = Context<{ Bindings: Bindings }>;

const wantsHtml = (c: Ctx): boolean => {
	const accept = c.req.header("accept") ?? "";
	return accept.includes("text/html");
};

const requireAdmin = async (c: Ctx): Promise<User | Response> => {
	const session = await readSession(c);
	if (!session) {
		if (wantsHtml(c)) {
			return c.html(
				accessDeniedHtml(401, "You need to sign in to access the admin area."),
				401,
			);
		}
		return c.json({ error: "not_authenticated" }, 401);
	}
	const user = await getUser(c.env.DB, session.user_id);
	if (!user || !user.is_admin) {
		if (wantsHtml(c)) {
			return c.html(
				accessDeniedHtml(403, "Your account is not an admin on this instance."),
				403,
			);
		}
		return c.json({ error: "not_authorized" }, 403);
	}
	return user;
};

admin.use("*", async (c, next) => {
	c.header("content-security-policy", ADMIN_CSP);
	c.header("x-content-type-options", "nosniff");
	c.header("referrer-policy", "no-referrer");
	c.header("x-frame-options", "DENY");

	// Same-origin CSRF defense for admin POSTs. The Origin header on
	// admin actions must match the request URL's origin — there is no
	// legitimate cross-origin admin client.
	const method = c.req.method;
	if (method === "POST" || method === "PATCH" || method === "DELETE") {
		const origin = c.req.header("origin");
		const reqUrl = new URL(c.req.url);
		if (!origin || origin !== `${reqUrl.protocol}//${reqUrl.host}`) {
			return c.json({ error: "origin_mismatch" }, 403);
		}
	}
	await next();
});

admin.use("*", versionCheckMiddleware());

admin.get("/", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const stats = await adminStats(c.env.DB);
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(layout("Dashboard", renderDashboard(stats, c.env), user, updateInfo));
});

// Parse a YYYY-MM-DD string into a ms-epoch timestamp at the start of UTC day.
// Returns null on any malformed input.
const parseDateMs = (raw: string | undefined): number | null => {
	if (!raw) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
	const ms = Date.parse(`${raw}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : null;
};

admin.get("/queue", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const statusParam = c.req.query("status") ?? "pending";
	const status: CommentStatus | "all" =
		statusParam === "approved" ||
		statusParam === "pending" ||
		statusParam === "spam" ||
		statusParam === "deleted"
			? statusParam
			: "all";

	const q = (c.req.query("q") ?? "").trim();
	const postSlug = (c.req.query("post_slug") ?? "").trim();
	const userId = (c.req.query("user_id") ?? "").trim();
	const fromRaw = c.req.query("from");
	const toRaw = c.req.query("to");
	const fromMs = parseDateMs(fromRaw);
	// "to" is inclusive in the UI but the SQL uses < — push it forward 24h.
	const toMs = parseDateMs(toRaw);
	const toExclusive = toMs != null ? toMs + 86_400_000 : null;

	const before = c.req.query("before");
	let cursorTs: number | null = null;
	let cursorId: string | null = null;
	if (before) {
		const parts = before.split("|");
		const a = parts[0];
		const b = parts[1];
		if (parts.length === 2 && a && b) {
			const ts = Number(a);
			if (Number.isFinite(ts)) {
				cursorTs = ts;
				cursorId = b;
			}
		}
	}

	const filter: import("../db/queries").AdminCommentFilter = { status };
	if (q) filter.q = q;
	if (postSlug) filter.post_slug = postSlug;
	if (userId) filter.user_id = userId;
	if (fromMs != null) filter.from = fromMs;
	if (toExclusive != null) filter.to = toExclusive;

	const rows = await adminListComments(c.env.DB, filter, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;

	const updateInfo = await peekCachedLatestVersion(c.env);
	const filters: QueueFilters = {
		status,
		q,
		post_slug: postSlug,
		user_id: userId,
		from: fromRaw ?? "",
		to: toRaw ?? "",
	};
	return c.html(
		layout("Queue", renderQueue(trimmed, filters, nextCursor), user, updateInfo),
	);
});

admin.get("/users", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const q = (c.req.query("q") ?? "").trim();
	const before = c.req.query("before");
	let cursorTs: number | null = null;
	let cursorId: string | null = null;
	if (before) {
		const parts = before.split("|");
		const a = parts[0];
		const b = parts[1];
		if (parts.length === 2 && a && b) {
			const ts = Number(a);
			if (Number.isFinite(ts)) {
				cursorTs = ts;
				cursorId = b;
			}
		}
	}
	const rows = await adminListUsers(c.env.DB, q || null, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		layout("Users", renderUsers(trimmed, q, nextCursor), user, updateInfo),
	);
});

admin.get("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(layout("Settings", renderSettings(c.env), user, updateInfo));
});

type CommentAction = "approve" | "spam" | "delete" | "restore";

admin.post("/api/comments/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req.json<{ action?: string }>().catch(() => null);
	const action = body?.action as CommentAction | undefined;
	let newStatus: CommentStatus;
	switch (action) {
		case "approve":
			newStatus = "approved";
			break;
		case "spam":
			newStatus = "spam";
			break;
		case "delete":
			newStatus = "deleted";
			break;
		case "restore":
			newStatus = "approved";
			break;
		default:
			return c.json({ error: "invalid_action" }, 400);
	}
	const existing = await getComment(c.env.DB, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	await updateCommentStatus(c.env.DB, id, newStatus);
	// Bust the cached first page so the moderation result is visible.
	await c.env.TREE_CACHE.delete(`tree:${existing.post_slug}:first`);
	const webhookEvent: WebhookEvent | null =
		newStatus === "approved"
			? "comment.approved"
			: newStatus === "spam"
				? "comment.spam"
				: newStatus === "deleted"
					? "comment.deleted"
					: null;
	if (webhookEvent) {
		fireWebhook(c.env, c.executionCtx, {
			event: webhookEvent,
			comment_id: id,
			post_slug: existing.post_slug,
			user_id: existing.user_id,
			ts: Date.now(),
		});
	}
	return c.json({ ok: true, id, status: newStatus });
});

const BULK_ACTION_LIMIT = 100;

admin.post("/api/comments/bulk", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req
		.json<{ ids?: unknown; action?: string }>()
		.catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const action = body.action as CommentAction | undefined;
	let newStatus: CommentStatus;
	switch (action) {
		case "approve":
		case "restore":
			newStatus = "approved";
			break;
		case "spam":
			newStatus = "spam";
			break;
		case "delete":
			newStatus = "deleted";
			break;
		default:
			return c.json({ error: "invalid_action" }, 400);
	}
	if (!Array.isArray(body.ids)) {
		return c.json({ error: "invalid_ids" }, 400);
	}
	const ids = (body.ids as unknown[]).filter(
		(x): x is string => typeof x === "string" && x.length > 0,
	);
	if (ids.length === 0) return c.json({ error: "empty_ids" }, 400);
	if (ids.length > BULK_ACTION_LIMIT) {
		return c.json({ error: "too_many" }, 400);
	}
	const touched = await adminBulkUpdateCommentStatus(c.env.DB, ids, newStatus);
	// Bust caches + fire webhooks for each touched comment. Both are
	// independent of one another, so missing rows just no-op.
	const webhookEvent: WebhookEvent | null =
		newStatus === "approved"
			? "comment.approved"
			: newStatus === "spam"
				? "comment.spam"
				: newStatus === "deleted"
					? "comment.deleted"
					: null;
	for (const id of touched) {
		const existing = await getComment(c.env.DB, id);
		if (!existing) continue;
		await c.env.TREE_CACHE.delete(`tree:${existing.post_slug}:first`);
		if (webhookEvent) {
			fireWebhook(c.env, c.executionCtx, {
				event: webhookEvent,
				comment_id: id,
				post_slug: existing.post_slug,
				user_id: existing.user_id,
				ts: Date.now(),
			});
		}
	}
	return c.json({ ok: true, status: newStatus, touched });
});

admin.post("/api/users/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req.json<{ banned?: boolean }>().catch(() => null);
	if (!body || typeof body.banned !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	// Without this, setUserBanned silently no-ops on a bogus id and the
	// endpoint returns ok — masking a typo or stale UI from the admin.
	const target = await getUser(c.env.DB, id);
	if (!target) return c.json({ error: "not_found" }, 404);
	await setUserBanned(c.env.DB, id, body.banned);
	return c.json({ ok: true, id, banned: body.banned });
});

export { admin };
