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
	adminGetCommentDetail,
	adminGetUserDetail,
	adminInsertAudit,
	adminLatestAuditByTarget,
	adminGetSubscription,
	adminListAudit,
	adminListComments,
	adminListSubscriptions,
	adminListUsers,
	adminOldestPending,
	adminRotateSubscriptionConfirmToken,
	adminSpamRate,
	adminStats,
	adminTimeline,
	adminTopCommenters,
	adminTopPosts,
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	getComment,
	getPost,
	getUser,
	getWebhookEndpoint,
	isWebhookAdapter,
	listWebhookEndpoints,
	markSubscriptionUnsubscribed,
	setUserBanned,
	updateCommentStatus,
	updateWebhookEndpoint,
	type AdminAction,
	type AuditTargetKind,
	type CommentStatus,
	type User,
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
import { renderUserDetail } from "../admin-ui/pages/user-detail";
import { renderUsers } from "../admin-ui/pages/users";
import { renderOperator } from "../admin-ui/pages/operator";
import { renderSettings } from "../admin-ui/pages/settings";
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
	});

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
	const db = c.env.DB;
	const [stats, timeline, topPosts, topCommenters, oldestPending, spamRate, updateInfo] =
		await Promise.all([
			adminStats(db),
			adminTimeline(db, 30),
			adminTopPosts(db, 30, 5),
			adminTopCommenters(db, 30, 5),
			adminOldestPending(db),
			adminSpamRate(db, 30),
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

	const latestAudit = await adminLatestAuditByTarget(
		c.env.DB,
		"comment",
		trimmed.map((r) => r.id),
	);

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
		renderPage(c, 
			"Queue",
			renderQueue(trimmed, filters, nextCursor, latestAudit),
			user,
			updateInfo,
		),
	);
});

admin.get("/comments/:id", async (c) => {
	const user = await requireAdmin(c);
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
		renderPage(c, detail.user.name, renderUserDetail(detail), user, updateInfo),
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

	const rows = await adminListAudit(c.env.DB, filter, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;

	const filters: AuditFilters = {
		admin_id: adminId,
		action: actionFilter ?? "",
		target_kind: kindFilter ?? "",
		target_id: targetId,
		from: fromRaw ?? "",
		to: toRaw ?? "",
	};
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c, 
			"Audit",
			renderAudit(trimmed, filters, nextCursor, ADMIN_ACTIONS),
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
	const before = c.req.query("before") ?? null;

	const filter: Parameters<typeof adminListSubscriptions>[1] = {};
	if (q) filter.q = q;
	if (postSlug) filter.post_slug = postSlug;
	if (confirmed === "yes") filter.confirmed = true;
	if (confirmed === "no") filter.confirmed = false;
	if (unsubscribed === "yes") filter.unsubscribed = true;
	if (unsubscribed === "no") filter.unsubscribed = false;

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
	};
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(
		renderPage(c, 
			"Subscriptions",
			renderSubscriptions(rows, filters, nextCursor),
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
	const updateInfo = await peekCachedLatestVersion(c.env);
	return c.html(renderPage(c, "Settings", renderSettings(c.env), user, updateInfo));
});

admin.get("/about", async (c) => {
	const user = await requireAdmin(c);
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
	const updateInfo = await peekCachedLatestVersion(c.env);
	if (!isUsageConfigured(c.env)) {
		return c.html(renderPage(c, "Usage", renderUsageSetup(), user, updateInfo));
	}
	// Verify the token before hitting GraphQL — surfaces revoked / wrong-
	// scope tokens with a clear error instead of cryptic GraphQL failures.
	const tokenOk = await verifyToken(c.env.CF_API_TOKEN as string);
	if (!tokenOk.ok || tokenOk.status !== "active") {
		const errMsg = tokenOk.ok ? `status:${tokenOk.status}` : tokenOk.error;
		return c.html(
			renderPage(c, "Usage", renderUsageTokenError(errMsg), user, updateInfo),
		);
	}
	try {
		const snapshot = await fetchUsageSnapshot(c.env);
		return c.html(
			renderPage(c, "Usage", renderUsageDashboard(snapshot), user, updateInfo),
		);
	} catch (err) {
		return c.html(
			renderPage(c, "Usage", renderUsageTokenError(String(err)), user, updateInfo),
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

type CommentAction = "approve" | "spam" | "delete" | "restore";

admin.post("/api/comments/:id", async (c) => {
	const user = await requireAdmin(c);
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
