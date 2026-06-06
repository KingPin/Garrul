import type { User } from "../db/queries";
import type { UpdateInfo } from "../lib/version-check";
import { escapeHtml } from "./escape";
import { icon } from "./icons";
import { ADMIN_CSS, ALPINE_SRI, ALPINE_VERSION } from "./styles";

type NavLink = { href: string; label: string; icon: string };
type NavSection = { heading: string; links: NavLink[] };

// Build one sidebar section. The section heading renders only when the
// section has at least one visible link, so mods (who see an empty Manage /
// System section) don't get dangling headers. `active` adds a SEPARATE
// `class="... active"` attribute so the `href="..."` substrings the
// role-gating tests assert on stay byte-identical.
const renderNavSection = (
	section: NavSection,
	activePath: string | undefined,
): string => {
	if (section.links.length === 0) return "";
	const links = section.links
		.map((l) => {
			// The dashboard root ("/admin") is a prefix of every admin path, so it
			// must match exactly; all other links highlight on their sub-pages too
			// (e.g. /admin/users/:id keeps "Users" active) via a prefix match.
			const isActive =
				activePath !== undefined &&
				(l.href === "/admin"
					? activePath === "/admin"
					: activePath === l.href || activePath.startsWith(`${l.href}/`));
			return `<a href="${l.href}" class="nav-link${isActive ? " active" : ""}"
       ${isActive ? 'aria-current="page"' : ""}
       @click="navOpen = false">${icon(l.icon)}<span>${escapeHtml(l.label)}</span></a>`;
		})
		.join("");
	return `<div class="nav-section">
  <p class="nav-heading">${escapeHtml(section.heading)}</p>
  ${links}
</div>`;
};

const statusTitle = (status: 401 | 403 | 404): string => {
	if (status === 401) return "Sign in required";
	if (status === 403) return "Forbidden";
	return "Not found";
};

