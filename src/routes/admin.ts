/**
 * Admin UI (HTML pages) + JSON action endpoints.
 *
 * Layout:
 *   GET  /admin                  → dashboard with stats + nav
 *   GET  /admin/queue?status=…   → comment moderation list
 *   GET  /admin/users?q=…        → user list with ban toggle
 *   GET  /admin/settings         → settings form + read-only env summary
 *   POST /admin/settings         → persist flags/numbers to the settings table
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
	countOpenReportsByComment,
	createWebhookEndpoint,
	deleteSettings,
	deleteTelegramLinkByUser,
	deleteWebhookEndpoint,
	enqueueNotification,
	exportUserData,
	getComment,
	getTelegramLinkByUser,
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
	listActiveSubscriptionsForPost,
	listSavedRepliesForUser,
	listWebhookEndpoints,
	markSubscriptionUnsubscribed,
	setPostClosed,
	setSetting,
	setTelegramDigest,
	setUserRole,
	updateSavedReply,
	deleteSavedReply,
	updateWebhookEndpoint,
	upsertPost,
	type AdminAction,
	type AuditTargetKind,
	type CommentStatus,
	type SavedReplyScope,
	type User,
	type UserRole,
	type WebhookAdapter,
	type WebhookEndpoint,
} from "../db/queries";
import { fireWebhook, type WebhookEvent } from "../lib/webhook";
import {
	banUser,
	type CommentAction,
	eraseUser,
	moderateComment,
	resolveReports,
} from "../lib/moderation";
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
import { renderTelegram } from "../admin-ui/pages/telegram";
import { issueTelegramLinkToken } from "./telegram";
import { renderSettings } from "../admin-ui/pages/settings";
import {
	bustSettingsCache,
	FLAG_KEYS,
	loadNumbers,
	loadSettings,
	MAX_TEXT_SETTING_CHARS,
	NUMBER_KEYS,
	numberBounds,
	STRING_KEYS,
	stringOptions,
	TEXT_KEYS,
} from "../lib/settings";
import { bustTreeCache } from "../lib/tree-cache";
import { MAX_REPLY_DEPTH } from "../lib/tree";
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
import {
	CURRENT_RENDERER_VERSION,
	renderMarkdown,
	validateBody,
} from "../lib/markdown";
import { MAX_XML_BYTES, runDisqusImport } from "../lib/disqus-import";
import { rerenderBatch, rerenderStats } from "../db/rerender";
import {
	MIN_RETENTION_DAYS,
	isRetentionEnabled,
	retentionStats,
	sweepExpiredIpHashes,
} from "../db/ip-retention";
import {
	MIN_AUDIT_RETENTION_DAYS,
	auditRetentionStats,
	isAuditRetentionEnabled,
	pruneAuditLog,
} from "../db/audit-retention";
import { runSeedDemo } from "../db/seed-demo";
import { renderConfirmEmailHtml } from "../lib/digest";
import { sendEmail } from "../lib/email";
import { fillSubject, subjectTitle } from "../lib/post-title";
import { FALLBACK_LOCALE, tFor } from "../i18n";

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
	// Every admin response is per-moderator data: queue contents, user emails,
	// audit trails, webhook secrets. Without this it lands in the browser's disk
	// cache and bfcache, so it survives sign-out and is readable by the next
	// person on the machine. `no-store` also keeps it out of any intermediary.
	c.header("cache-control", "no-store, max-age=0");

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
	const [
		stats,
		timeline,
		topPosts,
		topCommenters,
		oldestPending,
		spamRate,
		byHost,
		updateInfo,
		{ flags, numbers },
	] = await Promise.all([
		adminStats(db),
		adminTimeline(db, 30),
		adminTopPosts(db, 30, 5),
		adminTopCommenters(db, 30, 5),
		adminOldestPending(db),
		adminSpamRate(db, 30),
		adminCommentsByHost(db),
		peekCachedLatestVersion(c.env),
		// The anti-spam summary line reports the resolved heuristic dials, so it
		// has to read them the same way evaluateSpam does.
		loadSettings(c.env),
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
		flags,
		numbers,
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

	// The "reported" view cuts across statuses (a reported comment may be
	// approved, pending, etc.), so it ignores the status tab.
	const reportedRaw = (c.req.query("reported") ?? "").trim();
	const reported = reportedRaw === "1" || reportedRaw === "true";

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

	// When the reported view is active, drop the status constraint so reported
	// comments of any status show up together.
	const filter: import("../db/queries").AdminCommentFilter = {
		status: reported ? "all" : status,
	};
	if (q) filter.q = q;
	if (postSlug) filter.post_slug = postSlug;
	if (userId) filter.user_id = userId;
	if (fromMs != null) filter.from = fromMs;
	if (toExclusive != null) filter.to = toExclusive;
	if (host) filter.host = host;
	if (reported) filter.reported = true;

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

	// Open-report counts for the visible rows → queue badges. Operator-only;
	// never surfaced in the public payload (avoids a brigading signal).
	const reportCounts = await countOpenReportsByComment(
		c.env.DB,
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
		reported,
	};
	// Surface the per-post close toggle only when the queue is scoped to a
	// single post. A post row may not exist yet (no comments) — treat absent
	// as open so the operator can still pre-close it.
	const postState = postSlug
		? await getPost(c.env.DB, postSlug).then((p) => ({
				slug: postSlug,
				closed: p?.closed ?? false,
			}))
		: null;
	return c.html(
		renderPage(c,
			"Queue",
			renderQueue(
				trimmed,
				filters,
				nextCursor,
				latestAudit,
				hosts,
				postState,
				reportCounts,
				user.name,
			),
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
		renderPage(
			c,
			`Comment ${id.slice(0, 8)}`,
			renderCommentDetail(detail, user.role === "admin", user.name),
			user,
			updateInfo,
		),
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
	const { ip_hash_retention_days, audit_log_retention_days } =
		await loadNumbers(c.env);
	// One `now` for both sweeps' stats so the two cards can't disagree about
	// where the cutoff falls.
	const now = Date.now();
	const retention = await retentionStats(
		c.env.DB,
		ip_hash_retention_days,
		now,
	);
	const auditRetention = await auditRetentionStats(
		c.env.DB,
		audit_log_retention_days,
		now,
	);
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c,
			"Operator",
			renderOperator({
				rerender: stats,
				retention,
				audit_retention: auditRetention,
				seed_demo_allowed: isSeedDemoAllowed(c.env),
			}),
			user,
			updateInfo,
		),
	);
});

// --- Telegram operator linking ------------------------------------------
//
// The bot itself is configured with Worker secrets (TELEGRAM_BOT_TOKEN /
// _WEBHOOK_SECRET); this page links the viewing admin's personal Telegram
// account for interactive buttons + slash commands + the optional digest.
// Admin-only: linking grants the account moderation reach, so it shouldn't be
// self-served by a plain mod. Every Telegram action still re-checks the
// linked user's role at action time.

admin.get("/telegram", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const [updateInfo, link] = await Promise.all([
		peekCachedLatestVersion(c.env),
		getTelegramLinkByUser(c.env.DB, user.id),
	]);
	return c.html(
		renderPage(
			c,
			"Telegram",
			renderTelegram({
				configured: !!c.env.TELEGRAM_BOT_TOKEN,
				webhookSecretSet: !!c.env.TELEGRAM_WEBHOOK_SECRET,
				botUsername: c.env.TELEGRAM_BOT_USERNAME ?? null,
				link: link ? { linked_at: link.linked_at, digest: link.digest } : null,
			}),
			user,
			updateInfo,
		),
	);
});

// Issue a one-time link code. The admin redeems it by sending /start <code>
// to the bot, which writes the telegram_links row (src/routes/telegram.ts).
admin.post("/api/telegram/link", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const code = await issueTelegramLinkToken(c.env.OAUTH_STATE, user.id);
	// The code is a bearer credential for the link; it's short-lived (10 min)
	// and one-time, but keep it out of the audit trail and logs all the same.
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "telegram.link_code",
		target_kind: "user",
		target_id: user.id,
	});
	return c.json({ ok: true, code });
});

admin.delete("/api/telegram/link", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const removed = await deleteTelegramLinkByUser(c.env.DB, user.id);
	if (removed) {
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "telegram.unlink",
			target_kind: "user",
			target_id: user.id,
		});
	}
	return c.json({ ok: true, removed });
});

admin.post("/api/telegram/digest", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<{ digest?: unknown }>().catch(() => null);
	if (!body || typeof body.digest !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	const updated = await setTelegramDigest(c.env.DB, user.id, body.digest);
	if (!updated) return c.json({ error: "not_linked" }, 404);
	return c.json({ ok: true, digest: body.digest });
});

admin.get("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const [updateInfo, { flags, numbers, strings, texts }] = await Promise.all([
		peekCachedLatestVersion(c.env),
		loadSettings(c.env),
	]);
	return c.html(
		renderPage(
			c,
			"Settings",
			renderSettings(c.env, flags, numbers, strings, texts),
			user,
			updateInfo,
		),
	);
});

// Persist runtime settings overrides. Body is either
//   { flags: { comments_enabled: bool, … },     — boolean feature toggles
//     numbers: { comments_per_page: 25, … },     — numeric display settings
//     strings: { default_locale: "de", … },      — enumerated string settings
//     texts: { spam_blocklist: "…", … } }        — free-form multi-line text
//   { reset: true }                              — clear all overrides
// The four groups are independent; any subset may be present.
// Admin-only; same-origin CSRF check is enforced by the admin middleware.
type SettingsBody = {
	flags?: Record<string, unknown>;
	numbers?: Record<string, unknown>;
	strings?: Record<string, unknown>;
	texts?: Record<string, unknown>;
	reset?: unknown;
};

admin.post("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<SettingsBody>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);

	if (body.reset === true) {
		await deleteSettings(c.env.DB, [
			...FLAG_KEYS,
			...NUMBER_KEYS,
			...STRING_KEYS,
			...TEXT_KEYS,
		]);
		await bustSettingsCache(c.env);
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
	const stringsObj =
		body.strings && typeof body.strings === "object" ? body.strings : null;
	const textsObj =
		body.texts && typeof body.texts === "object" ? body.texts : null;
	if (!flagsObj && !numbersObj && !stringsObj && !textsObj) {
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

	// Strings are whitelisted, not clamped: rejecting an off-list value outright
	// (rather than quietly substituting the default the way the resolver does)
	// means a stale admin page can't silently reset a locale the operator picked.
	const writtenStrings: Record<string, string> = {};
	if (stringsObj) {
		for (const key of STRING_KEYS) {
			const raw = stringsObj[key];
			if (raw === undefined) continue;
			if (typeof raw !== "string" || !stringOptions(key).includes(raw)) {
				return c.json({ error: `invalid_string:${key}` }, 400);
			}
			writtenStrings[key] = raw;
		}
	}

	// Free-form text is neither clamped nor whitelisted, so the only check that
	// applies at this layer is the length bound. Over-long is rejected rather
	// than truncated: the resolver truncates silently because it has nobody to
	// report to, but here there is an operator watching, and quietly discarding
	// the tail of a moderation list is how you end up with rules that "didn't
	// save" for no visible reason.
	//
	// Per-term problems are deliberately not errors — see `parseBlocklist`,
	// which drops an over-long or too-wildcarded term and keeps the rest. The
	// settings page reports what actually parsed so a dropped line is visible
	// without one bad line rejecting the whole save.
	const writtenTexts: Record<string, string> = {};
	if (textsObj) {
		for (const key of TEXT_KEYS) {
			const raw = textsObj[key];
			if (raw === undefined) continue;
			if (typeof raw !== "string") {
				return c.json({ error: `invalid_text:${key}` }, 400);
			}
			const value = raw.trim();
			if (value.length > MAX_TEXT_SETTING_CHARS) {
				return c.json({ error: `text_too_long:${key}` }, 400);
			}
			// An empty box means an empty list, not "inherit the env default" —
			// an operator clearing a muted-words list has to be able to clear it.
			// Reset (above) is the way back to the env/default value.
			writtenTexts[key] = value;
		}
	}

	if (
		Object.keys(writtenFlags).length === 0 &&
		Object.keys(writtenNumbers).length === 0 &&
		Object.keys(writtenStrings).length === 0 &&
		Object.keys(writtenTexts).length === 0
	) {
		return c.json({ error: "settings_required" }, 400);
	}

	for (const [key, value] of Object.entries(writtenFlags)) {
		await setSetting(c.env.DB, key, value ? "true" : "false");
	}
	for (const [key, value] of Object.entries(writtenNumbers)) {
		await setSetting(c.env.DB, key, String(value));
	}
	for (const [key, value] of Object.entries(writtenStrings)) {
		await setSetting(c.env.DB, key, value);
	}
	for (const [key, value] of Object.entries(writtenTexts)) {
		await setSetting(c.env.DB, key, value);
	}
	// One cache entry holds all four groups, so a write to any of them
	// invalidates it. Still conditional: a no-op save shouldn't spend a KV write.
	const wrote =
		Object.keys(writtenFlags).length > 0 ||
		Object.keys(writtenNumbers).length > 0 ||
		Object.keys(writtenStrings).length > 0 ||
		Object.keys(writtenTexts).length > 0;
	if (wrote) {
		await bustSettingsCache(c.env);
	}
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "settings.update",
		target_kind: "system",
		target_id: "settings",
		meta: {
			...writtenFlags,
			...writtenNumbers,
			...writtenStrings,
			// Size, not content: a text setting can run to MAX_TEXT_SETTING_CHARS,
			// and an audit row exists to say who changed what and when, not to
			// keep a copy of every revision of the muted-words list.
			...Object.fromEntries(
				Object.entries(writtenTexts).map(([key, v]) => [key, `${v.length} chars`]),
			),
		},
	});
	return c.json({
		ok: true,
		flags: writtenFlags,
		numbers: writtenNumbers,
		strings: writtenStrings,
		texts: writtenTexts,
	});
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
	// Three-state, and the distinction matters: absent = leave whatever is
	// stored alone, null = clear the secret, string = set it. The edit form no
	// longer prefills the stored value (it's write-only), so a two-state
	// `string | null` would silently unsign every endpoint on the next save.
	// updateWebhookEndpoint already skips keys that are undefined.
	secret?: string | null | undefined;
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
	"comment.reported",
] as const;

const isValidEvent = (v: unknown): v is (typeof VALID_EVENTS)[number] =>
	typeof v === "string" &&
	(VALID_EVENTS as readonly string[]).includes(v);

// Telegram chat id: a signed integer (negative for groups/supergroups, e.g.
// -1001234567890) or a public channel username (@name, 5–32 chars). This is
// what the telegram adapter stores in the `url` column instead of a URL.
const isValidTelegramChatId = (v: string): boolean =>
	/^-?\d{1,20}$/.test(v) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(v);

const parseWebhookBody = (
	body: WebhookBody,
	env: Bindings,
): { ok: true; fields: WebhookFields } | { ok: false; error: string } => {
	if (typeof body.url !== "string" || body.url.length === 0) {
		return { ok: false, error: "url_required" };
	}

	const adapter = body.adapter ?? "generic";
	if (!isWebhookAdapter(adapter)) {
		return { ok: false, error: "adapter_invalid" };
	}

	// The telegram adapter repurposes the `url` field as a destination chat id
	// (the real target is the fixed Bot API host, composed from
	// TELEGRAM_BOT_TOKEN at dispatch). Validate its shape instead of running
	// the URL/SSRF guard, which is built for arbitrary operator URLs.
	if (adapter === "telegram") {
		if (!isValidTelegramChatId(body.url)) {
			return { ok: false, error: "chat_id_invalid" };
		}
	} else {
		// allowHttp only in dev — production endpoints must be https to make
		// the signing+secret guarantees meaningful end-to-end.
		const safe = checkOutboundUrl(body.url, { allowHttp: env.ENV === "dev" });
		if (!safe.ok) return { ok: false, error: `url:${safe.reason}` };
	}

	// undefined stays undefined all the way to the UPDATE, which is what keeps a
	// blank field on the edit form from wiping a secret the form can no longer
	// show. An explicit null (the "remove signing" button) still clears it.
	let secret: string | null | undefined;
	if (body.secret === null) {
		secret = null;
	} else if (body.secret !== undefined && body.secret !== "") {
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
		// Every known event selected = "no filter"; store NULL so receivers
		// see future events too without a re-save.
		events = filtered.length === VALID_EVENTS.length ? null : filtered;
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
	// On create there is nothing to preserve, so "absent" collapses to "unsigned".
	const created = await createWebhookEndpoint(c.env.DB, {
		...parsed.fields,
		secret: parsed.fields.secret ?? null,
	});
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
			// An absent secret leaves the stored one in place, so report the
			// effective state rather than what the request happened to carry.
			has_secret:
				(parsed.fields.secret === undefined
					? existing.secret
					: parsed.fields.secret) != null,
			secret_rotated:
				parsed.fields.secret !== undefined &&
				parsed.fields.secret !== existing.secret,
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
	const tokenOk = await verifyToken(
		c.env.CF_API_TOKEN as string,
		c.env.CF_ACCOUNT_ID as string,
	);
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
// Posting one is not a saved-reply operation any more: a mod posts through
// POST /admin/api/comments/:id/reply (see "Moderator replies" below) with the
// preset's markdown as the request body, and an optional `saved_reply_id` for
// audit provenance only. Saved replies are a *prefill* source, not a posting
// path — the dedicated `saved-replies/:id/post` endpoint was removed when free
// text became the canonical reply input.

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

// --------------------------- Moderator replies -----------------------------
//
// POST /admin/api/comments/:id/reply
//   { body_md, saved_reply_id?, notify? }
//
// The canonical way a moderator answers a comment from the admin panel. Free
// text is the general case; a saved reply is only a *prefill* of it, which is
// why this route is keyed on the comment being answered rather than on a saved
// reply. `saved_reply_id` is provenance for the audit row and nothing else.
//
// The reply is a child of the target (not a top-level comment), authored by the
// moderator's own user, status=approved — Turnstile and the spam pipeline are
// bypassed because a mod posting under their own name has already vouched for
// the content. Body is always re-rendered through renderMarkdown at post time;
// we never trust stored HTML.
//
// Length is bounded by the *comment* cap (MAX_BODY_CHARS, via validateBody),
// not SAVED_REPLY_BODY_MAX. What we insert here is a comment, so it gets the
// comment's rules; a saved reply's 8k body always fits inside that.
admin.post("/api/comments/:id/reply", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const body = await c.req
		.json<{
			body_md?: unknown;
			saved_reply_id?: unknown;
			notify?: unknown;
		}>()
		.catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);

	const valid = validateBody(
		typeof body.body_md === "string" ? body.body_md : "",
	);
	if (!valid.ok) {
		return c.json(
			valid.key === "err.body.too_long"
				? { error: "body_too_long", max: valid.max }
				: { error: "body_required" },
			400,
		);
	}

	// Optional, but not coercible: `"false"` and `0` are what a buggy client sends
	// when it means "don't email anyone", and silently reading either as true
	// mails the whole thread. Absent stays absent; anything present must be a
	// real boolean.
	if (body.notify != null && typeof body.notify !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}

	// Provenance is optional, but when claimed it has to be a reply this mod can
	// actually see — otherwise the audit row could name someone else's private
	// saved reply. A 400 rather than a 404: the reply body is fine, the claim
	// about where it came from is not.
	let savedReplyId: string | null = null;
	if (body.saved_reply_id != null) {
		if (typeof body.saved_reply_id !== "string") {
			return c.json({ error: "invalid_body" }, 400);
		}
		const source = await getSavedReply(c.env.DB, body.saved_reply_id);
		if (!source || (source.owner_id !== user.id && source.scope !== "shared")) {
			return c.json({ error: "saved_reply_not_visible" }, 400);
		}
		savedReplyId = source.id;
	}

	const target = await getComment(c.env.DB, c.req.param("id"));
	if (!target) return c.json({ error: "comment_not_found" }, 404);
	if (target.status === "deleted") {
		return c.json({ error: "comment_deleted" }, 400);
	}
	// The nesting cap applies to moderators too: the O(N^2) tree-assembly cost
	// it guards doesn't care who created the chain. Reply higher up instead.
	const depth = target.depth + 1;
	if (depth > MAX_REPLY_DEPTH) {
		return c.json({ error: "thread_too_deep" }, 400);
	}

	const inserted = await insertComment(c.env.DB, {
		post_slug: target.post_slug,
		parent_id: target.id,
		user_id: user.id,
		body_md: valid.body,
		body_html: renderMarkdown(valid.body),
		renderer_version: CURRENT_RENDERER_VERSION,
		status: "approved",
		ip_hash: null,
		user_agent: null,
		depth,
	});

	// Default on: this is a real comment on a real thread, so the people
	// following that thread should hear about it the same way they hear about a
	// reader's reply. The composer's checkbox exists so a housekeeping note
	// ("dupe, see above") doesn't have to email everyone.
	const notify = body.notify ?? true;
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "comment.reply",
		target_kind: "comment",
		target_id: inserted.id,
		meta: {
			from_saved_reply: savedReplyId != null,
			saved_reply_id: savedReplyId,
			parent_id: target.id,
			post_slug: target.post_slug,
			// The operator's choice, not a delivery count — the fan-out below is
			// deferred, and a number here would be a guess at what it will write.
			notify_subscribers: notify,
		},
	});
	// Bust the post's tree caches so the new reply is visible immediately.
	await bustTreeCache(c.env, c.req.url, target.post_slug);
	fireWebhook(c.env, c.executionCtx, {
		event: "comment.posted",
		comment_id: inserted.id,
		post_slug: target.post_slug,
		user_id: user.id,
		ts: inserted.created_at,
	});

	if (notify) {
		const fanout = (async () => {
			const subs = await listActiveSubscriptionsForPost(
				c.env.DB,
				target.post_slug,
			);
			// Skip our own address for the same reason the widget path does: being
			// emailed about your own comment reads as a bug.
			const selfEmail = user.email?.toLowerCase() ?? null;
			for (const sub of subs) {
				if (selfEmail && sub.email === selfEmail) continue;
				await enqueueNotification(c.env.DB, sub.id, inserted.id);
			}
		})();
		// Always wait for the enqueue to finish — same reasoning as the widget
		// fan-out in routes/api.comments.ts: without an executionCtx the runtime
		// can cancel the orphan promise once the response settles, and a lost row
		// here is a notification nobody ever gets.
		if (c.executionCtx) c.executionCtx.waitUntil(fanout);
		else await fanout;
	}

	return c.json({ ok: true, id: inserted.id, notified: notify });
});

// POST /admin/api/preview  { body_md } -> { html }
//
// Render markdown for the reply composer without persisting. A saved reply was
// vetted when it was written; ad hoc text is not, and it posts publicly under
// the moderator's own name, so seeing it first matters.
//
// Deliberately not a call to POST /api/v1/preview: that route is anonymous and
// rate-limited to 5 requests / 10s per IP on a shared bucket, which is the
// wrong shape for an authenticated moderator editing a reply. Here requireMod
// is the gate, and the admin middleware's same-origin check comes for free.
//
// Returning HTML for the page to inject is safe for exactly the reason the
// widget's preview is: renderMarkdown is the strict-allowlist sanitizer, and it
// is the same function that produces the stored body_html.
admin.post("/api/preview", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const body = await c.req.json<{ body_md?: unknown }>().catch(() => null);
	if (!body) return c.json({ error: "invalid_body" }, 400);
	const valid = validateBody(
		typeof body.body_md === "string" ? body.body_md : "",
	);
	if (!valid.ok) {
		return c.json(
			valid.key === "err.body.too_long"
				? { error: "body_too_long", max: valid.max }
				: { error: "body_required" },
			400,
		);
	}
	return c.json({ html: renderMarkdown(valid.body) });
});

admin.post("/api/comments/:id", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ action?: string; reason?: string }>()
		.catch(() => null);
	const action = body?.action as CommentAction | undefined;
	if (
		action !== "approve" &&
		action !== "spam" &&
		action !== "delete" &&
		action !== "restore"
	) {
		return c.json({ error: "invalid_action" }, 400);
	}
	const result = await moderateComment({
		env: c.env,
		executionCtx: c.executionCtx,
		reqUrl: c.req.url,
		adminId: user.id,
		commentId: id,
		action,
		reason: body?.reason ?? null,
	});
	if (!result.ok) return c.json({ error: result.error }, 404);
	return c.json({ ok: true, id: result.id, status: result.status });
});

// Per-post comment freeze/unfreeze. Flips posts.closed; the lazy thread
// resolver (src/lib/thread.ts) enforces it on the next POST. Mod-gated; the
// admin middleware already applies the same-origin CSRF check.
const POST_SLUG_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;

admin.post("/api/posts/close", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const body = await c.req
		.json<{ slug?: unknown; closed?: unknown }>()
		.catch(() => null);
	if (!body || typeof body.slug !== "string" || typeof body.closed !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	const slug = body.slug.trim();
	if (!slug || !POST_SLUG_RE.test(slug)) {
		return c.json({ error: "invalid_slug" }, 400);
	}
	const closed = body.closed;
	// Ensure a post row exists before flipping — a thread can be pre-closed
	// before its first comment arrives. upsertPost never touches `closed`, so
	// it's safe to create-or-noop here.
	await upsertPost(c.env.DB, slug, null, null);
	await setPostClosed(c.env.DB, slug, closed);
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: closed ? "post.close" : "post.open",
		target_kind: "post",
		target_id: slug,
		meta: { post_slug: slug },
	});
	// Bust the cached first page so the closed-state banner reflects immediately
	// for anonymous viewers (the GET payload carries accepting_comments).
	await bustTreeCache(c.env, c.req.url, slug);
	return c.json({ ok: true, slug, closed });
});

// Dismiss (resolve) all open reader reports on a comment. The comment itself
// is moderated via the existing approve/spam/delete actions; this only clears
// the report flags so the comment leaves the "reported" queue. Mod-gated.
admin.post("/api/comments/:id/reports/resolve", async (c) => {
	const user = await requireMod(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const result = await resolveReports({ env: c.env, adminId: user.id, commentId: id });
	if (!result.ok) return c.json({ error: result.error }, 404);
	return c.json({ ok: true, id: result.id, resolved: result.resolved });
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
		await bustTreeCache(c.env, c.req.url, existing.post_slug);
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
		.json<{ banned?: boolean; reason?: string; from_comment?: unknown }>()
		.catch(() => null);
	if (!body || typeof body.banned !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	const result = await banUser({
		env: c.env,
		adminId: user.id,
		userId: id,
		banned: body.banned,
		fromComment:
			typeof body.from_comment === "string" ? body.from_comment : null,
		reason: body.reason ?? null,
	});
	if (!result.ok) return c.json({ error: result.error }, 404);
	return c.json({ ok: true, id: result.id, banned: result.banned });
});

/**
 * Everything the instance holds about one user, as a JSON download — the
 * mechanism behind a GDPR Art. 15 (access) / Art. 20 (portability) request.
 * See `docs/compliance/dsar-runbook.md` for the process around it.
 *
 * A GET, like every other admin read, so it carries no `Origin` CSRF gate and
 * an operator can save it straight from the browser. That is safe *because* it
 * is a read: `requireAdmin` is the only thing standing between a caller and the
 * file, and a cross-site GET can't exfiltrate the body to another origin.
 *
 * The file contains the subject's `ip_hash` and comment bodies in the clear.
 * It is a personal-data export by construction — handle the download itself as
 * carefully as a D1 dump.
 */
