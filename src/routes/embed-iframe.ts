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

iframe.get("/:slug", (c) => {
	const slug = c.req.param("slug");
	if (!slug || slug.length > 200) return c.text("invalid slug", 400);

	const url = new URL(c.req.url);
	const apiOverride = c.req.query("api");
	const apiBase = apiOverride && /^https?:\/\//i.test(apiOverride)
		? apiOverride
		: `${url.protocol}//${url.host}`;

	const title = c.req.query("title") ?? "";
	const pageUrl = c.req.query("url") ?? "";
	const theme = c.req.query("theme") ?? "auto";

	// CSP: the only third-party origin we contact is apiBase (for embed.js
	// and the API calls the widget makes from inside). frame-ancestors is
	// intentionally open — operators choose where this gets embedded.
	const apiOrigin = new URL(apiBase).origin;
	const csp = [
		"default-src 'none'",
		`script-src ${apiOrigin} 'unsafe-inline'`,
		`connect-src ${apiOrigin}`,
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
  var lastHeight = 0;
  var post = function () {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    if (h === lastHeight) return;
    lastHeight = h;
    window.parent.postMessage({ type: "garrul:height", height: h }, "*");
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
