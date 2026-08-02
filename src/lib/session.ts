/**
 * Session-id cookies backed by KV.
 *
 * - 32 bytes of randomness, hex-encoded → 64-char session_id
 * - Cookie attributes: HttpOnly; Secure; SameSite=None; Partitioned
 *   (Partitioned = CHIPS, scopes the cookie per top-level site so
 *    Safari ITP / Chrome 3PC-deprecation don't evict it)
 * - Dev fallback (ENV=dev): SameSite=Lax + no Secure, so plain HTTP
 *   wrangler dev works without HTTPS
 * - 30-day TTL in KV; slid forward (at most once a day) while the user is
 *   active so an active user keeps their session forever
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

/**
 * The session cookie carries the `__Host-` prefix in production.
 *
 * The prefix makes the *browser* enforce what we already send — Secure, Path=/,
 * no Domain — and, critically, refuse the cookie from any host but the exact
 * one that set it. Without it, script on a compromised sibling subdomain can
 * set `garrul_sess` with `Domain=yourdomain.com`; the browser then sends two
 * cookies of that name and `parseCookie` returns whichever arrives first, so an
 * attacker can fixate a session id of their choosing. That's not hypothetical
 * here: the documented deployment is `comments.<yourdomain>`, sharing eTLD+1
 * with everything else the operator runs.
 *
 * `__Host-` requires Secure, which a `wrangler dev` instance over plain HTTP
 * can't set — hence the env-dependent name rather than an unconditional one.
 *
 * Renaming the cookie invalidates the one every signed-in user currently holds,
 * so deploying this signs everybody out once. The old KV records stay until
 * their TTL runs out; nothing reads them, and LEGACY_COOKIE_NAME is expired
 * alongside every cookie write below so the dead cookie doesn't linger for a
 * month in the browsers of upgraded installs.
 */
const COOKIE_NAME_PROD = "__Host-garrul_sess";
const LEGACY_COOKIE_NAME = "garrul_sess";
const cookieName = (env: Pick<Env, "ENV">): string =>
	env.ENV === "dev" ? LEGACY_COOKIE_NAME : COOKIE_NAME_PROD;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
// Slide the TTL at most once a day rather than on every read: a KV write per
// authenticated request would burn the (account-wide) write quota, and the
// rarer the refresh the smaller the window in which a concurrent refresh could
// resurrect a session that signout just deleted.
const SESSION_REFRESH_SECONDS = 24 * 60 * 60;
// Session ids are exactly 64 lowercase hex chars (32 random bytes). Reject
// anything else before it reaches a KV op — an oversized cookie would blow the
// 512-byte KV key limit and throw, turning every request (and signout) into a
// 500 the user can't recover from.
const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const sessionKey = (sid: string): string => `sess:${sid}`;

/**
 * Per-user session revocation epoch: every session issued at or before this
 * timestamp is dead.
 *
 * The only session key is `sess:<sid>`, so there is no reverse index a ban
 * could walk to delete a user's sessions — and because readSession *slides*
 * the 30-day TTL, an active banned user's cookie would otherwise never expire.
 * A ban stamps this key instead and readSession compares it against the
 * session's `issued_at`. That costs one extra KV **read** per authenticated
 * request, deliberately spending the abundant quota (reads) rather than the
 * scarce one — KV writes are capped at 1000/day *account-wide*, which is the
 * outage primitive this project has already been burned by.
 *
 * The stamp is not cleared on unban: it stays a cutoff so cookies minted before
 * the ban can never come back to life. A subsequent fresh login gets a newer
 * `issued_at` and is unaffected.
 */
const revocationKey = (userId: string): string => `sessrev:${userId}`;

type SessionRecord = {
	user_id: string;
	// Set once at issue and never moved. `expires_at` can't stand in for it:
	// the sliding TTL pushes that forward, which would let a session outrun a
	// revocation stamp simply by staying active.
	issued_at: number;
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
			const raw = part.slice(eq + 1).trim();
			// An empty value can't be a real session; keep scanning so a later
			// same-name cookie (e.g. one tossed in at a broader scope) can't
			// shadow the valid one and make us skip revocation.
			if (!raw) continue;
			// Malformed percent-encoding (e.g. `%E0%A4%A`) makes
			// decodeURIComponent throw; treat it as a non-match and keep
			// scanning rather than letting a garbage cookie 500 the request.
			try {
				return decodeURIComponent(raw);
			} catch {
			}
		}
	}
	return null;
};

