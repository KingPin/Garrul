/**
 * OAuth2 authorization-code flow for GitHub + Google.
 *
 * Flow:
 *   1. Widget opens a popup at /api/v1/auth/:provider/start?return=<origin>.
 *   2. We generate a random `state`, stash it in OAUTH_STATE KV (TTL 10min),
 *      and 302 to the provider's authorize URL.
 *   3. Provider redirects to /api/v1/auth/:provider/callback?code&state.
 *   4. We verify `state`, exchange `code` for an access token, fetch the
 *      user profile, upsert into `users` (provider + provider_id),
 *      issue a session cookie (lib/session.ts), and render a tiny HTML
 *      page that postMessages back to the opener and closes.
 *
 * Callback URL config:
 *   OAUTH_CALLBACK_BASE env var (e.g. "https://comments.garrul.com").
 *   Falls back to the request origin when unset — useful for dev.
 *
 * Why state in KV: we don't carry it in a cookie because the round-trip
 * goes off-origin (provider → us), and 3rd-party cookie behavior is
 * unreliable. KV state survives the redirect and includes a one-time
 * read.
 */

export type ProviderId = "github" | "google";

export type ProviderProfile = {
	provider_id: string; // stable per-provider user id (string form)
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
};

export const isProvider = (s: string): s is ProviderId =>
	s === "github" || s === "google";

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

// PKCE (RFC 7636). The verifier is a high-entropy secret minted at /start,
// stashed server-side in the KV state payload (never sent to the browser),
// and replayed at the token exchange to prove the client that redeems the
// code is the same one that started the flow. 32 random bytes → 64 hex chars,
// well within PKCE's 43–128-char unreserved-charset range.
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

// Length-independent constant-time string compare. The browser_token /
// handoff tokens we mint are fixed-length hex, so the early length
// branch doesn't leak useful information to an attacker. A naive `===`
// short-circuits at the first mismatched byte and is observable via
// response timing — over enough callback requests an attacker can
// recover the token byte-by-byte. Use this for any secret comparison.
export const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
};

export type StatePayload = {
	provider: ProviderId;
	return_origin: string;
	created_at: number;
	// Random per-flow token also written to a `garrul_oauth_b` cookie at
	// /start. /callback requires the cookie value to match — without this,
	// an attacker could trick a victim's browser into completing the
	// callback with the attacker's code+state, planting the attacker's
	// session (RFC 6749 §10.12 login-CSRF). Required for callers from
	// /api/v1/auth/:provider/start; pre-existing state payloads in KV
	// from before this column shipped may lack it.
	browser_token?: string;
	// PKCE code_verifier for providers with `pkce: true` (e.g. X/Twitter).
	// Lives only here in KV — never sent to the browser — and is replayed at
	// the token exchange. Absent for non-PKCE providers.
	code_verifier?: string;
};

const STATE_TTL = 600; // 10 minutes

export const issueState = async (
	kv: KVNamespace,
	payload: StatePayload,
): Promise<string> => {
	const state = randomState();
	await kv.put(`oauth:state:${state}`, JSON.stringify(payload), {
		expirationTtl: STATE_TTL,
	});
	return state;
};

export const consumeState = async (
	kv: KVNamespace,
	state: string,
): Promise<StatePayload | null> => {
	const raw = await kv.get(`oauth:state:${state}`);
	if (!raw) return null;
	await kv.delete(`oauth:state:${state}`);
	try {
		return JSON.parse(raw) as StatePayload;
	} catch {
		return null;
	}
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
