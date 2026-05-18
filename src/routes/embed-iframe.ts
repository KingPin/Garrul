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
