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
	ADMIN_ACTIONS,
	adminBulkUpdateCommentStatus,
	adminCommentsByHost,
	adminGetCommentDetail,
	adminGetUserDetail,
	adminInsertAudit,
	adminLatestAuditByTarget,
	adminGetSubscription,
	adminListAudit,
	adminListComments,
	adminListHosts,
	adminListSubscriptions,
	adminListUsers,
	adminOldestPending,
	adminRotateSubscriptionConfirmToken,
	adminSpamRate,
	adminStats,
	adminTimeline,
	adminTopCommenters,
	adminTopPosts,
	countAdmins,
	createWebhookEndpoint,
	deleteSettings,
	deleteWebhookEndpoint,
	getComment,
	getPost,
	getUser,
	getUsersByIds,
	getSavedReply,
	getWebhookEndpoint,
	insertComment,
	insertSavedReply,
	isSavedReplyScope,
	isUserRole,
	isWebhookAdapter,
	listSavedRepliesForUser,
	listWebhookEndpoints,
	markSubscriptionUnsubscribed,
	setSetting,
	setUserBanned,
	setUserRole,
	updateCommentStatus,
	updateSavedReply,
	deleteSavedReply,
	updateWebhookEndpoint,
	type AdminAction,
	type AuditTargetKind,
	type CommentStatus,
	type SavedReply,
	type SavedReplyScope,
	type User,
	type UserRole,
	type WebhookAdapter,
	type WebhookEndpoint,
} from "../db/queries";
import { fireWebhook, type WebhookEvent } from "../lib/webhook";
import { checkOutboundUrl } from "../lib/url-safety";
import {
	peekCachedLatestVersion,
	peekCachedRecentReleases,
	versionCheckMiddleware,
	type UpdateInfo,
} from "../lib/version-check";
import { accessDeniedHtml, layout } from "../admin-ui/layout";
import { ADMIN_CSP } from "../admin-ui/styles";
import { renderAbout } from "../admin-ui/pages/about";
import { renderDashboard } from "../admin-ui/pages/dashboard";
import { renderAudit, type AuditFilters } from "../admin-ui/pages/audit";
import { renderCommentDetail } from "../admin-ui/pages/comment-detail";
import { renderQueue, type QueueFilters } from "../admin-ui/pages/queue";
import {
	renderSavedRepliesList,
	renderSavedReplyForm,
} from "../admin-ui/pages/saved-replies";
import { renderUserDetail } from "../admin-ui/pages/user-detail";
import { renderUsers } from "../admin-ui/pages/users";
import { renderOperator } from "../admin-ui/pages/operator";
import { renderSettings } from "../admin-ui/pages/settings";
import {
	bustFlagsCache,
	bustNumbersCache,
	FLAG_KEYS,
	loadFlags,
	loadNumbers,
	NUMBER_KEYS,
	numberBounds,
} from "../lib/settings";
import { bustTreeCache } from "../lib/tree-cache";
import {
	renderWebhookForm,
	renderWebhooksList,
	type WebhookFormData,
} from "../admin-ui/pages/webhooks";
import {
	renderUsageDashboard,
	renderUsageSetup,
	renderUsageTokenError,
} from "../admin-ui/pages/usage";
import {
	fetchUsageSnapshot,
	isUsageConfigured,
	verifyToken,
} from "../lib/cf-usage";
import {
	renderSubscriptions,
	type SubscriptionsFilters,
} from "../admin-ui/pages/subscriptions";
import { CURRENT_RENDERER_VERSION, renderMarkdown } from "../lib/markdown";
import { MAX_XML_BYTES, runDisqusImport } from "../lib/disqus-import";
import { rerenderBatch, rerenderStats } from "../db/rerender";
import { runSeedDemo } from "../db/seed-demo";
import { renderConfirmEmailHtml } from "../lib/digest";
import { sendEmail } from "../lib/email";
import { t } from "../i18n";

const admin = new Hono<{ Bindings: Bindings }>();

type Ctx = Context<{ Bindings: Bindings }>;

const wantsHtml = (c: Ctx): boolean => {
	const accept = c.req.header("accept") ?? "";
	return accept.includes("text/html");
};

// Thin wrapper so every admin layout call computes the same env-derived
// nav opts (currently just whether the optional usage dashboard is wired
// up). Centralized so adding a future env-gated link doesn't require
// touching ~17 callsites.
const renderPage = (
	c: Ctx,
	title: string,
	body: string,
	user: User,
	updateInfo: UpdateInfo | null,
): string =>
	layout(title, body, user, updateInfo, {
		usage_link: isUsageConfigured(c.env),
		activePath: c.req.path,
	});

// Gate the admin-area pages and APIs. `level: "admin"` is the historical
// behavior — only users with role='admin' (equivalently is_admin=1) pass.
// `level: "mod"` is the new gate for moderation endpoints: role='mod' OR
// role='admin'. Banned users never pass either gate.
const requireRole = async (
	c: Ctx,
	level: "admin" | "mod",
): Promise<User | Response> => {
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
	const allowed =
		!!user &&
		!user.is_banned &&
		(level === "mod"
			? user.role === "mod" || user.role === "admin"
			: user.role === "admin");
	if (!allowed) {
		if (wantsHtml(c)) {
			return c.html(
				accessDeniedHtml(403, "Your account does not have access to this area."),
				403,
			);
		}
		return c.json({ error: "not_authorized" }, 403);
	}
	return user;
};

