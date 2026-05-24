/**
 * GET /embed/:slug — iframe-friendly comment page.
 *
 * Operators who can't (or don't want to) drop a <script> on their page
 * use an <iframe> pointing at this URL instead. The page hosts the same
 * embed.js widget but auto-reports its content height to window.parent
 * via postMessage so the iframe can resize without scrollbars.
 *
 * The protocol is intentionally tiny — one message shape, no library:
 *   { type: "garrul:height", height: <px> }
 *
 * Parent pages embed a ~10-line listener (see examples/iframe/index.html)
 * that sets iframe.style.height on receipt. We avoid shipping
 * iframe-resizer.js (~30KB and a maintenance liability) since we own
 * both ends of the channel.
 *
 * Query params (all optional):
 *   ?api=https://comments.example.com — override the API origin (default:
 *     same origin as this route, which is the common case)
 *   ?title=...                        — passed through to data-title
 *   ?url=...                          — passed through to data-url
 *   ?theme=light|dark|auto            — host-page theme hint
 *
 * Strings flowing into the HTML body are escaped (JSON.stringify for JS
 * literals, attribute escape for data-* values) so query params can't
 * inject markup.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";

const iframe = new Hono<{ Bindings: Bindings }>();

const escapeAttr = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

const allowedOriginSet = (env: Bindings): Set<string> => {
	const list = (env.ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return new Set(list);
};

const safeApiOrigin = (raw: string): string | null => {
	if (!/^https?:\/\//i.test(raw)) return null;
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
};

/**
 * GET /embed/turnstile-frame — same-origin host for the Turnstile widget.
 *
 * Why this exists: Cloudflare's api.js fingerprints the rendered element by
 * walking parentNode and calling `.tagName.toLowerCase()`. When the widget is
 * inside a Shadow DOM (Garrul's default mount), that walk eventually hits the
 * ShadowRoot, whose `tagName` is undefined — api.js crashes with the exact
 * "Cannot read properties of undefined (reading 'toLowerCase')" the host
 * console reports, and the widget never paints.
 *
 * We sidestep the shadow boundary by mounting Turnstile inside this iframe,
 * served from the Worker's own origin. The widget renders in light DOM here,
 * the parent-chain walk terminates at <body>, and the token comes back to
 * the parent script via postMessage.
 *
 * Wire protocol (all messages namespaced `garrul:`):
 *   iframe → parent:
 *     { type: "garrul:turnstile-token",    token: string }
 *     { type: "garrul:turnstile-expired" }
 *     { type: "garrul:turnstile-error" }
 *   parent → iframe:
 *     { type: "garrul:turnstile-reset" }
 *
 * Query params:
 *   ?parent_origin=...   — required for safe postMessage target (falls back
 *                          to document.referrer's origin)
 *   ?theme=light|dark|auto — passed through to Turnstile's render opts
 *
 * The site key is read from env at render time, never from a query param —
 * callers can't ask us to render someone else's site key with our origin's
 * referer.
 */