const buildSetCookie = (
	value: string,
	maxAgeSeconds: number,
	env: Env,
	name = cookieName(env),
): string => {
	const parts = [
		`${name}=${value}`,
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
 * Expire the pre-`__Host-` cookie. Emitted alongside every session-cookie write
 * in production so an upgraded install doesn't leave an inert `garrul_sess`
 * sitting in the browser for the rest of its 30-day Max-Age. Attributes have to
 * match the original write for the removal to apply to a Partitioned cookie.
 * Droppable a release or two after the rename has shipped.
 */
const clearLegacyCookie = (c: SessionCtx): void => {
	if (c.env.ENV === "dev") return;
	c.header("Set-Cookie", buildSetCookie("", 0, c.env, LEGACY_COOKIE_NAME), {
		append: true,
	});
};

/**
 * Short-lived auxiliary cookie used by the OAuth state-binding double-
 * submit check. The name is per-flow — `garrul_oauth_b_<state[0:8]>`, see
 * OAUTH_BIND_COOKIE_PREFIX in routes/auth.ts — not a single fixed cookie,
 * so two tabs mid-login don't clobber each other's state. Scoped tightly
 * to /api/v1/auth so it
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
	const now = Date.now();
	const record: SessionRecord = {
		user_id: userId,
		issued_at: now,
		expires_at: now + SESSION_TTL_SECONDS * 1000,
	};
	await c.env.SESSIONS.put(sessionKey(sid), JSON.stringify(record), {
		expirationTtl: SESSION_TTL_SECONDS,
	});
	c.header("Set-Cookie", buildSetCookie(sid, SESSION_TTL_SECONDS, c.env), {
		append: true,
	});
	clearLegacyCookie(c);
	return sid;
};

/**
 * Delete the KV record for the session named by the request cookie, if any,
 * without touching the cookie itself. Used both by signout (which then expires
 * the cookie) and by re-login (which is about to overwrite it) so a fresh
 * session never orphans a still-replayable record.
 */
export const revokeSession = async (c: SessionCtx): Promise<void> => {
	const sid = parseCookie(c.req.header("cookie"), cookieName(c.env));
	if (sid && SESSION_ID_RE.test(sid)) {
		await c.env.SESSIONS.delete(sessionKey(sid));
	}
};

/**
 * Kill every session this user currently holds, without needing to enumerate
 * them. Called when a user is banned — see `revocationKey`.
 */
export const revokeUserSessions = async (
	env: Pick<Env, "SESSIONS">,
	userId: string,
): Promise<void> => {
	await env.SESSIONS.put(revocationKey(userId), String(Date.now()), {
		// No session can outlive the TTL, so neither does the stamp.
		expirationTtl: SESSION_TTL_SECONDS,
	});
};

export const destroySession = async (c: SessionCtx): Promise<void> => {
	await revokeSession(c);
	c.header("Set-Cookie", buildSetCookie("", 0, c.env), { append: true });
	clearLegacyCookie(c);
};

export const readSession = async (
	c: SessionCtx,
): Promise<{ sid: string; user_id: string } | null> => {
	// Deliberately only the current name: accepting LEGACY_COOKIE_NAME as a
	// fallback would keep the sibling-subdomain fixation path open, which is the
	// whole reason for the prefix.
	const sid = parseCookie(c.req.header("cookie"), cookieName(c.env));
	if (!sid || !SESSION_ID_RE.test(sid)) return null;
	const raw = await c.env.SESSIONS.get(sessionKey(sid));
	if (!raw) return null;
	let record: SessionRecord;
	try {
		record = JSON.parse(raw) as SessionRecord;
	} catch {
		await c.env.SESSIONS.delete(sessionKey(sid));
		return null;
	}
	const now = Date.now();
	if (record.expires_at < now) {
		await c.env.SESSIONS.delete(sessionKey(sid));
		return null;
	}
	// Revocation, checked before the TTL slide below so a dead session is never
	// refreshed on its way out.
	const revoked = await c.env.SESSIONS.get(revocationKey(record.user_id));
	if (revoked !== null) {
		const epoch = Number(revoked);
		// A record written before `issued_at` existed reads as 0, so any
		// revocation kills it. An unparseable stamp is treated as revoking
		// everything: it can only come from our own write, and failing closed on
		// a ban is the safe direction.
		if (!Number.isFinite(epoch) || (record.issued_at ?? 0) <= epoch) {
			await c.env.SESSIONS.delete(sessionKey(sid));
			return null;
		}
	}
	// Sliding TTL, but only re-write once the record has aged past the refresh
	// interval — avoids a KV write on every authenticated request.
	const ageSeconds = SESSION_TTL_SECONDS - (record.expires_at - now) / 1000;
	if (ageSeconds >= SESSION_REFRESH_SECONDS) {
		record.expires_at = now + SESSION_TTL_SECONDS * 1000;
		await c.env.SESSIONS.put(sessionKey(sid), JSON.stringify(record), {
			expirationTtl: SESSION_TTL_SECONDS,
		});
	}
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