const requireAdmin = (c: Ctx): Promise<User | Response> =>
	requireRole(c, "admin");

const requireMod = (c: Ctx): Promise<User | Response> => requireRole(c, "mod");

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
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const db = c.env.DB;
	const [stats, timeline, topPosts, topCommenters, oldestPending, spamRate, byHost, updateInfo] =
		await Promise.all([
			adminStats(db),
			adminTimeline(db, 30),
			adminTopPosts(db, 30, 5),
			adminTopCommenters(db, 30, 5),
			adminOldestPending(db),
			adminSpamRate(db, 30),
			adminCommentsByHost(db),
			peekCachedLatestVersion(c.env),
		]);
	const body = renderDashboard(
		{
			stats,
			timeline,
			top_posts: topPosts,
			top_commenters: topCommenters,
			oldest_pending: oldestPending,
			spam_rate: spamRate,
			by_host: byHost,
		},
		c.env,
	);
	return c.html(renderPage(c, "Dashboard", body, user, updateInfo));
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
	const user = await requireMod(c);
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
	// DNS hostnames cap at 253 chars; anything longer is junk/noise — drop
	// silently rather than 4xx so a malformed bookmark just falls back to
	// "all domains".
	const hostRaw = (c.req.query("host") ?? "").trim();
	const host = hostRaw.length > 0 && hostRaw.length <= 253 ? hostRaw : "";

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
	if (host) filter.host = host;

	const rows = await adminListComments(c.env.DB, filter, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;

	const latestAudit = await adminLatestAuditByTarget(
		c.env.DB,
		"comment",
		trimmed.map((r) => r.id),
	);

	const hosts = await adminListHosts(c.env.DB);

	const updateInfo = await peekCachedLatestVersion(c.env);
	const filters: QueueFilters = {
		status,
		q,
		post_slug: postSlug,
		user_id: userId,
		from: fromRaw ?? "",
		to: toRaw ?? "",
		host,
	};
	return c.html(
		renderPage(c,
			"Queue",
			renderQueue(trimmed, filters, nextCursor, latestAudit, hosts),
			user,
			updateInfo,
		),
	);
});

admin.get("/comments/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const detail = await adminGetCommentDetail(c.env.DB, id);
	if (!detail) {
		return c.html(accessDeniedHtml(404, "That comment does not exist."), 404);
	}
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c, `Comment ${id.slice(0, 8)}`, renderCommentDetail(detail), user, updateInfo),
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
		renderPage(c, "Users", renderUsers(trimmed, q, nextCursor), user, updateInfo),
	);
});

const USER_DETAIL_LIMIT = 50;

admin.get("/users/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
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
	const detail = await adminGetUserDetail(
		c.env.DB,
		id,
		USER_DETAIL_LIMIT,
		cursorTs,
		cursorId,
	);
	if (!detail) {
		return c.html(accessDeniedHtml(404, "That user does not exist."), 404);
	}
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c, detail.user.name, renderUserDetail(detail, user), user, updateInfo),
	);
});

admin.get("/audit", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;

	const adminId = (c.req.query("admin_id") ?? "").trim();
	const actionRaw = (c.req.query("action") ?? "").trim();
	const targetKindRaw = (c.req.query("target_kind") ?? "").trim();
	const targetId = (c.req.query("target_id") ?? "").trim();
	const fromRaw = c.req.query("from");
	const toRaw = c.req.query("to");
	const fromMs = parseDateMs(fromRaw);
	const toMs = parseDateMs(toRaw);
	const toExclusive = toMs != null ? toMs + 86_400_000 : null;
	const hostRaw = (c.req.query("host") ?? "").trim();
	const host = hostRaw.length > 0 && hostRaw.length <= 253 ? hostRaw : "";

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

	const validKinds: AuditTargetKind[] = [
		"comment",
		"user",
		"subscription",
		"system",
	];
	const kindFilter: AuditTargetKind | undefined = validKinds.includes(
		targetKindRaw as AuditTargetKind,
	)
		? (targetKindRaw as AuditTargetKind)
		: undefined;
	const actionFilter: AdminAction | undefined = (
		ADMIN_ACTIONS as ReadonlyArray<string>
	).includes(actionRaw)
		? (actionRaw as AdminAction)
		: undefined;

	const filter: import("../db/queries").AdminAuditFilter = {};
	if (adminId) filter.admin_id = adminId;
	if (actionFilter) filter.action = actionFilter;
	if (kindFilter) filter.target_kind = kindFilter;
	if (targetId) filter.target_id = targetId;
	if (fromMs != null) filter.from = fromMs;
	if (toExclusive != null) filter.to = toExclusive;
	if (host) filter.host = host;

	const rows = await adminListAudit(c.env.DB, filter, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;

	const hosts = await adminListHosts(c.env.DB);

	const filters: AuditFilters = {
		admin_id: adminId,
		action: actionFilter ?? "",
		target_kind: kindFilter ?? "",
		target_id: targetId,
		from: fromRaw ?? "",
		to: toRaw ?? "",
		host,
	};
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c,
			"Audit",
			renderAudit(trimmed, filters, nextCursor, ADMIN_ACTIONS, hosts),
			user,
			updateInfo,
		),
	);
});

const parseTriState = (raw: string | undefined): "" | "yes" | "no" => {
	if (raw === "yes" || raw === "no") return raw;
	return "";
};

