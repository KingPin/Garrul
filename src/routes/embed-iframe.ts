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
 *   ?lang=de                          — locale for the widget inside the frame.
 *     Lands on both <html lang> and data-lang: the first is what assistive tech
 *     and the browser's own UI read, the second is what the widget negotiates
 *     with. Unvalidated here on purpose — the server whitelists it against the
 *     locale registry when the widget asks for its strings, and an unknown tag
 *     falls back to English there. This route only has to keep it from escaping
 *     its attribute, which escapeAttr does.
 *
 * The page is cached for 5 minutes, which is safe because every one of these
 * params is part of the URL and therefore part of the cache key.
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
 * Origins permitted to frame /embed/* and to receive its postMessages.
 *
 * ALLOWED_ORIGINS plus the Worker's own origin. Own-origin is load-bearing, not
 * a courtesy: the widget running *inside* /embed/:slug creates the Turnstile
 * frame with `parent_origin = window.location.origin`, which there is this
 * Worker rather than the host site, and operators do not list their own
 * instance in ALLOWED_ORIGINS.
 */
const frameableOrigins = (env: Bindings, selfOrigin: string): Set<string> => {
	const set = allowedOriginSet(env);
	set.add(selfOrigin);
	return set;
};

/**
 * The postMessage target for the framing page, or "" to stay silent.
 *
 * Being a well-formed origin used to be the whole check. That let any site
 * frame /embed/turnstile-frame with `?parent_origin=https://attacker.example`
 * and receive a Turnstile token minted against the operator's site key — a
 * harvestable anti-spam bypass for that instance. The client-side
 * `document.referrer` fallback was the same hole without even needing the query
 * param, so it is gone from both pages; the widget and the documented iframe
 * snippet have always passed the param explicitly.
 */
const safeParentOrigin = (
	env: Bindings,
	selfOrigin: string,
	raw: string | undefined,
): string => {
	if (!raw) return "";
	// Reject anything that isn't already a bare origin, so the string we hand
	// the page is exactly what the browser will compare `e.origin` against.
	if (safeApiOrigin(raw) !== raw) return "";
	// Mirrors lib/cors.ts, which also waives the origin gate under ENV=dev — a
	// local instance typically has no ALLOWED_ORIGINS configured at all.
	if (env.ENV === "dev") return raw;
	return frameableOrigins(env, selfOrigin).has(raw) ? raw : "";
};

/**
 * The frame-ancestors directive for the two framable /embed/* routes.
 *
 * Omitting it is not the same as inheriting default-src: frame-ancestors has no
 * fallback, so `default-src 'none'` did nothing to stop framing and these pages
 * were embeddable anywhere. X-Frame-Options cannot express an allowlist —
 * ALLOW-FROM is dead in every current browser — so this is the only mechanism
 * available, and it reuses the list an operator already maintains.
 */
