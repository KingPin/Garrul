/**
 * Session-id cookies backed by KV.
 *
 * - 32 bytes of randomness, hex-encoded → 64-char session_id
 * - Cookie attributes: HttpOnly; Secure; SameSite=None; Partitioned
 *   (Partitioned = CHIPS, scopes the cookie per top-level site so
 *    Safari ITP / Chrome 3PC-deprecation don't evict it)
 * - Dev fallback (ENV=dev): SameSite=Lax + no Secure, so plain HTTP
 *   wrangler dev works without HTTPS
 * - 30-day TTL in KV; refreshed on every use so an active user keeps
 *   their session forever
 *
 * The cookie value IS the session id. The KV value is the user_id +
 * expiry. To revoke a session, delete the KV entry; the cookie becomes
 * inert immediately. Signout goes through destroySession, which does
 * exactly that before expiring the cookie — clearing the cookie alone
 * would leave the server-side record replayable for its full TTL.
 */
import type { MiddlewareHandler } from "hono";

// Structural shape of the bits of a Hono context this module uses. Defining
// it structurally (instead of `Context<{Bindings:Env}>`) keeps callers free
// to add Variables / sub-paths without TS invariance fights.
type SessionCtx = {
	env: Env;
	req: { header(name: string): string | undefined };
	header(name: string, value: string, options?: { append?: boolean }): void;
};

const COOKIE_NAME = "garrul_sess";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type SessionRecord = {
	user_id: string;
	expires_at: number;
};

type Env = {
	SESSIONS: KVNamespace;
	ENV: string;
};

const newSessionId = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export const parseCookie = (
	header: string | undefined,
	name: string,
): string | null => {
	if (!header) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim() === name) {
			return decodeURIComponent(part.slice(eq + 1).trim());
		}
	}
	return null;
};

const buildSetCookie = (
	value: string,
	maxAgeSeconds: number,
	env: Env,
): string => {
	const parts = [
		`${COOKIE_NAME}=${value}`,
		"Path=/",
		`Max-Age=${maxAgeSeconds}`,
		"HttpOnly",
	];
	if (env.ENV === "dev") {
		parts.push("SameSite=Lax");
	} else {
		parts.push("SameSite=None", "Secure", "Partitioned");
	}
	return parts.join("; ");
};

/**
 * Short-lived auxiliary cookie used by the OAuth state-binding double-
 * submit check (`garrul_oauth_b`). Scoped tightly to /api/v1/auth so it
 * is sent only on the start → callback round-trip, and uses SameSite=Lax
 * because the callback is a top-level same-site GET from the provider
 * (SameSite=Strict would not deliver after the cross-site redirect).
 */
export const buildShortCookie = (
	name: string,
	value: string,
	maxAgeSeconds: number,
	env: { ENV: string },
	path = "/api/v1/auth",
): string => {
	const parts = [
		`${name}=${value}`,
		`Path=${path}`,
		`Max-Age=${maxAgeSeconds}`,
		"HttpOnly",
		"SameSite=Lax",
	];
	if (env.ENV !== "dev") {
		parts.push("Secure");
	}
	return parts.join("; ");
};

export const clearShortCookie = (
	name: string,
	env: { ENV: string },
	path = "/api/v1/auth",
): string => buildShortCookie(name, "", 0, env, path);

export const issueSession = async (
	c: SessionCtx,
	userId: string,
): Promise<string> => {
	const sid = newSessionId();
	const record: SessionRecord = {
		user_id: userId,
		expires_at: Date.now() + SESSION_TTL_SECONDS * 1000,
	};
	await c.env.SESSIONS.put(`sess:${sid}`, JSON.stringify(record), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
	c.header("Set-Cookie", buildSetCookie(sid, SESSION_TTL_SECONDS, c.env), {
		append: true,
	});
	return sid;
};

export const destroySession = async (c: SessionCtx): Promise<void> => {
	const sid = parseCookie(c.req.header("cookie"), COOKIE_NAME);
	if (sid) await c.env.SESSIONS.delete(`sess:${sid}`);
	c.header("Set-Cookie", buildSetCookie("", 0, c.env), { append: true });
};

export const readSession = async (
	c: SessionCtx,
): Promise<{ sid: string; user_id: string } | null> => {
	const sid = parseCookie(c.req.header("cookie"), COOKIE_NAME);
	if (!sid) return null;
	const raw = await c.env.SESSIONS.get(`sess:${sid}`);
	if (!raw) return null;
	let record: SessionRecord;
	try {
		record = JSON.parse(raw) as SessionRecord;
	} catch {
		await c.env.SESSIONS.delete(`sess:${sid}`);
		return null;
	}
	if (record.expires_at < Date.now()) {
		await c.env.SESSIONS.delete(`sess:${sid}`);
		return null;
	}
	// Sliding TTL: extend on every use.
	record.expires_at = Date.now() + SESSION_TTL_SECONDS * 1000;
	await c.env.SESSIONS.put(`sess:${sid}`, JSON.stringify(record), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
	return { sid, user_id: record.user_id };
};

export const sessionMiddleware = (): MiddlewareHandler<{ Bindings: Env }> => {
	return async (c, next) => {
		const session = await readSession(c);
		// Hono's context allows arbitrary keys via set/get; readers should
		// pull `userId` (string|null) instead of touching cookies directly.
		c.set("userId" as never, session?.user_id ?? null);
		c.set("sessionId" as never, session?.sid ?? null);
		await next();
	};
};