admin.get("/subscriptions", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const q = (c.req.query("q") ?? "").trim();
	const postSlug = (c.req.query("post_slug") ?? "").trim();
	const confirmed = parseTriState(c.req.query("confirmed"));
	const unsubscribed = parseTriState(c.req.query("unsubscribed"));
	const hostRaw = (c.req.query("host") ?? "").trim();
	const host = hostRaw.length > 0 && hostRaw.length <= 253 ? hostRaw : "";
	const before = c.req.query("before") ?? null;

	const filter: Parameters<typeof adminListSubscriptions>[1] = {};
	if (q) filter.q = q;
	if (postSlug) filter.post_slug = postSlug;
	if (confirmed === "yes") filter.confirmed = true;
	if (confirmed === "no") filter.confirmed = false;
	if (unsubscribed === "yes") filter.unsubscribed = true;
	if (unsubscribed === "no") filter.unsubscribed = false;
	if (host) filter.host = host;

	const limit = 50;
	let cursorCreatedAt: number | null = null;
	let cursorId: string | null = null;
	if (before) {
		const [tsStr, id] = before.split("|");
		const ts = Number(tsStr);
		if (Number.isFinite(ts) && id) {
			cursorCreatedAt = ts;
			cursorId = id;
		}
	}
	const rows = await adminListSubscriptions(
		c.env.DB,
		filter,
		limit + 1,
		cursorCreatedAt,
		cursorId,
	);
	let nextCursor: string | null = null;
	if (rows.length > limit) {
		const last = rows[limit - 1];
		if (last) nextCursor = `${last.created_at}|${last.id}`;
		rows.length = limit;
	}

	const filters: SubscriptionsFilters = {
		q,
		post_slug: postSlug,
		confirmed,
		unsubscribed,
		host,
	};
	const hosts = await adminListHosts(c.env.DB);
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c,
			"Subscriptions",
			renderSubscriptions(rows, filters, nextCursor, hosts),
			user,
			updateInfo,
		),
	);
});

// Default-deny: only allow seed-demo when ENV is explicitly "dev". A fresh
// deploy that forgot to set ENV=production would otherwise satisfy
// `env.ENV !== "production"` and let an admin seed demo content into a real
// instance. Matches the SameSite=Lax cookie fallback gate in lib/session.ts.
const isSeedDemoAllowed = (env: Bindings): boolean => env.ENV === "dev";

admin.get("/operator", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const stats = await rerenderStats(c.env.DB);
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c, 
			"Operator",
			renderOperator({
				rerender: stats,
				seed_demo_allowed: isSeedDemoAllowed(c.env),
			}),
			user,
			updateInfo,
		),
	);
});

admin.get("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const [updateInfo, flags, numbers] = await Promise.all([
		peekCachedLatestVersion(c.env),
		loadFlags(c.env),
		loadNumbers(c.env),
	]);
	return c.html(
		renderPage(
			c,
			"Settings",
			renderSettings(c.env, flags, numbers),
			user,
			updateInfo,
		),
	);
});

// Persist runtime settings overrides. Body is either
//   { flags: { comments_enabled: bool, … },     — boolean feature toggles
//     numbers: { comments_per_page: 25, … } }    — numeric display settings
//   { reset: true }                              — clear all overrides
// flags and numbers are independent; either or both may be present.
// Admin-only; same-origin CSRF check is enforced by the admin middleware.
type SettingsBody = {
	flags?: Record<string, unknown>;
	numbers?: Record<string, unknown>;
	reset?: unknown;
};

admin.post("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<SettingsBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);

	if (body.reset === true) {
		await deleteSettings(c.env.DB, [...FLAG_KEYS, ...NUMBER_KEYS]);
		await Promise.all([bustFlagsCache(c.env), bustNumbersCache(c.env)]);
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "settings.update",
			target_kind: "system",
			target_id: "settings",
			meta: { reset: true },
		});
		return c.json({ ok: true, reset: true });
	}

	const flagsObj =
		body.flags && typeof body.flags === "object" ? body.flags : null;
	const numbersObj =
		body.numbers && typeof body.numbers === "object" ? body.numbers : null;
	if (!flagsObj && !numbersObj) {
		return c.json({ error: "settings_required" }, 400);
	}

	// Only persist known keys; ignore anything else the client sends.
	const writtenFlags: Record<string, boolean> = {};
	if (flagsObj) {
		for (const key of FLAG_KEYS) {
			const raw = flagsObj[key];
			if (raw === undefined) continue;
			if (typeof raw !== "boolean") {
				return c.json({ error: `invalid_flag:${key}` }, 400);
			}
			writtenFlags[key] = raw;
		}
	}

	// Numbers are validated and clamped into their declared [min,max] so a
	// hostile or fat-fingered value can't reach the slice/render paths.
	const writtenNumbers: Record<string, number> = {};
	if (numbersObj) {
		for (const key of NUMBER_KEYS) {
			const raw = numbersObj[key];
			if (raw === undefined) continue;
			const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
			if (!Number.isFinite(n)) {
				return c.json({ error: `invalid_number:${key}` }, 400);
			}
			const { min, max } = numberBounds(key);
			writtenNumbers[key] = Math.min(max, Math.max(min, Math.trunc(n)));
		}
	}

	if (
		Object.keys(writtenFlags).length === 0 &&
		Object.keys(writtenNumbers).length === 0
	) {
		return c.json({ error: "settings_required" }, 400);
	}

	for (const [key, value] of Object.entries(writtenFlags)) {
		await setSetting(c.env.DB, key, value ? "true" : "false");
	}
	for (const [key, value] of Object.entries(writtenNumbers)) {
		await setSetting(c.env.DB, key, String(value));
	}
	const busts: Promise<void>[] = [];
	if (Object.keys(writtenFlags).length > 0) busts.push(bustFlagsCache(c.env));
	if (Object.keys(writtenNumbers).length > 0)
		busts.push(bustNumbersCache(c.env));
	await Promise.all(busts);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "settings.update",
		target_kind: "system",
		target_id: "settings",
		meta: { ...writtenFlags, ...writtenNumbers },
	});
	return c.json({ ok: true, flags: writtenFlags, numbers: writtenNumbers });
});

