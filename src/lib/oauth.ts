/**
 * OAuth2 authorization-code flow for GitHub, Google, Facebook, X, Discord.
 *
 * Flow:
 *   1. Widget opens a popup at /api/v1/auth/:provider/start?return=<origin>.
 *   2. We generate a random `state`, put an HMAC-signed payload carrying it
 *      into a per-flow HttpOnly cookie, and 302 to the provider's authorize
 *      URL. No server-side storage.
 *   3. Provider redirects to /api/v1/auth/:provider/callback?code&state.
 *   4. We verify the cookie's signature and that it is bound to this `state`,
 *      clear the cookie (single use), exchange `code` for an access token,
 *      fetch the
 *      user profile, upsert into `users` (provider + provider_id),
 *      issue a session cookie (lib/session.ts), and render a tiny HTML
 *      page that postMessages back to the opener and closes.
 *
 * Callback URL config:
 *   OAUTH_CALLBACK_BASE env var (e.g. "https://comments.garrul.com").
 *   Falls back to the request origin when unset — useful for dev.
 *
 * Why state is signed rather than stored: see `issueState` below. The
 * off-origin round-trip is fine for a cookie — the provider redirects the
 * browser back to us top-level, so a SameSite=Lax cookie is delivered.
 */
import { constantTimeEqual, signPayload, verifyPayload } from "./hmac";

export type ProviderId =
	| "github"
	| "google"
	| "facebook"
	| "twitter"
	| "discord";

export type ProviderProfile = {
	provider_id: string; // stable per-provider user id (string form)
	/**
	 * **NULL unless the provider vouched for this address as verified.** Every
	 * fetcher below already upholds this — github filters `/user/emails` to
	 * `verified` entries, google gates on `email_verified`, facebook relies on
	 * Graph omitting unconfirmed addresses, discord gates on `u.verified`, and
	 * twitter is always null because v2 exposes no email under these scopes.
	 *
	 * It is stated here because the property was implicit in five separate
	 * functions and something now *depends* on it: this field becomes
	 * `users.email`, and `GET /api/v1/subscribe/mine` treats a non-null
	 * `users.email` as proof that the session owns that inbox. A future
	 * provider that returned an unverified address would turn that endpoint
	 * into an oracle against someone else's mailbox — sign in with an
	 * unverified claim to victim@example.com, read back what they follow.
	 *
	 * So: a new fetcher must return null unless the provider says verified.
	 * If a provider cannot say, null is the answer.
	 */
	email: string | null;
	name: string;
	avatar_url: string | null;
};

type ProviderConfig = {
	authorize_url: string;
	token_url: string;
	scope: string;
	client_id_env: string;
	client_secret_env: string;
	// PKCE (RFC 7636). Required by X/Twitter; harmless for the others. When
	// true, /start mints a code_verifier + S256 challenge and the token
	// exchange replays the verifier.
	pkce?: boolean;
	// How the token endpoint authenticates the client. "body" (default) puts
	// client_secret in the POST body; "basic" sends an HTTP Basic header
	// (client_id:client_secret) and keeps the secret out of the body — X's
	// confidential-client token endpoint requires this.
	token_auth?: "body" | "basic";
	fetch_profile: (access_token: string) => Promise<ProviderProfile>;
};

const fetchGithubProfile = async (token: string): Promise<ProviderProfile> => {
	const headers = {
		authorization: `Bearer ${token}`,
		accept: "application/vnd.github+json",
		"user-agent": "garrul",
	};
	const userRes = await fetch("https://api.github.com/user", { headers });
	if (!userRes.ok) throw new Error(`github user fetch ${userRes.status}`);
	const u = (await userRes.json()) as {
		id: number;
		login: string;
		name: string | null;
		avatar_url: string | null;
	};

	// Always go through /user/emails. The `u.email` field on /user can be
	// the user's public-profile email, which is not necessarily verified.
	// /user/emails is the only source that flags verification, so we trust
	// only verified entries (primary preferred).
	let email: string | null = null;
	const emailsRes = await fetch("https://api.github.com/user/emails", {
		headers,
	});
	if (emailsRes.ok) {
		const emails = (await emailsRes.json()) as {
			email: string;
			primary: boolean;
			verified: boolean;
		}[];
		email =
			emails.find((e) => e.primary && e.verified)?.email ??
			emails.find((e) => e.verified)?.email ??
			null;
	}

	return {
		provider_id: String(u.id),
		email,
		name: u.name?.trim() || u.login,
		avatar_url: u.avatar_url,
	};
};