export const accessDeniedHtml = (
	status: 401 | 403 | 404,
	message: string,
): string => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${statusTitle(status)} — Garrul Admin</title>
<style>
  /* Light default; flip to dark on OS preference. Mirrors the admin theme
     tokens but standalone (this page renders before the app shell / Alpine,
     and the admin CSP forbids the usual inline no-FOUC script). */
  :root { --bg: #f6f8fa; --fg: #1b2733; --muted: #5c6b7a;
          --accent: #2563eb; --code-bg: #f0f3f6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0b0d10; --fg: #e7eaf0; --muted: #8a93a6;
            --accent: #6aa9ff; --code-bg: #1e2530; }
  }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         background: var(--bg); color: var(--fg); max-width: 480px;
         margin: 4rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { margin-top: 0; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  code { background: var(--code-bg); padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>${statusTitle(status)}</h1>
<p>${message}</p>
<p class="muted">Sign in through the comments widget on any page first, then refresh.
  Admins are auto-promoted on sign-in if their email is in
  <code>ADMIN_EMAILS</code>.</p>
</body>
</html>`;

export const renderUpdateBanner = (info: UpdateInfo | null): string => {
	if (!info || !info.behind) return "";
	const tag = escapeHtml(info.latest);
	const url = escapeHtml(info.url);
	const key = `garrul.dismissed.update.${info.latest}`;
	const keyLit = escapeHtml(JSON.stringify(key));
	return `
<div x-data="{ shown: localStorage.getItem(${keyLit}) !== '1' }"
     x-show="shown"
     class="banner update">
  <span>Update available: <strong>${tag}</strong> —
    <a href="${url}" target="_blank" rel="noopener">release notes</a>.
    Run <code>npm run upgrade</code>.</span>
  <button @click="localStorage.setItem(${keyLit},'1'); shown=false"
          aria-label="Dismiss update notice">Dismiss</button>
</div>`;
};

export type LayoutOpts = {
	usage_link?: boolean;
	/** Request path of the current page, used to highlight the active nav link. */
	activePath?: string;
};

export const layout = (
	title: string,
	body: string,
	currentUser: User,
	updateInfo: UpdateInfo | null,
	opts: LayoutOpts = {},
): string => {
	const isAdmin = currentUser.role === "admin";
	const rolePill =
		currentUser.role === "admin"
			? '<span class="pill admin">admin</span>'
			: currentUser.role === "mod"
				? '<span class="pill mod">mod</span>'
				: "";
	// Sidebar nav, grouped into sections. Mods see only Moderation (plus the
	// always-on About link) — every Manage/System surface requires admin
	// scope, so those sections come up empty for mods and renderNavSection
	// drops their headers. The Usage link further gates on whether
	// CF_API_TOKEN + CF_ACCOUNT_ID are configured (see opts.usage_link).
	const manageLinks: NavLink[] = isAdmin
		? [
				{ href: "/admin/users", label: "Users", icon: "users" },
				{
					href: "/admin/subscriptions",
					label: "Subscriptions",
					icon: "subscriptions",
				},
				{ href: "/admin/webhooks", label: "Webhooks", icon: "webhook" },
			]
		: [];
	const systemLinks: NavLink[] = isAdmin
		? [
				{ href: "/admin/audit", label: "Audit", icon: "audit" },
				...(opts.usage_link
					? [{ href: "/admin/usage", label: "Usage", icon: "usage" }]
					: []),
				{ href: "/admin/operator", label: "Operator", icon: "operator" },
				{ href: "/admin/settings", label: "Settings", icon: "settings" },
			]
		: [];
	const navSections: NavSection[] = [
		{
			heading: "Moderation",
			links: [
				{ href: "/admin", label: "Dashboard", icon: "dashboard" },
				{ href: "/admin/queue", label: "Queue", icon: "queue" },
				{ href: "/admin/saved-replies", label: "Replies", icon: "reply" },
			],
		},
		{ heading: "Manage", links: manageLinks },
		{ heading: "System", links: systemLinks },
		{
			heading: "Help",
			links: [{ href: "/admin/about", label: "About", icon: "about" }],
		},
	];
	const navHtml = navSections
		.map((s) => renderNavSection(s, opts.activePath))
		.join("\n");
	// The theme lives on <html> as data-theme. We can't use the usual inline
	// <head> script to set it before first paint (admin CSP forbids inline
	// <script>), so the CSS handles the no-JS case: :root is light and a
	// prefers-color-scheme block flips to dark, so the first paint already
	// respects the OS preference. Alpine then reconciles the stored choice on
	// x-init. localStorage key matches the renderUpdateBanner convention.
	return `
<!doctype html>
<html lang="en"
      x-data="{
        theme: localStorage.getItem('garrul.theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        helpOpen: false,
        navOpen: false,
        setTheme(t) { this.theme = t; localStorage.setItem('garrul.theme', t); document.documentElement.setAttribute('data-theme', t); }
      }"
      x-init="document.documentElement.setAttribute('data-theme', theme)"
      @keydown.window.slash.prevent="(() => { const el = document.querySelector('input[type=text],input[type=search]'); if (el) el.focus(); })()"
      @keydown.window.question-mark.prevent="helpOpen = !helpOpen"
      @keydown.window.escape="helpOpen = false">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Garrul Admin</title>
<style>${ADMIN_CSS}</style>
</head>
<body>
${renderUpdateBanner(updateInfo)}
<div class="app-shell">
  <div class="scrim" x-show="navOpen" x-cloak @click="navOpen = false"></div>
  <aside class="sidebar" :class="navOpen && 'open'">
    <a href="/admin" class="brand" @click="navOpen = false">${icon("queue", 22)}<span>Garrul</span></a>
    <nav class="sidebar-nav">
${navHtml}
    </nav>
    <div class="sidebar-footer">
      <span class="me">${escapeHtml(currentUser.name)} ${rolePill}</span>
      <span class="footer-actions">
        <button class="icon-btn" @click="setTheme(theme === 'dark' ? 'light' : 'dark')"
                :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
          <span x-show="theme === 'dark'">${icon("sun")}</span>
          <span x-show="theme !== 'dark'" x-cloak>${icon("moon")}</span>
        </button>
        <button class="icon-btn" @click="helpOpen = !helpOpen" aria-label="Keyboard shortcuts">?</button>
      </span>
    </div>
  </aside>
  <div class="content">
    <div class="topbar">
      <button class="icon-btn hamburger" @click="navOpen = !navOpen" aria-label="Toggle navigation">${icon("menu")}</button>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <main>
${body}
    </main>
  </div>
</div>
<div class="toast-tray" role="status" aria-live="polite" aria-atomic="true"
     x-data="{ items: [] }"
     @toast.window="items.push({ id: Date.now() + Math.random(), text: $event.detail.text, kind: $event.detail.kind || 'ok' }); setTimeout(() => { items.shift(); }, 4000)">
  <template x-for="t in items" :key="t.id">
    <div :class="'toast ' + t.kind" x-text="t.text"></div>
  </template>
</div>
<div class="help-popover" x-show="helpOpen" x-cloak @click.away="helpOpen = false" role="dialog" aria-label="Keyboard shortcuts">
  <h4 style="margin-top:0">Shortcuts</h4>
  <dl>
    <dt><kbd>/</kbd></dt><dd>Focus search</dd>
    <dt><kbd>?</kbd></dt><dd>Toggle this help</dd>
    <dt><kbd>Esc</kbd></dt><dd>Close help</dd>
  </dl>
</div>
<script src="https://cdn.jsdelivr.net/npm/alpinejs@${ALPINE_VERSION}/dist/cdn.min.js"
        integrity="${ALPINE_SRI}"
        crossorigin="anonymous"
        defer></script>
</body>
</html>`;
};