admin.get("/about", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const [updateInfo, releases] = await Promise.all([
		peekCachedLatestVersion(c.env),
		peekCachedRecentReleases(c.env),
	]);
	return c.html(renderPage(c, "About", renderAbout(releases), user, updateInfo));
});

// -------------------------- webhook endpoints -------------------------------
//
// Operator-only CRUD for /webhook_endpoints rows. Mods don't see this; webhook
// configuration is operator territory (secrets, outbound URLs).
//
// The env-shim banner is driven by a stale `WEBHOOK_URL` env var coexisting
// with a populated table — that's the misconfiguration that buys the user
// the legacy unsigned-no-retry semantics. If the table is empty, the shim is
// the only delivery surface and the banner reminds the operator to migrate.

const isEnvShimActive = (env: Bindings, endpoints: WebhookEndpoint[]): boolean =>
	Boolean(env.WEBHOOK_URL) && endpoints.length === 0;

admin.get("/webhooks", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const updateInfo = await peekCachedLatestVersion(c.env);
	const endpoints = await listWebhookEndpoints(c.env.DB);
	return c.html(
		renderPage(c, 
			"Webhooks",
			renderWebhooksList(endpoints, {
				active: isEnvShimActive(c.env, endpoints),
				url: c.env.WEBHOOK_URL ?? "",
			}),
			user,
			updateInfo,
		),
	);
});

admin.get("/webhooks/new", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const updateInfo = await peekCachedLatestVersion(c.env);
	const data: WebhookFormData = { endpoint: null, error: null };
	return c.html(
		renderPage(c, "Add webhook", renderWebhookForm(data), user, updateInfo),
	);
});

admin.get("/webhooks/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const endpoint = await getWebhookEndpoint(c.env.DB, id);
	if (!endpoint) {
		return c.html(
			accessDeniedHtml(404, "That webhook endpoint no longer exists."),
			404,
		);
	}
	const updateInfo = await peekCachedLatestVersion(c.env);
	const data: WebhookFormData = { endpoint, error: null };
	return c.html(
		renderPage(c, "Edit webhook", renderWebhookForm(data), user, updateInfo),
	);
});

// Validation helpers used by both POST and PATCH. Centralized so an
// operator who PATCHes a URL gets the same SSRF/scheme checks as a
// fresh create.
type WebhookBody = {
	url?: unknown;
	secret?: unknown;
	events?: unknown;
	adapter?: unknown;
	enabled?: unknown;
};

type WebhookFields = {
	url: string;
	secret: string | null;
	events: string[] | null;
	adapter: WebhookAdapter;
	enabled: boolean;
};

const VALID_EVENTS = [
	"comment.posted",
	"comment.edited",
	"comment.deleted",
	"comment.approved",
	"comment.spam",
] as const;

const isValidEvent = (v: unknown): v is (typeof VALID_EVENTS)[number] =>
	typeof v === "string" &&
	(VALID_EVENTS as readonly string[]).includes(v);

const parseWebhookBody = (
	body: WebhookBody,
	env: Bindings,
): { ok: true; fields: WebhookFields } | { ok: false; error: string } => {
	if (typeof body.url !== "string" || body.url.length === 0) {
		return { ok: false, error: "url_required" };
	}
	// allowHttp only in dev — production endpoints must be https to make
	// the signing+secret guarantees meaningful end-to-end.
	const safe = checkOutboundUrl(body.url, { allowHttp: env.ENV === "dev" });
	if (!safe.ok) return { ok: false, error: `url:${safe.reason}` };

	let secret: string | null = null;
	if (body.secret !== undefined && body.secret !== null && body.secret !== "") {
		if (typeof body.secret !== "string") {
			return { ok: false, error: "secret_invalid" };
		}
		// 16 bytes of entropy minimum — anything shorter is unsafe for HMAC
		// signing and almost certainly a typo (admin meant "no secret").
		if (body.secret.length < 16) {
			return { ok: false, error: "secret_too_short" };
		}
		if (body.secret.length > 256) {
			return { ok: false, error: "secret_too_long" };
		}
		secret = body.secret;
	}

	let events: string[] | null = null;
	if (body.events !== undefined && body.events !== null) {
		if (!Array.isArray(body.events)) {
			return { ok: false, error: "events_invalid" };
		}
		const filtered = body.events.filter(isValidEvent);
		if (filtered.length !== body.events.length) {
			return { ok: false, error: "events_unknown" };
		}
		// All five events selected = "no filter"; store NULL so receivers
		// see future events too without a re-save.
		events = filtered.length === VALID_EVENTS.length ? null : filtered;
	}

	const adapter = body.adapter ?? "generic";
	if (!isWebhookAdapter(adapter)) {
		return { ok: false, error: "adapter_invalid" };
	}

	const enabled = body.enabled !== false; // default true

	return {
		ok: true,
		fields: { url: body.url, secret, events, adapter, enabled },
	};
};