const fetchGoogleProfile = async (token: string): Promise<ProviderProfile> => {
	const res = await fetch(
		"https://openidconnect.googleapis.com/v1/userinfo",
		{ headers: { authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`google userinfo ${res.status}`);
	const u = (await res.json()) as {
		sub: string;
		email?: string;
		email_verified?: boolean;
		name?: string;
		picture?: string;
	};
	return {
		provider_id: u.sub,
		email: u.email_verified ? (u.email ?? null) : null,
		name: u.name?.trim() || u.email || "user",
		avatar_url: u.picture ?? null,
	};
};

// Facebook Login (Graph API). Returns email only for accounts with a
// confirmed email that grant the `email` scope; Graph omits unverified
// addresses, so we treat a returned address as trusted.
const fetchFacebookProfile = async (
	token: string,
): Promise<ProviderProfile> => {
	const res = await fetch(
		"https://graph.facebook.com/v21.0/me?fields=id,name,email,picture.type(large)",
		{ headers: { authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`facebook me ${res.status}`);
	const u = (await res.json()) as {
		id: string;
		name?: string;
		email?: string;
		picture?: { data?: { url?: string } };
	};
	return {
		provider_id: u.id,
		email: u.email ?? null,
		name: u.name?.trim() || u.email || "user",
		avatar_url: u.picture?.data?.url ?? null,
	};
};

// X/Twitter (API v2). OAuth2 with mandatory PKCE and HTTP Basic token auth.
// The v2 API exposes no email under these scopes, so email is always null —
// users sign in with name + avatar only (the schema allows a null email).
const fetchTwitterProfile = async (
	token: string,
): Promise<ProviderProfile> => {
	const res = await fetch(
		"https://api.twitter.com/2/users/me?user.fields=profile_image_url",
		{ headers: { authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`twitter me ${res.status}`);
	const { data } = (await res.json()) as {
		data?: {
			id: string;
			name?: string;
			username?: string;
			profile_image_url?: string;
		};
	};
	if (!data?.id) throw new Error("twitter me: no user id");
	return {
		provider_id: data.id,
		email: null,
		name: data.name?.trim() || data.username || "user",
		// Default avatar is the 48px "_normal" variant; dropping the suffix
		// yields the original full-size image.
		avatar_url: data.profile_image_url?.replace("_normal", "") ?? null,
	};
};

// Discord. Standard auth-code flow. Trust the email only when Discord flags
// it `verified` (mirrors the GitHub verified-email handling); the avatar is
// assembled from the CDN hash.
const fetchDiscordProfile = async (
	token: string,
): Promise<ProviderProfile> => {
	const res = await fetch("https://discord.com/api/users/@me", {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`discord me ${res.status}`);
	const u = (await res.json()) as {
		id: string;
		username: string;
		global_name?: string | null;
		email?: string | null;
		verified?: boolean;
		avatar?: string | null;
	};
	return {
		provider_id: u.id,
		email: u.verified ? (u.email ?? null) : null,
		name: u.global_name?.trim() || u.username,
		avatar_url: u.avatar
			? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
			: null,
	};
};

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
	github: {
		authorize_url: "https://github.com/login/oauth/authorize",
		token_url: "https://github.com/login/oauth/access_token",
		scope: "read:user user:email",
		client_id_env: "GH_CLIENT_ID",
		client_secret_env: "GH_CLIENT_SECRET",
		fetch_profile: fetchGithubProfile,
	},
	google: {
		authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
		token_url: "https://oauth2.googleapis.com/token",
		scope: "openid email profile",
		client_id_env: "GOOGLE_CLIENT_ID",
		client_secret_env: "GOOGLE_CLIENT_SECRET",
		fetch_profile: fetchGoogleProfile,
	},
	facebook: {
		authorize_url: "https://www.facebook.com/v21.0/dialog/oauth",
		token_url: "https://graph.facebook.com/v21.0/oauth/access_token",
		scope: "email public_profile",
		client_id_env: "FACEBOOK_CLIENT_ID",
		client_secret_env: "FACEBOOK_CLIENT_SECRET",
		fetch_profile: fetchFacebookProfile,
	},
	twitter: {
		authorize_url: "https://twitter.com/i/oauth2/authorize",
		token_url: "https://api.twitter.com/2/oauth2/token",
		scope: "tweet.read users.read",
		client_id_env: "TWITTER_CLIENT_ID",
		client_secret_env: "TWITTER_CLIENT_SECRET",
		pkce: true,
		token_auth: "basic",
		fetch_profile: fetchTwitterProfile,
	},
	discord: {
		authorize_url: "https://discord.com/oauth2/authorize",
		token_url: "https://discord.com/api/oauth2/token",
		scope: "identify email",
		client_id_env: "DISCORD_CLIENT_ID",
		client_secret_env: "DISCORD_CLIENT_SECRET",
		fetch_profile: fetchDiscordProfile,
	},
};

export const isProvider = (s: string): s is ProviderId =>
	s === "github" ||
	s === "google" ||
	s === "facebook" ||
	s === "twitter" ||
	s === "discord";

const randomState = (): string => {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const randomHex = (n: number): string => {
	const bytes = new Uint8Array(n);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

// PKCE (RFC 7636). The verifier is a high-entropy secret minted at /start and
// replayed at the token exchange to prove the client that redeems the code is
// the same one that started the flow. 32 random bytes → 64 hex chars, well
// within PKCE's 43–128-char unreserved-charset range.
//
// It travels in the signed state cookie, not in server-side storage — see the
// `code_verifier` field on StatePayload below for where that leaves it and why
// that placement is sound.
export const genCodeVerifier = (): string => randomHex(32);

// SHA-256(verifier), base64url-encoded without padding — the `S256` challenge
// sent in the authorize redirect. Workers ship crypto.subtle + btoa natively.
export const computeCodeChallenge = async (
	verifier: string,
): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	let bin = "";
	for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Re-exported from lib/hmac so the many existing `from "./oauth"` importers
// keep working. New code should import it from lib/hmac directly.
export { constantTimeEqual };

export type StatePayload = {
	provider: ProviderId;
	return_origin: string;
	created_at: number;
	/**
	 * The `state` value handed to the provider. Binding it INTO the signed
	 * payload is what makes the flow non-transferable: the payload only lives
	 * in a per-flow HttpOnly cookie, so a valid (cookie, state) pair can't be
	 * replayed against a different `state` and can't be planted in someone
	 * else's browser at all (RFC 6749 §10.12 login-CSRF).
	 *
	 * This replaces the old separate `browser_token`, which was an OPTIONAL
	 * field: the callback failed closed only because of the order of a `||`
	 * chain, so a refactor that reordered it would have silently dropped the
	 * login-CSRF check with no test catching it. Required, and inside the
	 * signature, it cannot be dropped.
	 */
	state: string;
	/**
	 * PKCE code_verifier for providers with `pkce: true` (e.g. X/Twitter),
	 * replayed at the token exchange. Absent for non-PKCE providers.
	 *
	 * It now rides in the signed cookie rather than server-side storage, so it
	 * does reach the user agent — but only inside an HttpOnly, Secure,
	 * SameSite=Lax cookie scoped to /api/v1/auth, so page JS cannot read it.
	 * This is the standard stateless-BFF placement. PKCE is defense-in-depth
	 * here regardless: Garrul is a confidential client and always presents a
	 * client_secret at the exchange.
	 */
	code_verifier?: string;
};

/**
 * State lifetime. Enforced by `verifyState` reading `created_at` — the old KV
 * implementation stored that field and never read it, leaving freshness to
 * best-effort KV expiry.
 */
export const STATE_MAX_AGE_MS = 600_000; // 10 minutes

/**
 * Mint a flow: a random `state` for the provider redirect, plus a signed,
 * self-contained payload for the per-flow cookie.
 *
 * Why signed rather than stored: `/start` is unauthenticated, exempt from the
 * Origin gate (lib/cors.ts), and needs no cookie, token or body. The KV write
 * it used to perform was therefore an unauthenticated write against a quota of
 * 1000/day scoped to the operator's ENTIRE Cloudflare account — about 1000
 * requests took every KV-backed feature offline account-wide. A signature
 * costs nothing and needs no storage. Same reasoning as lib/ratelimit.ts.
 *
 * Not a JWT (see lib/hmac.ts): no `alg` header, so no algorithm confusion.
 */
export const issueState = async (
	secret: string,
	payload: Omit<StatePayload, "state" | "created_at">,
): Promise<{ state: string; token: string }> => {
	const state = randomState();
	const token = await signPayload<StatePayload>(secret, {
		...payload,
		state,
		created_at: Date.now(),
	});
	return { state, token };
};

/**
 * Verify a per-flow cookie against the `state` the provider echoed back.
 *
 * Returns null — never distinguishing the reason — on a bad signature, an
 * expired or future-dated payload, a `state` mismatch, or a provider mismatch.
 * The caller must still clear the cookie so the flow is single-use.
 */
export const verifyState = async (
	secret: string,
	token: string,
	expected: { provider: ProviderId; state: string },
): Promise<StatePayload | null> => {
	const payload = await verifyPayload<StatePayload>(secret, token, {
		maxAgeMs: STATE_MAX_AGE_MS,
	});
	if (!payload) return null;
	if (payload.provider !== expected.provider) return null;
	if (typeof payload.state !== "string") return null;
	// Constant-time: a byte-by-byte timing leak here would let an attacker
	// recover a live state value from response timing.
	if (!constantTimeEqual(payload.state, expected.state)) return null;
	return payload;
};

// One-time handoff token used to ferry an OAuth-completed user_id from the
// popup (whose top-level site is comments.example.com) back to the widget
// (whose top-level site is the embedder, e.g. blog.example.org). With
// `Partitioned` session cookies (CHIPS), a cookie set during the popup is
// scoped to the popup's partition and not visible to the cross-site embed.
// The widget receives this token via postMessage, then POSTs it to
// /api/v1/auth/session/exchange — that request's response Set-Cookie lands
// in the embedder's partition, where the widget can actually read it.
const HANDOFF_TTL = 60;

export const issueHandoff = async (
	kv: KVNamespace,
	user_id: string,
): Promise<string> => {
	const token = randomHex(24);
	await kv.put(
		`oauth:handoff:${token}`,
		JSON.stringify({ user_id, created_at: Date.now() }),
		{ expirationTtl: HANDOFF_TTL },
	);
	return token;
};

export const consumeHandoff = async (
	kv: KVNamespace,
	token: string,
): Promise<string | null> => {
	if (!/^[0-9a-f]{48}$/.test(token)) return null;
	const raw = await kv.get(`oauth:handoff:${token}`);
	if (!raw) return null;
	await kv.delete(`oauth:handoff:${token}`);
	try {
		const parsed = JSON.parse(raw) as { user_id?: string };
		return parsed.user_id ?? null;
	} catch {
		return null;
	}
};

export const callbackUrl = (
	env: { OAUTH_CALLBACK_BASE?: string },
	requestUrl: string,
	provider: ProviderId,
): string => {
	const base = env.OAUTH_CALLBACK_BASE?.trim();
	const origin = base && base.length > 0 ? base : new URL(requestUrl).origin;
	return `${origin.replace(/\/$/, "")}/api/v1/auth/${provider}/callback`;
};

export const buildAuthorizeUrl = (
	provider: ProviderId,
	client_id: string,
	redirect_uri: string,
	state: string,
	code_challenge?: string,
): string => {
	const cfg = PROVIDERS[provider];
	const params = new URLSearchParams({
		client_id,
		redirect_uri,
		response_type: "code",
		scope: cfg.scope,
		state,
	});
	if (code_challenge) {
		params.set("code_challenge", code_challenge);
		params.set("code_challenge_method", "S256");
	}
	if (provider === "google") {
		// Force the account chooser when re-authorizing.
		params.set("prompt", "select_account");
	}
	return `${cfg.authorize_url}?${params.toString()}`;
};

export const exchangeCodeForToken = async (
	provider: ProviderId,
	code: string,
	client_id: string,
	client_secret: string,
	redirect_uri: string,
	code_verifier?: string,
): Promise<string> => {
	const cfg = PROVIDERS[provider];
	const body = new URLSearchParams({
		client_id,
		code,
		redirect_uri,
		grant_type: "authorization_code",
	});
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/x-www-form-urlencoded",
	};
	// PKCE providers replay the verifier minted at /start (RFC 7636 §4.5).
	if (code_verifier) body.set("code_verifier", code_verifier);
	if (cfg.token_auth === "basic") {
		// X/Twitter's confidential-client token endpoint authenticates via an
		// HTTP Basic header, not a body param. Keeping the secret out of the
		// body also keeps it off any body-logging path.
		headers.authorization = `Basic ${btoa(`${client_id}:${client_secret}`)}`;
	} else {
		body.set("client_secret", client_secret);
	}
	const res = await fetch(cfg.token_url, {
		method: "POST",
		headers,
		body,
	});
	if (!res.ok) {
		throw new Error(`${provider} token exchange ${res.status}`);
	}
	const json = (await res.json()) as {
		access_token?: string;
		error?: string;
		error_description?: string;
	};
	if (!json.access_token) {
		throw new Error(json.error_description ?? json.error ?? "no access_token");
	}
	return json.access_token;
};