const frameAncestors = (env: Bindings, selfOrigin: string): string => {
	if (env.ENV === "dev") return "frame-ancestors *";
	return `frame-ancestors ${[...frameableOrigins(env, selfOrigin)].join(" ")}`;
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
 *     { type: "garrul:turnstile-error",    code?: string }
 *     { type: "garrul:turnstile-ready" }
 *     { type: "garrul:turnstile-interactive" }
 *   parent → iframe:
 *     { type: "garrul:turnstile-reset" }
 *
 * `code` on the error message is Turnstile's own error code, and it is present
 * on exactly one of the four things that post that message: `error-callback`.
 * The other three — api.js absent, `render()` throwing, the load watchdog — mean
 * the frame never came up, and they stay code-less on purpose. That is the
 * signal the parent uses to decide whether a retry could possibly help: a
 * code-less error latches the composer, a code is looked up against the
 * retryable families (see src/widget/turnstile-gate.ts). Old cached copies of
 * this document send no code at all, so version skew degrades to the latching
 * behavior that predates the retry — never to a blind retry loop.
 *
 * `reset` is the *only* thing that re-arms a failed challenge: the render call
 * below turns Turnstile's own `retry: "auto"` off, so every recovery is one the
 * parent asked for and spent budget on. Note the one exception the parent can't
 * suppress — `refresh-expired` is still `auto`, so an expiring token
 * re-challenges on its own and arrives as `expired`, not as an error.
 *
 * `ready` and `interactive` exist because the parent defers this frame's mount
 * until the visitor focuses the composer, and then has to decide what to say
 * when a submit is waiting on a token that hasn't arrived. Without them, "the
 * challenge is waiting for a human to click" and "the frame never executed"
 * are both indistinguishable silence:
 *
 *   - `ready` fires once render() returns, proving api.js loaded and the
 *     widget painted. A parent that has seen it knows a later silence means
 *     the challenge is waiting on the visitor, not broken.
 *   - `interactive` fires when a token isn't coming without something else
 *     happening first — either before the challenge enters interactive mode,
 *     or when a challenge timed out and Turnstile reset it. Both map to one
 *     message: stop waiting, tell the visitor to complete the check. The
 *     timeout case is the looser of the two — it doesn't strictly imply
 *     there's something on screen to click — so the copy can be slightly off
 *     there. It self-corrects: Turnstile re-runs after a reset, so a token
 *     usually arrives and the next attempt goes through.
 *
 * Neither is required for correctness — a parent that never receives them
 * falls back to its own timeout — so an old cached copy of this document
 * paired with a new parent script degrades to vaguer copy, not a broken
 * composer. That matters: this route is served with max-age=300.
 *
 * Query params:
 *   ?parent_origin=...   — required. Must be in ALLOWED_ORIGINS (or be this
 *                          Worker's own origin); anything else gets no
 *                          postMessage at all. There is no referrer fallback.
 *   ?theme=light|dark|auto — passed through to Turnstile's render opts
 *
 * The site key is read from env at render time, never from a query param —
 * callers can't ask us to render someone else's site key with our origin's
 * referer.
 */
iframe.get("/turnstile-frame", (c) => {
	const siteKey = c.env.TURNSTILE_SITE_KEY ?? "";
	if (!siteKey) return c.text("turnstile not configured", 404);

	const frameUrl = new URL(c.req.url);
	const parentOrigin = safeParentOrigin(
		c.env,
		`${frameUrl.protocol}//${frameUrl.host}`,
		c.req.query("parent_origin"),
	);

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
		frameAncestors(c.env, `${frameUrl.protocol}//${frameUrl.host}`),
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
  // No referrer fallback: an origin the operator hasn't allowlisted gets no
  // token, and a token is what makes this frame worth attacking.
  var parentOrigin = ${JSON.stringify(parentOrigin)};
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
        // Turnstile's default is retry:"auto" — it silently re-runs a failed
        // challenge every 8s on its own. That would make the parent's one-shot
        // retry budget (src/widget/turnstile-gate.ts) meaningless: a single
        // outage lasting past one interval fires error-callback twice, spends
        // the budget on the first and latches on the second, all while
        // Turnstile was still recovering. Cloudflare documents "never" for
        // exactly this case — an app with its own retry logic. The parent's
        // reset is now the only thing that re-arms the challenge, so what the
        // docs describe is what actually happens.
        retry: "never",
        callback: function (token) { post({ type: "garrul:turnstile-token", token: token }); },
        // Forward the code: it is the only thing that tells the parent a
        // transient blip apart from a misconfigured sitekey. See the wire
        // protocol above for why the other error posts stay code-less.
        "error-callback": function (code) { post({ type: "garrul:turnstile-error", code: String(code || "") }); },
        "expired-callback": function () { post({ type: "garrul:turnstile-expired" }); },
        // Both mean "no token is coming until something else happens": one
        // fires before the challenge turns interactive, the other when a
        // challenge timed out and Turnstile reset it. The parent treats them
        // alike; see the wire protocol above for why the shared copy is a
        // slightly loose fit for the timeout case.
        "before-interactive-callback": function () { post({ type: "garrul:turnstile-interactive" }); },
        "timeout-callback": function () { post({ type: "garrul:turnstile-interactive" }); }
      });
      // render() returned, so api.js is loaded and the widget painted. Tells
      // the parent that any later silence is the challenge waiting on the
      // visitor rather than a frame that never came up.
      post({ type: "garrul:turnstile-ready" });
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
  //
  // The parent mirrors this budget with its own cap (TURNSTILE_WAIT_MS in
  // src/widget/turnstile-gate.ts), deliberately set a little higher so this
  // watchdog — which can tell "api.js never arrived" from "the challenge is
  // waiting on a click" — wins the race and produces the better message. Move
  // one and you must move the other.
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
	// Turnstile's bundle probes for sensor features. Without explicit grants
	// the browser default denies them in cross-origin iframes and logs a
	// Permissions-Policy violation per probe. The widget's iframe element
	// also sets a matching allow=, but we set the header here too so the
	// policy is unambiguous when the iframe is opened directly.
	c.header(
		"permissions-policy",
		"xr-spatial-tracking=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)",
	);
	// no-transform tells Cloudflare's edge to skip HTML transformations
	// (RUM beacon injection, Auto-Minify, Polish, etc.). Without it, the
	// edge inserts cloudflareinsights.com/beacon.min.js into the <head>,
	// which our strict CSP then blocks and logs to the console.
	c.header("cache-control", "public, max-age=300, no-transform");
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
	const lang = c.req.query("lang") ?? "";

	// The postMessage target for the height protocol. Must be allowlisted —
	// see safeParentOrigin. Callers pass ?parent_origin=https://yourblog.example.
	const parentOrigin = safeParentOrigin(
		c.env,
		selfOrigin,
		c.req.query("parent_origin"),
	);

	// CSP: third-party origins we contact are apiBase (embed.js + API calls)
	// and Turnstile (anonymous bot check). frame-ancestors pins who may frame
	// this page to the same list the API already gates on.
	const apiOrigin = apiBase;
	const csp = [
		"default-src 'none'",
		`script-src ${apiOrigin} ${TURNSTILE_ORIGIN} 'unsafe-inline'`,
		`connect-src ${apiOrigin} ${TURNSTILE_ORIGIN}`,
		`frame-src ${TURNSTILE_ORIGIN}`,
		"style-src 'unsafe-inline'",
		"img-src data: https:",
		"font-src data:",
		frameAncestors(c.env, selfOrigin),
	].join("; ");

	const html = `<!doctype html>
<html lang="${escapeAttr(lang || "en")}">
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
  data-lang="${escapeAttr(lang)}"
></div>
<script src="${escapeAttr(apiBase)}/embed.js"></script>
<script>
(function () {
  if (window.parent === window) return;
  // No referrer fallback and no wildcard: an origin the operator hasn't
  // allowlisted gets no message at all.
  var parentOrigin = ${JSON.stringify(parentOrigin)};
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
	// Match the turnstile-frame route — same rationale: keep CF's edge
	// from injecting RUM beacons that our CSP then blocks.
	c.header("cache-control", "public, max-age=300, no-transform");
	return c.body(html);
});

export { iframe };