admin.post("/api/webhooks", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<WebhookBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const parsed = parseWebhookBody(body, c.env);
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	const created = await createWebhookEndpoint(c.env.DB, parsed.fields);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "webhook.create",
		target_kind: "webhook",
		target_id: created.id,
		// Never write the secret to the audit log — just whether one is set.
		meta: {
			url: created.url,
			adapter: created.adapter,
			enabled: created.enabled,
			has_secret: created.secret != null,
			events: created.events,
		},
	});
	return c.json({ ok: true, id: created.id });
});

admin.patch("/api/webhooks/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const existing = await getWebhookEndpoint(c.env.DB, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	const body = await c.req.json<WebhookBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const parsed = parseWebhookBody(body, c.env);
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	await updateWebhookEndpoint(c.env.DB, id, parsed.fields);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "webhook.update",
		target_kind: "webhook",
		target_id: id,
		meta: {
			url: parsed.fields.url,
			adapter: parsed.fields.adapter,
			enabled: parsed.fields.enabled,
			has_secret: parsed.fields.secret != null,
			secret_rotated: parsed.fields.secret !== existing.secret,
			events: parsed.fields.events,
		},
	});
	return c.json({ ok: true, id });
});

// -------------------------- Cloudflare usage dashboard ----------------------
//
// Optional feature. When CF_API_TOKEN + CF_ACCOUNT_ID are unset, the page
// shows a setup guide instead of charts and the nav link is hidden by
// layout.ts. We never throw a 500 here just because the operator hasn't
// configured the token — graceful degradation per spec.

admin.get("/usage", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const [updateInfo, byHost] = await Promise.all([
		peekCachedLatestVersion(c.env),
		adminCommentsByHost(c.env.DB),
	]);
	if (!isUsageConfigured(c.env)) {
		return c.html(
			renderPage(c, "Usage", renderUsageSetup(byHost), user, updateInfo),
		);
	}
	// Verify the token before hitting GraphQL — surfaces revoked / wrong-
	// scope tokens with a clear error instead of cryptic GraphQL failures.
	const tokenOk = await verifyToken(c.env.CF_API_TOKEN as string);
	if (!tokenOk.ok || tokenOk.status !== "active") {
		const errMsg = tokenOk.ok ? `status:${tokenOk.status}` : tokenOk.error;
		return c.html(
			renderPage(c, "Usage", renderUsageTokenError(errMsg, byHost), user, updateInfo),
		);
	}
	try {
		const snapshot = await fetchUsageSnapshot(c.env);
		return c.html(
			renderPage(c, "Usage", renderUsageDashboard(snapshot, byHost), user, updateInfo),
		);
	} catch (err) {
		return c.html(
			renderPage(c, "Usage", renderUsageTokenError(String(err), byHost), user, updateInfo),
		);
	}
});

admin.delete("/api/webhooks/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const existing = await getWebhookEndpoint(c.env.DB, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	await deleteWebhookEndpoint(c.env.DB, id);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "webhook.delete",
		target_kind: "webhook",
		target_id: id,
		meta: { url: existing.url, adapter: existing.adapter },
	});
	return c.json({ ok: true, id });
});

// ---------------------------- Saved replies --------------------------------
//
// Pre-written moderator replies. A mod authors a markdown body; we never
// store rendered HTML — every post goes through renderMarkdown at post time
// so a renderer-version bump always applies (matches comments).
//
// Visibility:
//   - 'private' replies are visible only to the owner.
//   - 'shared' replies are visible to every mod + admin.
//
// Mutation:
//   - Only the owner can edit or delete (enforced in SQL via owner_id WHERE).
//     Even an admin can't modify another mod's reply through the API — they
//     can sign in as that user via OAuth if they really need to.
//
// Post-as-reply:
//   - POST /admin/api/saved-replies/:id/post with { comment_id } posts a
//     top-level reply on the same post as the target comment, authored by
//     the mod's own user, status=approved (bypassing Turnstile/spam — the
//     mod has already vouched for the content). Body is the saved reply's
//     markdown, optionally edited.

// Exported so tests can assert the parser against the real values
// instead of pinning literal numbers that would silently drift.
export const SAVED_REPLY_TITLE_MAX = 120;
export const SAVED_REPLY_BODY_MAX = 8000;

type SavedReplyBody = {
	title?: unknown;
	body_md?: unknown;
	scope?: unknown;
};

type SavedReplyFields = {
	title: string;
	body_md: string;
	scope: SavedReplyScope;
};

export const parseSavedReplyBody = (
	body: SavedReplyBody,
): { ok: true; fields: SavedReplyFields } | { ok: false; error: string } => {
	if (typeof body.title !== "string" || body.title.trim().length === 0) {
		return { ok: false, error: "title_required" };
	}
	if (body.title.length > SAVED_REPLY_TITLE_MAX) {
		return { ok: false, error: "title_too_long" };
	}
	if (typeof body.body_md !== "string" || body.body_md.trim().length === 0) {
		return { ok: false, error: "body_required" };
	}
	if (body.body_md.length > SAVED_REPLY_BODY_MAX) {
		return { ok: false, error: "body_too_long" };
	}
	if (!isSavedReplyScope(body.scope)) {
		return { ok: false, error: "scope_invalid" };
	}
	return {
		ok: true,
		fields: {
			title: body.title.trim(),
			body_md: body.body_md,
			scope: body.scope,
		},
	};
};