admin.get("/api/users/:id/export", async (c) => {
	// Unlike every other admin GET this one *writes* (the audit row below), and
	// admin GETs carry no `Origin` gate. Session cookies are `SameSite=None`, so
	// a page on another origin can fire this with the operator's credentials —
	// it can't read the response, but it can spend D1 writes and forge audit
	// rows. `Sec-Fetch-Site` is the cheap gate: the admin UI reaches this by a
	// same-origin `<a>`, and a saved bookmark sends `none`. Absent header means
	// a browser too old to send it (or a CLI), which the `Origin` gate elsewhere
	// can't see either — fail open there rather than lock out curl.
	if (c.req.header("sec-fetch-site") === "cross-site") {
		return c.json({ error: "cross_site_forbidden" }, 403);
	}
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const data = await exportUserData(c.env.DB, id);
	if (!data) return c.json({ error: "not_found" }, 404);

	// Record that an export happened, never what was in it — an audit row that
	// echoed the payload would recreate the personal data it is auditing.
	await adminInsertAudit(c.env.DB, {
		admin_id: user.id,
		action: "user.export",
		target_kind: "user",
		target_id: id,
		reason: null,
		meta: {
			comments: data.comments.length,
			reports_filed: data.reports_filed.length,
			subscriptions: data.subscriptions.length,
		},
	});

	// The id is a ULID in practice, but it arrives from the URL — clamp it to
	// the safe set rather than trusting that, so nothing can smuggle a quote or
	// a newline into the header.
	const safeId = id.replace(/[^A-Za-z0-9_-]/g, "") || "user";
	// `c.body`, not `new Response` — a raw Response drops the headers the admin
	// middleware prepared with `c.header()` (CSP, nosniff, frame-options,
	// referrer-policy), the same trap `lib/cors.ts` backfills around.
	return c.body(JSON.stringify(data, null, 2), 200, {
		"content-type": "application/json; charset=utf-8",
		"content-disposition": `attachment; filename="garrul-export-${safeId}.json"`,
		// Never let an export sit in a shared cache.
		"cache-control": "no-store",
	});
});

