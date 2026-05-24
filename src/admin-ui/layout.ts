import type { User } from "../db/queries";
import type { UpdateInfo } from "../lib/version-check";
import { escapeHtml } from "./escape";
import { ADMIN_CSS, ALPINE_SRI, ALPINE_VERSION } from "./styles";

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
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         background: #0b0d10; color: #e7eaf0; max-width: 480px;
         margin: 4rem auto; padding: 0 1rem; line-height: 1.55; }
  h1 { margin-top: 0; }
  a { color: #6aa9ff; }
  code { background: #1e2530; padding: 0.1rem 0.3rem; border-radius: 3px; }
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
	return `
<div x-data="{ shown: localStorage.getItem(${JSON.stringify(key)}) !== '1' }"
     x-show="shown"
     class="banner update">
  <span>Update available: <strong>${tag}</strong> —
    <a href="${url}" target="_blank" rel="noopener">release notes</a>.
    Run <code>npm run upgrade</code>.</span>
  <button @click="localStorage.setItem(${JSON.stringify(key)},'1'); shown=false"
          aria-label="Dismiss update notice">Dismiss</button>
</div>`;
};

export const layout = (
	title: string,
	body: string,
	currentUser: User,
	updateInfo: UpdateInfo | null,
): string => `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Garrul Admin</title>
<style>${ADMIN_CSS}</style>
</head>
<body>
${renderUpdateBanner(updateInfo)}
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
<script src="https://cdn.jsdelivr.net/npm/alpinejs@${ALPINE_VERSION}/dist/cdn.min.js"
        integrity="${ALPINE_SRI}"
        crossorigin="anonymous"
        defer></script>
</body>
</html>`;