admin.get("/saved-replies", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const updateInfo = await peekCachedLatestVersion(c.env);
	const replies = await listSavedRepliesForUser(c.env.DB, user.id);
	const ownerIds = Array.from(new Set(replies.map((r) => r.owner_id)));
	const owners = await getUsersByIds(c.env.DB, ownerIds);
	const ownersById = new Map<string, string>();
	for (const [id, u] of owners) ownersById.set(id, u.name);
	return c.html(
		renderPage(
			c,
			"Saved replies",
			renderSavedRepliesList(replies, user, ownersById),
			user,
			updateInfo,
		),
	);
});

admin.get("/saved-replies/new", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(
			c,
			"New saved reply",
			renderSavedReplyForm({ existing: null, error: null }),
			user,
			updateInfo,
		),
	);
});

admin.get("/saved-replies/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const reply = await getSavedReply(c.env.DB, id);
	if (!reply) {
		return c.html(
			accessDeniedHtml(404, "That saved reply no longer exists."),
			404,
		);
	}
	// Read visibility: owner can always see it; non-owners only if shared.
	// Private replies are not enumerable across mods.
	if (reply.owner_id !== user.id && reply.scope !== "shared") {
		return c.html(
			accessDeniedHtml(404, "That saved reply no longer exists."),
			404,
		);
	}
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(
			c,
			"Edit saved reply",
			renderSavedReplyForm({ existing: reply, error: null }),
			user,
			updateInfo,
		),
	);
});

// JSON list for the queue's Reply picker. Same visibility rules as
// /admin/saved-replies — owner-private OR scope=shared.
admin.get("/api/saved-replies", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const replies = await listSavedRepliesForUser(c.env.DB, user.id);
	return c.json({
		replies: replies.map((r) => ({
			id: r.id,
			title: r.title,
			body_md: r.body_md,
			scope: r.scope,
			owner_id: r.owner_id,
		})),
	});
});

admin.post("/api/saved-replies", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<SavedReplyBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const parsed = parseSavedReplyBody(body);
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	const created = await insertSavedReply(c.env.DB, {
		owner_id: user.id,
		title: parsed.fields.title,
		body_md: parsed.fields.body_md,
		scope: parsed.fields.scope,
	});
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "saved_reply.create",
		target_kind: "saved_reply",
		target_id: created.id,
		meta: { title: created.title, scope: created.scope },
	});
	return c.json({ ok: true, id: created.id });
});

admin.patch("/api/saved-replies/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const existing = await getSavedReply(c.env.DB, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	// Owner-only mutation. Even an admin cannot edit another mod's private
	// reply through the API — the WHERE clause in updateSavedReply enforces
	// this in SQL too, but we 403 cleanly here for a better error.
	if (existing.owner_id !== user.id) {
		return c.json({ error: "not_owner" }, 403);
	}
	const body = await c.req.json<SavedReplyBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const parsed = parseSavedReplyBody(body);
	if (!parsed.ok) return c.json({ error: parsed.error }, 400);
	const changed = await updateSavedReply(c.env.DB, id, user.id, parsed.fields);
	if (!changed) return c.json({ error: "not_found" }, 404);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "saved_reply.update",
		target_kind: "saved_reply",
		target_id: id,
		meta: {
			title: parsed.fields.title,
			scope: parsed.fields.scope,
			scope_changed: existing.scope !== parsed.fields.scope,
		},
	});
	return c.json({ ok: true, id });
});

admin.delete("/api/saved-replies/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const existing = await getSavedReply(c.env.DB, id);
	if (!existing) return c.json({ error: "not_found" }, 404);
	if (existing.owner_id !== user.id) {
		return c.json({ error: "not_owner" }, 403);
	}
	const deleted = await deleteSavedReply(c.env.DB, id, user.id);
	if (!deleted) return c.json({ error: "not_found" }, 404);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "saved_reply.delete",
		target_kind: "saved_reply",
		target_id: id,
		meta: { title: existing.title, scope: existing.scope },
	});
	return c.json({ ok: true, id });
});

// Post a saved reply as a top-level reply on a comment. Body is the
// saved reply's markdown by default; the mod can override (`body_md`) to
// tweak before sending. Always re-rendered through renderMarkdown — we
// never trust stored HTML.
admin.post("/api/saved-replies/:id/post", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const reply = await getSavedReply(c.env.DB, id);
	if (!reply) return c.json({ error: "not_found" }, 404);
	// Visibility check mirrors the GET — only the owner or shared replies.
	if (reply.owner_id !== user.id && reply.scope !== "shared") {
		return c.json({ error: "not_found" }, 404);
	}
	const body = await c.req
		.json<{ comment_id?: unknown; body_md?: unknown }>()
		.catch(() => null);
	if (!body || typeof body.comment_id !== "string") {
		return c.json({ error: "invalid_body" }, 400);
	}
	const target = await getComment(c.env.DB, body.comment_id);
	if (!target) return c.json({ error: "comment_not_found" }, 404);
	if (target.status === "deleted") {
		return c.json({ error: "comment_deleted" }, 400);
	}
	// Allow the mod to override the body before posting.
	const rawBody =
		typeof body.body_md === "string" && body.body_md.trim().length > 0
			? body.body_md
			: reply.body_md;
	if (rawBody.length > SAVED_REPLY_BODY_MAX) {
		return c.json({ error: "body_too_long" }, 400);
	}
	const body_html = renderMarkdown(rawBody);
	const inserted = await insertComment(c.env.DB, {
		post_slug: target.post_slug,
		parent_id: target.id,
		user_id: user.id,
		body_md: rawBody,
		body_html,
		renderer_version: CURRENT_RENDERER_VERSION,
		status: "approved",
		ip_hash: null,
		user_agent: null,
	});
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "saved_reply.post",
		target_kind: "comment",
		target_id: inserted.id,
		meta: {
			from_saved_reply: true,
			saved_reply_id: reply.id,
			parent_id: target.id,
			post_slug: target.post_slug,
		},
	});
	// Bust the post's tree caches so the new reply is visible immediately.
	await bustTreeCache(c.env, target.post_slug);
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.posted",
		comment_id: inserted.id,
		post_slug: target.post_slug,
		user_id: user.id,
		ts: Date.now(),
	});
	return c.json({ ok: true, id: inserted.id });
});

