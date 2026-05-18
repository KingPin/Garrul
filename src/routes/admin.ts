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
 * Why HTML strings + Alpine instead of JSX + a framework: Alpine.js
 * gives us inline `x-data` interactivity in ~15KB without a build step,
 * matches the project's "ship the minimum" theme, and keeps the bundle
 * out of the embed.js budget. The trade-off — Alpine needs
 * `'unsafe-eval'` — is scoped to /admin/* only via the CSP we set here.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Bindings } from "../index";
import { readSession } from "../lib/session";
import {
	adminListComments,
	adminListUsers,
	adminStats,
	getComment,
	getUser,
	setUserBanned,
	updateCommentStatus,
	type AdminStats,
	type Comment,
	type CommentStatus,
	type User,
} from "../db/queries";
import { fireWebhook, type WebhookEvent } from "../lib/webhook";
import { sanitizeForEmail as resanitizeBodyHtml } from "../lib/markdown";

const admin = new Hono<{ Bindings: Bindings }>();

const escapeHtml = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
};

type Ctx = Context<{ Bindings: Bindings }>;

const wantsHtml = (c: Ctx): boolean => {
	const accept = c.req.header("accept") ?? "";
	return accept.includes("text/html");
};

const accessDeniedHtml = (status: 401 | 403, message: string): string => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${status === 401 ? "Sign in required" : "Forbidden"} — Garrul Admin</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         background: #0b0d10; color: #e7eaf0; max-width: 480px;
         margin: 4rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { margin-top: 0; }
  a { color: #6aa9ff; }
  code { background: #1e2530; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>${status === 401 ? "Sign in required" : "Forbidden"}</h1>
<p>${message}</p>
<p class="muted">Sign in through the comments widget on any page first, then refresh.
  Admins are auto-promoted on sign-in if their email is in
  <code>ADMIN_EMAILS</code>.</p>
</body>
</html>`;

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

const ADMIN_CSP = [
	"default-src 'self'",
	// 'unsafe-eval' is required by Alpine.js's x-data expression evaluator.
	// Confined to /admin/* via this header; the public API + widget pages
	// keep their stricter CSP.
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https:",
	"connect-src 'self'",
	"frame-ancestors 'none'",
].join("; ");

const layout = (title: string, body: string, currentUser: User): string => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Garrul Admin</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #131820; --border: #1e2530; --text: #e7eaf0;
    --muted: #8a93a6; --accent: #6aa9ff; --warn: #f7b955; --bad: #ef6a6a;
    --ok: #4ad295;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { background: var(--panel); border-bottom: 1px solid var(--border);
           padding: 0.75rem 1rem; display: flex; gap: 1.5rem; align-items: center; }
  header h1 { font-size: 1rem; margin: 0; }
  header nav { display: flex; gap: 1rem; flex: 1; }
  header .me { color: var(--muted); }
  main { max-width: 1100px; margin: 1.5rem auto; padding: 0 1rem; }
  .card { background: var(--panel); border: 1px solid var(--border);
          border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .stat-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .stat { background: var(--bg); border: 1px solid var(--border);
          border-radius: 6px; padding: 0.75rem 1rem; }
  .stat .v { font-size: 1.5rem; font-weight: 600; }
  .stat .l { color: var(--muted); font-size: 0.8rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.5rem 0.5rem; border-bottom: 1px solid var(--border);
           text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 0.8rem; text-transform: uppercase; }
  .row-body { color: var(--text); max-width: 480px; overflow-wrap: anywhere; }
  .row-body .md { font-size: 0.9rem; }
  .pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
          font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
          border: 1px solid var(--border); color: var(--muted); }
  .pill.approved { color: var(--ok); border-color: var(--ok); }
  .pill.pending { color: var(--warn); border-color: var(--warn); }
  .pill.spam, .pill.deleted, .pill.banned { color: var(--bad); border-color: var(--bad); }
  .pill.admin { color: var(--accent); border-color: var(--accent); }
  button, .btn { background: var(--bg); color: var(--text); border: 1px solid var(--border);
                 padding: 0.3rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  button:hover { border-color: var(--accent); }
  button.bad { color: var(--bad); }
  button.bad:hover { border-color: var(--bad); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions { display: flex; gap: 0.4rem; }
  .filter-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; }
  .filter-bar input[type=text] { background: var(--bg); border: 1px solid var(--border);
                                  color: var(--text); padding: 0.4rem 0.6rem;
                                  border-radius: 6px; min-width: 240px; }
  .muted { color: var(--muted); }
  .pager { display: flex; justify-content: space-between; margin-top: 1rem; }
  code { background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 3px;
         font-family: ui-monospace, monospace; font-size: 0.85em; }
</style>
</head>
<body>
<header>
  <h1>Garrul Admin</h1>
  <nav>
    <a href="/admin">Dashboard</a>
    <a href="/admin/queue">Queue</a>
    <a href="/admin/users">Users</a>
    <a href="/admin/settings">Settings</a>
  </nav>
  <span class="me">${escapeHtml(currentUser.name)} <span class="pill admin">admin</span></span>
</header>
<main>
${body}
</main>
<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js" defer></script>
</body>
</html>`;

const renderDashboard = (stats: AdminStats): string => `
<div class="card">
  <h2>Overview</h2>
  <div class="stat-grid">
    <div class="stat"><div class="v">${stats.total_comments}</div><div class="l">total comments</div></div>
    <div class="stat"><div class="v">${stats.pending_comments}</div><div class="l">pending</div></div>
    <div class="stat"><div class="v">${stats.spam_comments}</div><div class="l">spam</div></div>
    <div class="stat"><div class="v">${stats.total_users}</div><div class="l">users</div></div>
    <div class="stat"><div class="v">${stats.banned_users}</div><div class="l">banned</div></div>
  </div>
</div>
<div class="card">
  <h3>Quick actions</h3>
  <ul>
    <li><a href="/admin/queue?status=pending">Review ${stats.pending_comments} pending comment(s)</a></li>
    <li><a href="/admin/queue?status=spam">Inspect spam folder</a></li>
    <li><a href="/admin/users">Manage users</a></li>
  </ul>
</div>`;

const renderQueue = (
	rows: Comment[],
	status: string,
	nextCursor: string | null,
): string => {
	const tabs = ["all", "approved", "pending", "spam", "deleted"]
		.map(
			(s) =>
				`<a href="/admin/queue?status=${s}" ${s === status ? 'style="font-weight:600"' : ""}>${s}</a>`,
		)
		.join(" · ");

	const rowsHtml = rows.length
		? rows
				.map(
					(c) => `
<tr x-data="{ busy: false }">
  <td><span class="pill ${c.status}">${c.status}</span></td>
  <td>
    <div class="muted">${new Date(c.created_at).toISOString().slice(0, 16).replace("T", " ")}</div>
    <div><code>${escapeHtml(c.post_slug)}</code></div>
    <div class="muted" style="font-size:0.75rem">${escapeHtml(c.id)}</div>
  </td>
  <td class="row-body"><div class="md">${resanitizeBodyHtml(c.body_html)}</div></td>
  <td class="actions">
    <button :disabled="busy" @click="busy=true; act('${c.id}','approve').finally(()=>busy=false)">Approve</button>
    <button :disabled="busy" class="bad" @click="busy=true; act('${c.id}','spam').finally(()=>busy=false)">Spam</button>
    <button :disabled="busy" class="bad" @click="busy=true; act('${c.id}','delete').finally(()=>busy=false)">Delete</button>
  </td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="4" class="muted">No comments match.</td></tr>`;

	const next = nextCursor
		? `<a href="/admin/queue?status=${status}&before=${encodeURIComponent(nextCursor)}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<div class="filter-bar"><span class="muted">filter:</span> ${tabs}</div>
<div class="card" x-data="{
  act(id, action) {
    return fetch('/admin/api/comments/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
      location.reload();
    });
  }
}">
  <table>
    <thead><tr><th>Status</th><th>Meta</th><th>Body</th><th>Actions</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};

const renderUsers = (
	rows: User[],
	q: string,
	nextCursor: string | null,
): string => {
	const rowsHtml = rows.length
		? rows
				.map(
					(u) => `
<tr x-data="{ busy: false, banned: ${u.is_banned} }">
  <td>
    <div>${escapeHtml(u.name)} ${u.is_admin ? '<span class="pill admin">admin</span>' : ""}
      <span x-show="banned" class="pill banned">banned</span></div>
    <div class="muted">${escapeHtml(u.email ?? "—")}</div>
  </td>
  <td>${escapeHtml(u.provider)}</td>
  <td class="muted">${new Date(u.created_at).toISOString().slice(0, 10)}</td>
  <td class="actions">
    <template x-if="!banned">
      <button :disabled="busy" class="bad" @click="busy=true; setBanned('${u.id}', true).then(()=>{banned=true}).finally(()=>busy=false)">Ban</button>
    </template>
    <template x-if="banned">
      <button :disabled="busy" @click="busy=true; setBanned('${u.id}', false).then(()=>{banned=false}).finally(()=>busy=false)">Unban</button>
    </template>
  </td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="4" class="muted">No users match.</td></tr>`;

	const queryStr = q ? `&q=${encodeURIComponent(q)}` : "";
	const next = nextCursor
		? `<a href="/admin/users?before=${encodeURIComponent(nextCursor)}${queryStr}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<div class="card" x-data="{
  setBanned(id, banned) {
    return fetch('/admin/api/users/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ banned }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
    });
  }
}">
  <form class="filter-bar" method="get" action="/admin/users">
    <input type="text" name="q" placeholder="search name or email" value="${escapeHtml(q)}">
    <button type="submit">Search</button>
    ${q ? '<a href="/admin/users">clear</a>' : ""}
  </form>
  <table>
    <thead><tr><th>User</th><th>Provider</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};

const renderSettings = (env: Bindings): string => {
	const rows: [string, string][] = [
		["ENV", env.ENV ?? "(unset)"],
		["ALLOWED_ORIGINS", env.ALLOWED_ORIGINS ?? "(unset)"],
		["ADMIN_EMAILS", env.ADMIN_EMAILS ?? "(unset)"],
		["EDIT_WINDOW_MINUTES", env.EDIT_WINDOW_MINUTES ?? "(default: 15)"],
		["TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY ? "(set)" : "(unset)"],
		["GH_CLIENT_ID", env.GH_CLIENT_ID ? "(set)" : "(unset)"],
		["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID ? "(set)" : "(unset)"],
		["OAUTH_CALLBACK_BASE", env.OAUTH_CALLBACK_BASE ?? "(falls back to request origin)"],
		["EMAIL_PROVIDER", env.EMAIL_PROVIDER ?? "(unset)"],
	];
	const body = rows
		.map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(v)}</td></tr>`)
		.join("");
	return `
<div class="card">
  <h2>Configuration</h2>
  <p class="muted">All settings are environment variables. Change them with
  <code>wrangler secret put NAME</code> (or edit <code>wrangler.toml</code>
  <code>[vars]</code> for non-secrets) and redeploy.</p>
  <table>
    <thead><tr><th>Variable</th><th>Value</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>
<div class="card">
  <h3>Bindings</h3>
  <ul>
    <li><code>DB</code> — D1 database (comments, users, reactions, posts)</li>
    <li><code>RATE_LIMITS</code>, <code>OAUTH_STATE</code>, <code>SESSIONS</code>, <code>TREE_CACHE</code> — KV namespaces</li>
    <li><code>ANALYTICS</code> — Workers Analytics Engine dataset (optional)</li>
  </ul>
</div>`;
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

admin.get("/", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const stats = await adminStats(c.env.DB);
	return c.html(layout("Dashboard", renderDashboard(stats), user));
});

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

	const rows = await adminListComments(c.env.DB, status, 51, cursorTs, cursorId);
	const trimmed = rows.slice(0, 50);
	const last = trimmed[trimmed.length - 1];
	const nextCursor =
		rows.length > 50 && last ? `${last.created_at}|${last.id}` : null;

	return c.html(layout("Queue", renderQueue(trimmed, status, nextCursor), user));
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
	return c.html(layout("Users", renderUsers(trimmed, q, nextCursor), user));
});

admin.get("/settings", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	return c.html(layout("Settings", renderSettings(c.env), user));
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

admin.post("/api/users/:id", async (c) => {
	const user = await requireAdmin(c);
	if (user instanceof Response) return user;
	const id = c.req.param("id");
	const body = await c.req.json<{ banned?: boolean }>().catch(() => null);
	if (!body || typeof body.banned !== "boolean") {
		return c.json({ error: "invalid_body" }, 400);
	}
	await setUserBanned(c.env.DB, id, body.banned);
	return c.json({ ok: true, id, banned: body.banned });
});

export { admin };