/**
 * Erase a user's personal data. Irreversible, so the body has to carry an
 * explicit `confirm: "ERASE"` alongside the flag — a bare POST to this URL does
 * nothing. Guards on self / other-admins live in `eraseUser`.
 */
admin.post("/api/users/:id/erase", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req
		.json<{ confirm?: unknown; redact_bodies?: unknown; reason?: string }>()
		.catch(() => null);
	if (!body || body.confirm !== "ERASE") {
		return c.json({ error: "confirmation_required" }, 400);
	}
	if (typeof body.redact_bodies !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	const result = await eraseUser({
		env: c.env,
		reqUrl: c.req.url,
		adminId: user.id,
		userId: id,
		redactBodies: body.redact_bodies,
		reason: body.reason ?? null,
	});
	if (!result.ok) {
		return c.json({ error: result.error }, result.error === "not_found" ? 404 : 400);
	}
	return c.json({ ok: true, id: result.id, counts: result.counts });
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
		// No `target_name`. `target_id` identifies the user, the audit page joins
		// the current name at read time, and a display name copied in here is
		// personal data that outlives the account it belongs to — erasure
		// anonymizes `users.name` but has never reached the audit log.
		meta: {
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
			// No `email`. `target_id` is the subscription id and the row is
			// soft-unsubscribed rather than deleted, so the address is still
			// reachable from the subscription itself — copying it here only created a
			// second copy that erasure never found.
			meta: { post_slug: sub.post_slug },
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
	// Sanitized again here, not just on the write path: a database upgraded from
	// an earlier version can still hold a title with a CR/LF in it, and a mail
	// subject is a header value.
	const title = subjectTitle(post?.title, sub.post_slug);
	// The subscriber's language, not the operator's. This route is admin-facing
	// but the mail it produces is not: it lands in the reader's inbox, and a
	// resend arriving in a different language than the original would read as a
	// phishing attempt rather than a helpful nudge.
	const subT = tFor(sub.locale ?? FALLBACK_LOCALE);
	const html = renderConfirmEmailHtml({
		postTitle: title,
		confirmUrl,
		t: subT,
	});
	const sent = await sendEmail(c.env, {
		to: sub.email,
		from,
		subject: fillSubject(subT("email.confirm.subject"), title),
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
		// See the note on sub.unsubscribe above — the address stays on the
		// subscription row, not in here.
		meta: { post_slug: sub.post_slug },
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

// --- IP-hash retention -----------------------------------------------------
//
// Runs the same sweep as the cron, one batch per call, so an operator who just
// turned retention on doesn't have to wait out a backlog 15 minutes at a time.
// The window itself is not settable here — it's a Settings dial — and the
// endpoint refuses when the resolved value is off or below the floor, rather
// than picking a window of its own. Audited: this destroys data irreversibly,
// so "who drained the hashes" has to be answerable.

admin.post("/api/ops/ip-retention", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;

	const { ip_hash_retention_days: days } = await loadNumbers(c.env);
	if (!isRetentionEnabled(days)) {
		return c.json(
			{
				error: "retention_disabled",
				retention_days: days,
				min_days: MIN_RETENTION_DAYS,
			},
			400,
		);
	}

	const result = await sweepExpiredIpHashes(c.env.DB, days, Date.now());
	if (result.comments > 0 || result.reports > 0) {
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "ip_retention.sweep",
			target_kind: "system",
			target_id: null,
			reason: null,
			meta: {
				retention_days: days,
				comments: result.comments,
				reports: result.reports,
			},
		});
	}
	return c.json({ ok: true, ...result });
});

// --- Audit-log retention ---------------------------------------------------
//
// Same shape as the IP sweep above: one batch per call so an operator who just
// turned retention on can drain a backlog without waiting out the cron, the
// window itself stays a Settings dial, and the endpoint refuses rather than
// inventing a window when the resolved value is off or below the floor.
//
// Audited, with the same wrinkle worth naming: this writes an audit row
// recording the deletion of audit rows. That is deliberate — the sweep is the
// one action that can erase its own evidence, so the record of it running has
// to survive, and it does: the new row is written now and so is far newer than
// any cutoff it could delete.

admin.post("/api/ops/audit-retention", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;

	const { audit_log_retention_days: days } = await loadNumbers(c.env);
	if (!isAuditRetentionEnabled(days)) {
		return c.json(
			{
				error: "retention_disabled",
				retention_days: days,
				min_days: MIN_AUDIT_RETENTION_DAYS,
			},
			400,
		);
	}

	const result = await pruneAuditLog(c.env.DB, days, Date.now());
	if (result.deleted > 0) {
		await adminInsertAudit(c.env.DB, {
			admin_id: user.id,
			action: "audit_retention.sweep",
			target_kind: "system",
			target_id: null,
			reason: null,
			meta: { retention_days: days, deleted: result.deleted },
		});
	}
	return c.json({ ok: true, ...result });
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