type CommentAction = "approve" | "spam" | "delete" | "restore";

admin.post("/api/comments/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ action?: string; reason?: string }>()
		.catch(() => null);
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
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action,
		target_kind: "comment",
		target_id: id,
		reason: body?.reason ?? null,
		meta: { prev_status: existing.status, new_status: newStatus },
	});
	// Bust the cached first page so the moderation result is visible.
	await bustTreeCache(c.env, existing.post_slug);
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
	const user = await requireMod(c);
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
	const bulkAction: AdminAction =
		action === "spam"
			? "bulk.spam"
			: action === "delete"
				? "bulk.delete"
				: action === "restore"
					? "bulk.restore"
					: "bulk.approve";
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
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: bulkAction,
			target_kind: "comment",
			target_id: id,
			meta: { batch_size: touched.length, new_status: newStatus },
		});
		await bustTreeCache(c.env, existing.post_slug);
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
	const body = await c.req
		.json<{ banned?: boolean; reason?: string }>()
		.catch(() => null);
	if (!body || typeof body.banned !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	// Without this, setUserBanned silently no-ops on a bogus id and the
	// endpoint returns ok — masking a typo or stale UI from the admin.
	const target = await getUser(c.env.DB, id);
	if (!target) return c.json({ error: "not_found" }, 404);
	await setUserBanned(c.env.DB, id, body.banned);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: body.banned ? "ban" : "unban",
		target_kind: "user",
		target_id: id,
		reason: body.reason ?? null,
		meta: { target_name: target.name },
	});
	return c.json({ ok: true, id, banned: body.banned });
});

export const roleAuditAction = (
	from: UserRole,
	to: UserRole,
): AdminAction | null => {
	if (from === to) return null;
	if (to === "admin") return "role.grant_admin";
	if (from === "admin") return "role.revoke_admin";
	if (to === "mod") return "role.grant_mod";
	return "role.revoke_mod";
};

admin.post("/api/users/:id/role", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ role?: unknown; reason?: string }>()
		.catch(() => null);
	if (!body || !isUserRole(body.role)) {
		return c.json({ error: "invalid_role" }, 400);
	}
	// Self-demotion would leave the instance without an admin if this is the
	// last one. Block self role changes entirely — operators must promote a
	// peer to admin first and have them demote, or use the DB CLI for the
	// emergency case. Same defense-in-depth as ban: easy to misclick.
	if (id === user.id) {
		return c.json({ error: "cannot_change_own_role" }, 400);
	}
	const target = await getUser(c.env.DB, id);
	if (!target) return c.json({ error: "not_found" }, 404);
	const action = roleAuditAction(target.role, body.role);
	if (!action) return c.json({ ok: true, id, role: target.role });
	// Refuse a demotion that would leave the instance with zero admins.
	// Self-change is already blocked above; this catches the parallel
	// case where two admins simultaneously demote each other. The check
	// is intentionally NOT a transaction with setUserRole — a true race
	// here would require both requests to read count=2 before either
	// writes, which is a narrow window and the worst case is a recovery
	// via the DB CLI, not silent state corruption.
	if (target.role === "admin" && body.role !== "admin") {
		const admins = await countAdmins(c.env.DB);
		if (admins <= 1) {
			return c.json({ error: "last_admin" }, 400);
		}
	}
	await setUserRole(c.env.DB, id, body.role);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action,
		target_kind: "user",
		target_id: id,
		reason: body.reason ?? null,
		meta: {
			target_name: target.name,
			from: target.role,
			to: body.role,
		},
	});
	return c.json({ ok: true, id, role: body.role });
});

const randomToken = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

