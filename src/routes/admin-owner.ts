/**
 * Owner sign-in: redeems the single-use link `npm run owner-link` prints.
 *
 *   GET  /admin/owner         tiny static page; reads the token from the URL
 *                             fragment and POSTs it only when the button is
 *                             clicked. A GET never consumes anything, so link
 *                             previews and prefetchers cannot burn the token.
 *   GET  /admin/owner/app.js  the page's script (external, because the admin
 *                             CSP forbids inline scripts).
 *   POST /admin/owner         { token } -> session cookie.
 *
 * Mounted under the admin router, so its Origin check, CSP, X-Frame-Options,
 * no-store and Referrer-Policy apply. These routes are deliberately reachable
 * without a session; the token is the credential.
 *
 * Every failure answers the same body, so the response is no oracle for
 * "expired" vs "used" vs "wrong". Reasons go to the log (no token, no PII).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { getUser } from "../db/queries";
import { requireIpHash } from "../lib/ip-hash";
import { log } from "../lib/log";
import {
	OWNER_PROVIDER,
	OWNER_PROVIDER_ID,
	OWNER_TOKEN_RE,
	hashOwnerToken,
} from "../lib/owner-login";
import { checkRateLimit } from "../lib/ratelimit";
import { issueSession } from "../lib/session";

export const ownerLogin = new Hono<{ Bindings: Bindings }>();

const FAILED = { error: "sign_in_failed" };

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Owner sign-in</title>
<style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style>
</head><body>
<h1>Owner sign-in</h1>
<p id="msg">Sign in to the Garrul admin area as the owner.</p>
<button id="go" type="button" hidden>Sign in as owner</button>
<script src="/admin/owner/app.js"></script>
</body></html>`;

// Reads the token, scrubs the URL before anything else, and keeps the token
// in a closure variable only (no storage). POSTs on click, never on load.
const SCRIPT = `(function () {
  var m = /^t=([A-Za-z0-9_-]{43})$/.exec(location.hash.slice(1));
  var token = m ? m[1] : null;
  history.replaceState(null, "", location.pathname);
  var msg = document.getElementById("msg");
  var go = document.getElementById("go");
  var again = "This link is invalid, expired or already used. Run npm run owner-link for a new one.";
  if (!token) { msg.textContent = again; return; }
  go.hidden = false;
  go.addEventListener("click", function () {
    var t = token;
    token = null;
    go.disabled = true;
    fetch("/admin/owner", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t })
    }).then(function (r) {
      if (r.ok) { location.replace("/admin"); return; }
      go.hidden = true;
      msg.textContent = again;
    }).catch(function () {
      go.hidden = true;
      msg.textContent = again;
    });
  });
})();
`;

ownerLogin.get("/", (c) => c.html(PAGE));

ownerLogin.get("/app.js", (c) =>
	c.body(SCRIPT, 200, { "content-type": "text/javascript; charset=utf-8" }),
);

ownerLogin.post("/", async (c) => {
	const ipHash = await requireIpHash(c);
	if (ipHash instanceof Response) return ipHash;
	const rl = await checkRateLimit(c.req.url, ipHash, {
		scope: "owner-login",
		config: {
			short: { max: 3, windowSec: 10 },
			long: { max: 10, windowSec: 600 },
		},
		env: c.env,
	});
	if (!rl.ok) {
		log.warn("owner_login", { outcome: "rate_limited" });
		return c.json({ error: "rate_limited" }, 429);
	}

	const fail = (outcome: string) => {
		log.warn("owner_login", { outcome });
		return c.json(FAILED, 400);
	};

	const body = await c.req.json<{ token?: unknown }>().catch(() => null);
	const token = body?.token;
	if (typeof token !== "string" || !OWNER_TOKEN_RE.test(token)) {
		return fail("malformed");
	}

	// The whole single-use guarantee: one statement, so of two concurrent
	// redemptions exactly one sees a row come back.
	const now = Date.now();
	const row = await c.env.DB.prepare(
		`UPDATE owner_login_tokens SET used_at = ?
		  WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
		  RETURNING user_id`,
	)
		.bind(now, await hashOwnerToken(token), now)
		.first<{ user_id: string }>();
	if (!row) return fail("rejected");

	// Re-check the owner at redemption: a ban, erasure or demotion since the
	// link was issued must win over a still-valid token.
	const user = await getUser(c.env.DB, row.user_id);
	if (
		!user ||
		user.provider !== OWNER_PROVIDER ||
		user.provider_id !== OWNER_PROVIDER_ID ||
		user.is_banned ||
		user.erased_at !== null ||
		user.role !== "admin" ||
		!user.is_admin
	) {
		return fail("owner_disabled");
	}

	try {
		await issueSession(c, user.id);
	} catch (err) {
		// Token stays consumed on purpose; the operator issues another.
		log.error("owner_login", {
			outcome: "session_failed",
			error: err instanceof Error ? err.name : "unknown",
		});
		return c.json(FAILED, 400);
	}
	log.info("owner_login", { outcome: "ok" });
	return c.json({ ok: true });
});
