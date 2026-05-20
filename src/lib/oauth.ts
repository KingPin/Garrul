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
	client_id_env: "GH_CLIENT_ID" | "GOOGLE_CLIENT_ID";
	client_secret_env: "GH_CLIENT_SECRET" | "GOOGLE_CLIENT_SECRET";
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
): string => {
	const cfg = PROVIDERS[provider];
	const params = new URLSearchParams({
		client_id,
		redirect_uri,
		response_type: "code",
		scope: cfg.scope,
		state,
	});
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
): Promise<string> => {
	const cfg = PROVIDERS[provider];
	const body = new URLSearchParams({
		client_id,
		client_secret,
		code,
		redirect_uri,
		grant_type: "authorization_code",
	});
	const res = await fetch(cfg.token_url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
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