admin.post("/api/subscriptions/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ action?: string; reason?: string }>()
		.catch(() => null);
	const action = body?.action;
	if (action !== "unsubscribe" && action !== "resend") {
		return c.json({ error: "invalid_action" }, 400);
	}

	const sub = await adminGetSubscription(c.env.DB, id);
	if (!sub) return c.json({ error: "not_found" }, 404);

	if (action === "unsubscribe") {
		if (sub.unsubscribed_at == null) {
			await markSubscriptionUnsubscribed(c.env.DB, id);
		}
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "sub.unsubscribe",
			target_kind: "subscription",
			target_id: id,
			reason: body?.reason ?? null,
			meta: { email: sub.email, post_slug: sub.post_slug },
		});
		return c.json({ ok: true, id, status: "unsubscribed" });
	}

	// resend: rotate confirm_token + re-issue the confirmation email.
	const publicBase = c.env.PUBLIC_BASE_URL;
	const from = c.env.EMAIL_FROM;
	if (!publicBase || !from) {
		return c.json({ error: "email_not_configured" }, 503);
	}
	if (sub.confirmed_at != null) {
		return c.json({ error: "already_confirmed" }, 409);
	}
	if (sub.unsubscribed_at != null) {
		return c.json({ error: "unsubscribed" }, 409);
	}

	// Send the confirmation email first; only persist the rotated token
	// when delivery succeeds. If we rotated first and sendEmail returned
	// false, the previous token would already be invalid and the user
	// would have no working confirmation link at all.
	const newToken = randomToken();
	const post = await getPost(c.env.DB, sub.post_slug);
	const confirmUrl = `${publicBase}/api/v1/subscribe/confirm/${newToken}`;
	const html = renderConfirmEmailHtml({
		postTitle: post?.title ?? sub.post_slug,
		confirmUrl,
	});
	const sent = await sendEmail(c.env, {
		to: sub.email,
		from,
		subject: t("email.confirm.subject").replace(
			"{title}",
			post?.title ?? sub.post_slug,
		),
		html,
	});
	if (!sent) {
		return c.json({ error: "email_send_failed" }, 502);
	}
	await adminRotateSubscriptionConfirmToken(c.env.DB, id, newToken);

	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "sub.resend",
		target_kind: "subscription",
		target_id: id,
		reason: body?.reason ?? null,
		meta: { email: sub.email, post_slug: sub.post_slug },
	});
	return c.json({ ok: true, id, status: "resent" });
});

const RERENDER_MAX_BATCH = 100;

admin.post("/api/ops/rerender", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req
		.json<{
			batch?: number;
			cursor?: { created_at: number; id: string } | null;
		}>()
		.catch(() => ({}) as Record<string, never>);
	const batchRaw = Number(body.batch ?? 50);
	const batch =
		Number.isFinite(batchRaw) && batchRaw > 0
			? Math.min(RERENDER_MAX_BATCH, Math.floor(batchRaw))
			: 50;
	const cursor =
		body.cursor &&
		typeof body.cursor.created_at === "number" &&
		typeof body.cursor.id === "string"
			? body.cursor
			: null;

	const result = await rerenderBatch(c.env.DB, batch, cursor);
	if (result.processed > 0) {
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "rerender",
			target_kind: "system",
			target_id: null,
			reason: null,
			meta: {
				batch_size: batch,
				processed: result.processed,
				cursor_after: result.next_cursor,
			},
		});
	}
	return c.json({
		ok: true,
		processed: result.processed,
		next_cursor: result.next_cursor,
	});
});

// ---------------------------- Disqus import --------------------------------
//
// Admin-only. Accepts a Disqus comment-export XML in the request body
// (raw text/xml or application/xml). Idempotent — re-uploading the same
// file inserts zero new rows. Capped at MAX_XML_BYTES (shared with the
// parser and the operator page, so the three limits can't drift) to keep
// a hostile / huge payload from running away inside the Worker; larger
// imports should go through the CLI (`npm run import-disqus`).

admin.post("/api/ops/import-disqus", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;

	const contentLength = Number(c.req.header("content-length") ?? "0");
	if (contentLength > MAX_XML_BYTES) {
		return c.json({ error: "too_large" }, 413);
	}
	// Byte-accurate recheck for bodies that dodge the header check (e.g.
	// chunked encoding with no content-length). String .length counts
	// UTF-16 code units, which undercounts UTF-8 bytes for multibyte
	// content — so measure the raw bytes before decoding.
	const buf = await c.req.arrayBuffer();
	if (buf.byteLength === 0) return c.json({ error: "empty_body" }, 400);
	if (buf.byteLength > MAX_XML_BYTES) {
		return c.json({ error: "too_large" }, 413);
	}
	const xml = new TextDecoder().decode(buf);
	// Lightweight format sanity check before we hit the parser. Reject
	// non-XML uploads up front so an operator who picks the wrong file
	// gets a clear error rather than a parser stack trace.
	if (!/<disqus\b|<thread\b|<post\b/i.test(xml.slice(0, 4096))) {
		return c.json({ error: "not_disqus_xml" }, 400);
	}

	const dryRun = c.req.header("x-dry-run") === "1";
	const includeDeleted = c.req.header("x-include-deleted") === "1";
	const includeSpam = c.req.header("x-include-spam") === "1";

	// Reuse IP_HASH_SECRET for the importer's HMAC-derived ghost
	// provider_id. Same secret rotation rules apply.
	const secret = c.env.IP_HASH_SECRET;
	if (!secret) return c.json({ error: "ip_hash_secret_missing" }, 500);

	try {
		const plan = await runDisqusImport(c.env.DB, xml, secret, {
			dry_run: dryRun,
			include_deleted: includeDeleted,
			include_spam: includeSpam,
		});
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "import.disqus",
			target_kind: "system",
			target_id: null,
			meta: { dry_run: dryRun, ...plan },
		});
		return c.json({ ok: true, dry_run: dryRun, plan });
	} catch (err) {
		return c.json({ error: `import_failed:${(err as Error).message}` }, 400);
	}
});

admin.post("/api/ops/seed-demo", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	if (!isSeedDemoAllowed(c.env)) {
		return c.json({ error: "disabled_in_production" }, 403);
	}
	const result = await runSeedDemo(c.env.DB);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "seed-demo",
		target_kind: "system",
		target_id: null,
		reason: null,
		meta: result,
	});
	return c.json({ ok: true, ...result });
});

export { admin };
