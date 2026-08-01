/**
 * /api/v1/auth/:provider/start    302 → provider authorize URL
 * /api/v1/auth/:provider/callback exchange code, upsert user, issue session
 * POST /api/v1/auth/signout       revoke KV session + clear cookie
 * GET  /api/v1/auth/me            current session user (or null)
 *
 * The callback returns a tiny self-closing HTML page that postMessages
 * `{type: "garrul:auth", ok: true}` to window.opener and closes. The widget
 * (src/widget/embed.ts) listens for that message to refresh state without
 * a page reload. If the popup is blocked, the start route is also reachable
 * top-level, in which case the callback redirects to `state.return_origin`.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import {
	PROVIDERS,
	buildAuthorizeUrl,
	callbackUrl,
	computeCodeChallenge,
	consumeHandoff,
	exchangeCodeForToken,
	genCodeVerifier,
	isProvider,
	issueHandoff,
	issueState,
	verifyState,
} from "../lib/oauth";
import { upsertOauthUser } from "../db/queries";
import {
	buildShortCookie,
	clearShortCookie,
	destroySession,
	issueSession,
	parseCookie,
	readSession,
	revokeSession,
} from "../lib/session";
import { writeEvent } from "../lib/analytics";
import { log } from "../lib/log";

// Per-flow cookie: holds the whole signed state payload (lib/oauth issueState).
// The name's suffix is the first 8 hex chars of the (48-hex-char) state token,
// which gives 32 bits of disambiguation between concurrent OAuth flows in the
// same browser. Without this, two tabs would clobber a single global cookie and
// only the most-recently-started flow could complete; the other tab's /callback
// would always fail with "invalid state". The full state is compared inside the
// signed payload, so the truncated name is only a bucket, never the check.
const OAUTH_BIND_COOKIE_PREFIX = "garrul_oauth_b_";
const OAUTH_BIND_TTL_SECONDS = 600;

// `state` is always 48 lowercase hex chars (randomState in lib/oauth). Check
// that on the way back in, *before* the value reaches bindCookieName: the first
// 8 chars land in a Set-Cookie **name**, where a `;` or `=` would let an
// unauthenticated caller append attributes to that header (a cookie-planting
// primitive), a control character would make the runtime reject the header
// outright, and an over-long value would just be a logged 500. verifyState
// catches a wrong state, but only after it has already been interpolated.
const STATE_RE = /^[0-9a-f]{48}$/;

const bindCookieName = (state: string): string =>
	`${OAUTH_BIND_COOKIE_PREFIX}${state.slice(0, 8)}`;

const auth = new Hono<{ Bindings: Bindings }>();

const parseAdminEmails = (raw: string | undefined): Set<string> => {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
};

const parseAllowedOrigins = (raw: string | undefined): Set<string> => {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
};

auth.get("/:provider/start", async (c) => {
	const provider = c.req.param("provider");
	if (!isProvider(provider)) return c.json({ error: "unknown_provider" }, 404);

	const cfg = PROVIDERS[provider];
	const env = c.env as unknown as Record<string, string | undefined>;
	const clientId = env[cfg.client_id_env];
	const clientSecret = env[cfg.client_secret_env];
	if (!clientId || !clientSecret) {
		return c.json({ error: "provider_not_configured" }, 503);
	}

	// `return` is where the widget wants us to deliver focus after the
	// popup closes (its top-level origin, e.g. the blog page). It must
	// match an entry in ALLOWED_ORIGINS — that's the same allowlist the
	// cross-site API origin gate uses, so dev workflows already populate
	// it (e.g. ALLOWED_ORIGINS="http://localhost:5173"). No ENV=dev
	// bypass: a wide-open postMessage target is a real footgun even
	// locally.
	const rawReturn = c.req.query("return") ?? "";
	const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
	let return_origin = "";
	try {
		const u = new URL(rawReturn);
		const candidate = u.origin;
		if (allowed.has(candidate)) {
			return_origin = candidate;
		}
	} catch {
		// rawReturn was malformed; leave return_origin empty.
	}

	// PKCE: providers that require it (X/Twitter) get a per-flow verifier and
	// an S256 challenge in the authorize redirect. Non-PKCE providers
	// (GitHub/Google/Facebook/Discord) skip this entirely.
	const code_verifier = cfg.pkce ? genCodeVerifier() : undefined;
	const code_challenge = code_verifier
		? await computeCodeChallenge(code_verifier)
		: undefined;

	// The flow's entire state is a signed payload in a per-flow cookie — no
	// server-side write, which is what stops this unauthenticated route from
	// being an account-wide KV-quota exhaustion primitive (see issueState).
	// The cookie is also what binds the flow to THIS browser: an attacker can
	// mint state+code in their own session but cannot plant the matching
	// cookie in a victim's browser, so they can't trick the victim into
	// completing the callback and landing on the attacker's session
	// (RFC 6749 §10.12 login-CSRF).
	const { state, token } = await issueState(c.env.JWT_SECRET, {
		provider,
		return_origin,
		...(code_verifier ? { code_verifier } : {}),
	});

	c.header(
		"Set-Cookie",
		buildShortCookie(
			bindCookieName(state),
			token,
			OAUTH_BIND_TTL_SECONDS,
			c.env,
		),
		{ append: true },
	);

	const redirect = callbackUrl(c.env, c.req.url, provider);
	const url = buildAuthorizeUrl(
		provider,
		clientId,
		redirect,
		state,
		code_challenge,
	);
	writeEvent(c.env.ANALYTICS, "oauth.start", { provider });
	return c.redirect(url, 302);
});

const finishHtml = (
	return_origin: string,
	ok: boolean,
	msg = "",
	handoff: string | null = null,
): string => {
	// When return_origin wasn't validated against ALLOWED_ORIGINS (e.g. the
	// caller didn't pass `?return=` or passed an unrecognized origin), we
	// have no safe target to postMessage to. Previously we fell back to
	// `targetOrigin="*"` which leaks the auth-completion message to whatever
	// happens to be the opener. Render a static page instead — the popup
	// closes itself and the parent infers state via /auth/me on focus.
	if (!return_origin) {
		return `<!doctype html>
<html><head><meta charset="utf-8"><title>Garrul</title></head>
<body>
<p>${ok ? "Signed in. You can close this window." : "Sign-in failed."}</p>
<script>setTimeout(function(){ window.close(); }, 250);</script>
</body></html>`;
	}
	// return_origin is a validated, allow-listed string here; JSON.stringify
	// emits it as a safe JS string literal. `handoff` is a 48-hex-char token
	// minted by issueHandoff and consumed by /session/exchange; the widget
	// uses it to materialize a session cookie in its own (embedder) CHIPS
	// partition — the popup's Set-Cookie is partitioned to comments.* and
	// can't be read by the embedder iframe.
	const payload = JSON.stringify({
		type: "garrul:auth",
		ok,
		message: msg,
		handoff,
	});
	const targetOrigin = JSON.stringify(return_origin);
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Garrul</title></head>
<body>
<p>${ok ? "Signed in. You can close this window." : "Sign-in failed."}</p>
<script>
(function() {
	try {
		if (window.opener && !window.opener.closed) {
			window.opener.postMessage(${payload}, ${targetOrigin});
		}
	} catch (e) {}
	setTimeout(function(){ window.close(); }, 250);
})();
</script>
</body></html>`;
};

auth.get("/:provider/callback", async (c) => {
	const provider = c.req.param("provider");
	if (!isProvider(provider)) return c.text("unknown_provider", 404);

	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) return c.text("missing code/state", 400);
	// Same generic message verifyState failures get — a malformed state is not
	// worth a distinguishable answer.
	if (!STATE_RE.test(state)) return c.text("invalid state", 400);

	// The signed payload lives in this flow's cookie. verifyState checks the
	// signature, the 10-minute age bound, the provider, and — in constant
	// time — that the payload is bound to the `state` the provider echoed
	// back. One generic error for every failure: don't tell the attacker
	// which check tripped.
	const cookieName = bindCookieName(state);
	const stateToken = parseCookie(c.req.header("cookie"), cookieName);
	const payload = stateToken
		? await verifyState(c.env.JWT_SECRET, stateToken, { provider, state })
		: null;
	if (!payload) {
		c.header("Set-Cookie", clearShortCookie(cookieName, c.env), {
			append: true,
		});
		return c.text("invalid state", 400);
	}

	// Clear this flow's cookie on every path past this point — that clear is
	// what makes the state single-use now that nothing is consumed from
	// storage. Other concurrent flows' cookies are scoped to their own state
	// suffix and remain intact.
	c.header("Set-Cookie", clearShortCookie(cookieName, c.env), {
		append: true,
	});

	const cfg = PROVIDERS[provider];
	const env = c.env as unknown as Record<string, string | undefined>;
	const clientId = env[cfg.client_id_env];
	const clientSecret = env[cfg.client_secret_env];
	if (!clientId || !clientSecret) {
		return c.text("provider_not_configured", 503);
	}

	const redirect = callbackUrl(c.env, c.req.url, provider);

	let accessToken: string;
	try {
		accessToken = await exchangeCodeForToken(
			provider,
			code,
			clientId,
			clientSecret,
			redirect,
			payload.code_verifier,
		);
	} catch (err) {
		log.error("oauth.token", { provider, error: String(err) });
		writeEvent(c.env.ANALYTICS, "oauth.failed", { provider, outcome: "token_exchange" });
		return c.html(finishHtml(payload.return_origin, false, "token_exchange_failed"));
	}

	let profile: Awaited<ReturnType<typeof cfg.fetch_profile>>;
	try {
		profile = await cfg.fetch_profile(accessToken);
	} catch (err) {
		log.error("oauth.profile", { provider, error: String(err) });
		writeEvent(c.env.ANALYTICS, "oauth.failed", { provider, outcome: "profile_fetch" });
		return c.html(finishHtml(payload.return_origin, false, "profile_fetch_failed"));
	}

	const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);
	const user = await upsertOauthUser(
		c.env.DB,
		provider,
		profile.provider_id,
		profile.name,
		profile.email,
		profile.avatar_url,
		adminEmails,
	);

	if (user.is_banned) {
		return c.html(finishHtml(payload.return_origin, false, "banned"));
	}

	// Revoke any session the browser already holds before minting a new one,
	// so re-login (a common "I might be compromised" remediation) doesn't leave
	// the previous sid live and replayable in KV for its full TTL.
	await revokeSession(c);
	await issueSession(c, user.id);
	// Same user_id is also reachable via the handoff token below. The popup
	// Set-Cookie above is what works on same-eTLD+1 embeds; the handoff is
	// what works for cross-site embeds whose CHIPS partition the popup can't
	// reach.
	const handoff = await issueHandoff(c.env.OAUTH_STATE, user.id);
	writeEvent(c.env.ANALYTICS, "oauth.complete", { provider });

	c.header("content-type", "text/html; charset=utf-8");
	return c.body(finishHtml(payload.return_origin, true, "", handoff));
});

auth.post("/signout", async (c) => {
	await destroySession(c);
	return c.json({ ok: true });
});

// Exchange a one-time handoff token (minted at the tail of /callback) for a
// real session cookie. The widget calls this from its embedder context so the
// Set-Cookie lands in that context's CHIPS partition — see the handoff
// helpers in src/lib/oauth.ts for the rationale.
auth.post("/session/exchange", async (c) => {
	let parsed: unknown;
	try {
		parsed = await c.req.json();
	} catch {
		return c.json({ error: "err.token.bad" }, 400);
	}
	const token =
		parsed && typeof parsed === "object" && "token" in parsed
			? (parsed as { token: unknown }).token
			: undefined;
	if (typeof token !== "string" || !token) {
		return c.json({ error: "err.token.bad" }, 400);
	}
	const userId = await consumeHandoff(c.env.OAUTH_STATE, token);
	if (!userId) return c.json({ error: "err.token.invalid" }, 400);
	// Same reason /callback does it two functions up: without this, the sid this
	// browser already holds stays live and replayable in KV for its full 30 days,
	// so "sign out everywhere by signing in again" silently failed for every
	// widget user — which is the only path that reaches this route.
	await revokeSession(c);
	await issueSession(c, userId);
	return c.json({ ok: true });
});

auth.get("/me", async (c) => {
	const session = await readSession(c);
	if (!session) return c.json({ user: null });
	const u = await c.env.DB
		.prepare(
			`SELECT id, provider, name, email, avatar_url, is_admin, role
			 FROM users WHERE id = ?`,
		)
		.bind(session.user_id)
		.first<{
			id: string;
			provider: string;
			name: string;
			email: string | null;
			avatar_url: string | null;
			is_admin: number;
			role: string | null;
		}>();
	if (!u) return c.json({ user: null });
	const role: "user" | "mod" | "admin" =
		u.role === "mod" || u.role === "admin" ? u.role : "user";
	return c.json({
		user: {
			id: u.id,
			provider: u.provider,
			name: u.name,
			email: u.email,
			avatar_url: u.avatar_url,
			is_admin: u.is_admin === 1,
			role,
		},
	});
});

export { auth };