iframe.get("/turnstile-frame", (c) => {
	const siteKey = c.env.TURNSTILE_SITE_KEY ?? "";
	if (!siteKey) return c.text("turnstile not configured", 404);

	const parentOriginRaw = c.req.query("parent_origin");
	const parentOrigin =
		parentOriginRaw && safeApiOrigin(parentOriginRaw) === parentOriginRaw
			? parentOriginRaw
			: "";

	const themeRaw = c.req.query("theme") ?? "auto";
	const theme =
		themeRaw === "light" || themeRaw === "dark" || themeRaw === "auto"
			? themeRaw
			: "auto";

	// connect-src needs 'self' because Turnstile redeems clearance via the
	// page's own /cdn-cgi/challenge-platform/h/b/rc/... endpoint, which CF
	// serves at the iframe origin (not challenges.cloudflare.com). Without
	// it, api.js logs "Error contacting Turnstile, aborting clearance
	// redemption" and never produces a token.
	const csp = [
		"default-src 'none'",
		`script-src ${TURNSTILE_ORIGIN} 'unsafe-inline'`,
		`connect-src 'self' ${TURNSTILE_ORIGIN}`,
		`frame-src ${TURNSTILE_ORIGIN}`,
		"style-src 'unsafe-inline'",
	].join("; ");

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Anti-spam check</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; color-scheme: light dark; }
  #ts { display: inline-block; }
</style>
</head>
<body>
<div id="ts" class="cf-turnstile"></div>
<script src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js?onload=__gr_onload&render=explicit" async defer></script>
<script>
(function () {
  var parentOrigin = ${JSON.stringify(parentOrigin)};
  if (!parentOrigin) {
    try { if (document.referrer) parentOrigin = new URL(document.referrer).origin; } catch (_) {}
  }
  if (!parentOrigin || window.parent === window) return;
  var post = function (msg) { window.parent.postMessage(msg, parentOrigin); };
  var sitekey = ${JSON.stringify(siteKey)};
  var theme = ${JSON.stringify(theme)};
  var box = document.getElementById("ts");
  var widgetId = null;
  window.__gr_onload = function () {
    if (!window.turnstile || !window.turnstile.render) {
      post({ type: "garrul:turnstile-error" });
      return;
    }
    try {
      widgetId = window.turnstile.render(box, {
        sitekey: sitekey,
        theme: theme,
        callback: function (token) { post({ type: "garrul:turnstile-token", token: token }); },
        "error-callback": function () { post({ type: "garrul:turnstile-error" }); },
        "expired-callback": function () { post({ type: "garrul:turnstile-expired" }); }
      });
    } catch (e) {
      post({ type: "garrul:turnstile-error" });
    }
  };
  window.addEventListener("message", function (e) {
    if (e.origin !== parentOrigin) return;
    var d = e.data;
    if (!d || d.type !== "garrul:turnstile-reset") return;
    if (widgetId !== null && window.turnstile && window.turnstile.reset) {
      try { window.turnstile.reset(widgetId); } catch (_) {}
    }
  });
  // api.js may fail to load entirely (network, host CSP blocks the script tag
  // when this iframe is itself embedded under a strict-CSP host frame-src list).
  // Surface that as an error so the parent can show a friendly message instead
  // of a silently blank iframe.
  setTimeout(function () {
    if (!window.turnstile) post({ type: "garrul:turnstile-error" });
  }, 8000);
})();
</script>
</body>
</html>`;

	c.header("content-type", "text/html; charset=utf-8");
	c.header("content-security-policy", csp);
	c.header("x-content-type-options", "nosniff");
	c.header("referrer-policy", "no-referrer");
	c.header("cache-control", "public, max-age=300");
	return c.body(html);
});

iframe.get("/:slug", (c) => {
	const slug = c.req.param("slug");
	if (!slug || slug.length > 200) return c.text("invalid slug", 400);

	const url = new URL(c.req.url);
	const selfOrigin = `${url.protocol}//${url.host}`;
	// `?api=` lets operators point at a different Worker, but the override
	// must be in ALLOWED_ORIGINS — otherwise an attacker could craft a link
	// that loads attacker-controlled JS into the iframe (which we'd then
	// allow via the CSP we build below).
	const apiOverrideRaw = c.req.query("api");
	const overrideOrigin = apiOverrideRaw ? safeApiOrigin(apiOverrideRaw) : null;
	const allowed = allowedOriginSet(c.env);
	const apiBase =
		overrideOrigin && allowed.has(overrideOrigin)
			? overrideOrigin
			: selfOrigin;

	const title = c.req.query("title") ?? "";
	const pageUrl = c.req.query("url") ?? "";
	const theme = c.req.query("theme") ?? "auto";

	// Validate parent_origin for the postMessage target (prefer query param,
	// fall back to document.referrer's origin on the client). Caller can pass
	// e.g. ?parent_origin=https://yourblog.example.com.
	const parentOriginRaw = c.req.query("parent_origin");
	const parentOrigin =
		parentOriginRaw && safeApiOrigin(parentOriginRaw) === parentOriginRaw
			? parentOriginRaw
			: "";

	// CSP: third-party origins we contact are apiBase (embed.js + API calls)
	// and Turnstile (anonymous bot check). frame-ancestors is intentionally
	// open — operators choose where this gets embedded.
	const apiOrigin = apiBase;
	const csp = [
		"default-src 'none'",
		`script-src ${apiOrigin} ${TURNSTILE_ORIGIN} 'unsafe-inline'`,
		`connect-src ${apiOrigin} ${TURNSTILE_ORIGIN}`,
		`frame-src ${TURNSTILE_ORIGIN}`,
		"style-src 'unsafe-inline'",
		"img-src data: https:",
		"font-src data:",
	].join("; ");

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comments</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
</style>
</head>
<body>
<div
  id="garrul"
  data-slug="${escapeAttr(slug)}"
  data-api="${escapeAttr(apiBase)}"
  data-title="${escapeAttr(title)}"
  data-url="${escapeAttr(pageUrl)}"
  data-theme="${escapeAttr(theme)}"
></div>
<script src="${escapeAttr(apiBase)}/embed.js"></script>
<script>
(function () {
  if (window.parent === window) return;
  var parentOrigin = ${JSON.stringify(parentOrigin)};
  if (!parentOrigin) {
    // Derive from document.referrer (only set if the parent navigated us here,
    // which is the common case). Wildcard is intentionally NOT used as a
    // fallback — we'd rather not post than post to anyone.
    try {
      if (document.referrer) parentOrigin = new URL(document.referrer).origin;
    } catch (_) {}
  }
  if (!parentOrigin) return;
  var lastHeight = 0;
  var post = function () {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    if (h === lastHeight) return;
    lastHeight = h;
    window.parent.postMessage({ type: "garrul:height", height: h }, parentOrigin);
  };
  // Initial + ResizeObserver covers most cases. MutationObserver catches
  // Shadow DOM widget updates that don't trigger a body resize (e.g. the
  // skeleton-to-tree swap, which can shrink the page).
  var ro = new ResizeObserver(post);
  ro.observe(document.body);
  var mo = new MutationObserver(post);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("load", post);
  setTimeout(post, 100);
})();
</script>
</body>
</html>`;

	c.header("content-type", "text/html; charset=utf-8");
	c.header("content-security-policy", csp);
	c.header("x-content-type-options", "nosniff");
	c.header("referrer-policy", "no-referrer");
	c.header("cache-control", "public, max-age=300");
	return c.body(html);
});

export { iframe };
