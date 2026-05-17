/**
 * /api/v1/auth/:provider/start    302 → provider authorize URL
 * /api/v1/auth/:provider/callback exchange code, upsert user, issue session
 * POST /api/v1/auth/signout       clear session cookie
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
	consumeState,
	exchangeCodeForToken,
	isProvider,
	issueState,
} from "../lib/oauth";
import { upsertOauthUser } from "../db/queries";
import { clearSession, issueSession, readSession } from "../lib/session";

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
	// popup closes (its top-level origin, e.g. the blog page).
	const rawReturn = c.req.query("return") ?? "";
	const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
	let return_origin = "";
	try {
		const u = new URL(rawReturn);
		const candidate = u.origin;
		if (allowed.has(candidate) || env.ENV === "dev") {
			return_origin = candidate;
		}
	} catch {
		// rawReturn was malformed; leave return_origin empty.
	}

	const state = await issueState(c.env.OAUTH_STATE, {
		provider,
		return_origin,
		created_at: Date.now(),
	});

	const redirect = callbackUrl(c.env, c.req.url, provider);
	const url = buildAuthorizeUrl(provider, clientId, redirect, state);
	return c.redirect(url, 302);
});

const finishHtml = (return_origin: string, ok: boolean, msg = ""): string => {
	// Inline HTML — no user-controlled data flows into the HTML body. The
	// JSON.stringify calls ensure the only dynamic pieces (return_origin /
	// msg) are emitted as safe JS string literals.
	const payload = JSON.stringify({
		type: "garrul:auth",
		ok,
		message: msg,
	});
	const targetOrigin = JSON.stringify(return_origin || "*");
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

	const payload = await consumeState(c.env.OAUTH_STATE, state);
	if (!payload || payload.provider !== provider) {
		return c.text("invalid state", 400);
	}

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
		);
	} catch (err) {
		console.error(JSON.stringify({ level: "error", msg: "oauth.token", provider, error: String(err) }));
		return c.html(finishHtml(payload.return_origin, false, "token_exchange_failed"));
	}

	let profile: Awaited<ReturnType<typeof cfg.fetch_profile>>;
	try {
		profile = await cfg.fetch_profile(accessToken);
	} catch (err) {
		console.error(JSON.stringify({ level: "error", msg: "oauth.profile", provider, error: String(err) }));
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

	await issueSession(c, user.id);

	c.header("content-type", "text/html; charset=utf-8");
	return c.body(finishHtml(payload.return_origin, true));
});

auth.post("/signout", async (c) => {
	clearSession(c);
	return c.json({ ok: true });
});

auth.get("/me", async (c) => {
	const session = await readSession(c);
	if (!session) return c.json({ user: null });
	const u = await c.env.DB
		.prepare(
			`SELECT id, provider, name, email, avatar_url, is_admin
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
		}>();
	if (!u) return c.json({ user: null });
	return c.json({
		user: {
			id: u.id,
			provider: u.provider,
			name: u.name,
			email: u.email,
			avatar_url: u.avatar_url,
			is_admin: u.is_admin === 1,
		},
	});
});

export { auth };
