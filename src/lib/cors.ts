/**
 * CORS + Origin-header CSRF defense.
 *
 * ALLOWED_ORIGINS is a comma-separated list of origins permitted to embed
 * the widget. Used for both:
 *   - CORS preflight responses (Access-Control-Allow-* headers)
 *   - Origin-header check on all requests under /api/* (CSRF defense, since
 *     SameSite=None cookies opt out of the browser's default CSRF protection,
 *     and a hard gate on Origin doubles as the lever that stops random sites
 *     from using this instance — including for plain GET reads).
 *
 * Wildcards (*) are NOT supported — the spec disallows `*` together with
 * `credentials: include`, and we always want credentials.
 *
 * Three relaxations, each narrower than it looks and each documented at its
 * own list below. They are separate lists on purpose — folding any of them
 * together would widen the others:
 *   - CARVE_OUT_PATHS      GET only, no Origin needed (probes, OAuth returns,
 *                          email-link clicks)
 *   - SELF_ORIGIN_POST_PATHS  POST whose Origin is this Worker's own (forms we
 *                          serve ourselves)
 *   - NO_ORIGIN_POST_PATHS POST with no Origin at all (RFC 8058 one-click,
 *                          which arrives from a mail provider's servers)
 */
import type { MiddlewareHandler } from "hono";

// Anchored at both ends — an optional trailing slash is allowed for
// path-normalization tolerance, but sub-paths like
// `/api/v1/auth/github/start/admin` must NOT silently bypass the
// Origin gate (defense-in-depth against future routes accidentally
// inheriting carve-out behavior).
const CARVE_OUT_PATHS: readonly RegExp[] = [
	/^\/api\/v1\/health\/?$/,
	/^\/api\/v1\/auth\/[^/]+\/start\/?$/,
	/^\/api\/v1\/auth\/[^/]+\/callback\/?$/,
	// Email-link top-level GETs from mail clients have no Origin header.
	// The token in the URL is the unguessable capability — Origin check
	// would add nothing here and would break every email click.
	/^\/api\/v1\/subscribe\/confirm\/[^/]+\/?$/,
	/^\/api\/v1\/subscribe\/unsubscribe\/[^/]+\/?$/,
];

/**
 * Paths where a POST may satisfy the gate with this Worker's *own* origin
 * instead of an entry in ALLOWED_ORIGINS.
 *
 * The unsubscribe confirmation form is served by this Worker, so the browser
 * sends the Worker's own host as Origin — which an operator has no reason to
 * list as an embed origin. This is still a real check, not a carve-out: a
 * cross-site forgery attempt carries the attacker's Origin and is rejected. The
 * unguessable token in the URL remains the actual capability; the POST exists
 * to stop mail-client prefetchers from unsubscribing people who never clicked.
 */
const SELF_ORIGIN_POST_PATHS: readonly RegExp[] = [
	/^\/api\/v1\/subscribe\/unsubscribe\/[^/]+\/?$/,
	// The other two buttons on that same page: unsubscribe from every thread
	// this address follows, and unsubscribe one listed row by its id. Same form,
	// same page, same token capability — they only need their own entries
	// because the list above is anchored and will not match a sub-path.
	/^\/api\/v1\/subscribe\/unsubscribe\/[^/]+\/all\/?$/,
	/^\/api\/v1\/subscribe\/unsubscribe\/[^/]+\/row\/[^/]+\/?$/,
];

/**
 * Paths where a POST carrying *no* Origin header at all satisfies the gate.
 *
 * One entry, and it should stay that way: RFC 8058 one-click unsubscribe.
 * Gmail and friends POST `List-Unsubscribe=One-Click` from their own servers,
 * not from a browser, so there is no Origin to send — `isCarveOut` is GET-only
 * and `isSelfOriginPost` requires an origin, so without this the mail
 * provider's unsubscribe button 403s.
 *
 * Why this can't just be another `SELF_ORIGIN_POST_PATHS` entry: that list's
 * existing entry is the prefix of this one, and it guards the *human*
 * confirmation form. Relaxing that entry to accept a missing Origin would drop
 * the CSRF check on the form as well, which is the one place a browser is
 * actually involved. Two different threat models, so two different lists.
 *
 * What makes the relaxation safe here is that the 64-char token in the path is
 * the sole capability, and the endpoint is write-only — it returns a bare 200
 * and discloses nothing about the address. A cross-site forgery gains nothing
 * it could not already do by GETting the same token out of the mail, and a
 * browser-originated forgery is still rejected, because a browser always sends
 * an Origin on a cross-site POST.
 *
 * Anchored at both ends, same reasoning as the lists above.
 */
const NO_ORIGIN_POST_PATHS: readonly RegExp[] = [
	/^\/api\/v1\/subscribe\/unsubscribe\/[^/]+\/one-click\/?$/,
];

export const parseAllowedOrigins = (raw: string | undefined): Set<string> => {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
};
const parseAllowed = parseAllowedOrigins;

/**
 * The only form a caller-supplied page URL may take before it is stored in
 * `posts.url` or followed by `/c/:id`: absolute, http(s), and on an origin the
 * operator lists in ALLOWED_ORIGINS. Returns the URL serialised by the parser
 * (so `HTTPS://Blog.Example.com` compares equal to its allowlisted form), or
 * null for anything else.
 *
 * `post_url` arrives on an unauthenticated POST /api/v1/comments at the same
 * trust level as the comment body, and the permalink route 302s a reader to
 * it. A scheme check alone left a first-writer able to point a fresh slug's
 * permalinks — which fan out into notification mail, the Atom feed and
 * webhook payloads under this Worker's hostname — at any host. The embed only
 * runs on allowlisted origins, so a legitimate `data-url` is always on one.
 */
export const allowedPostUrl = (
	raw: string | null | undefined,
	allowedOrigins: string | undefined,
): string | null => {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
		return null;
	}
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	if (!parseAllowedOrigins(allowedOrigins).has(u.origin)) return null;
	return u.toString();
};

const matches = (origin: string, allowed: Set<string>): boolean => {
	return allowed.has(origin);
};

const isCarveOut = (method: string, path: string): boolean =>
	method === "GET" && CARVE_OUT_PATHS.some((re) => re.test(path));

const isSelfOriginPost = (
	method: string,
	path: string,
	origin: string | undefined,
	requestUrl: string,
): boolean => {
	if (method !== "POST" || !origin) return false;
	if (!SELF_ORIGIN_POST_PATHS.some((re) => re.test(path))) return false;
	return origin === new URL(requestUrl).origin;
};

// Only when the header is genuinely absent. A POST that *does* carry an Origin
// falls through to the normal allowlist check, so a browser-driven forgery
// against the one-click path is still rejected on its Origin.
const isNoOriginPost = (
	method: string,
	path: string,
	origin: string | undefined,
): boolean => {
	if (method !== "POST" || origin) return false;
	return NO_ORIGIN_POST_PATHS.some((re) => re.test(path));
};

export const corsAndCsrf = (): MiddlewareHandler => {
	return async (c, next) => {
		const origin = c.req.header("origin");
		const env = c.env as Record<string, string | undefined>;
		const allowed = parseAllowed(env.ALLOWED_ORIGINS);
		const isDev = env.ENV === "dev";
		const path = c.req.path;

		// CORS preflight.
		if (c.req.method === "OPTIONS") {
			if (origin && (matches(origin, allowed) || isDev)) {
				c.header("Access-Control-Allow-Origin", origin);
				c.header("Access-Control-Allow-Credentials", "true");
				c.header(
					"Access-Control-Allow-Methods",
					"GET, POST, PATCH, DELETE, OPTIONS",
				);
				c.header(
					"Access-Control-Allow-Headers",
					"content-type, x-requested-with",
				);
				c.header("Access-Control-Max-Age", "86400");
				c.header("Vary", "Origin");
			}
			return c.body(null, 204);
		}

		// Origin allowlist applies to ALL methods under /api/*, including GET.
		// Carve-outs (health, OAuth start/callback) bypass because they
		// legitimately receive no Origin header — but only for GET, the
		// method they're actually invoked with. A future POST/PATCH on a
		// carve-out path must NOT silently bypass the gate. Dev mode
		// bypasses entirely so curl + local clients work without juggling
		// Origin headers.
		const selfOriginPost = isSelfOriginPost(
			c.req.method,
			path,
			origin,
			c.req.url,
		);
		const noOriginPost = isNoOriginPost(c.req.method, path, origin);
		if (
			!isCarveOut(c.req.method, path) &&
			!selfOriginPost &&
			!noOriginPost &&
			!isDev
		) {
			if (!origin || !matches(origin, allowed)) {
				return c.json({ error: "err.origin.forbidden" }, 403);
			}
		}

		// Echo CORS headers on actual responses so cookies flow. c.header()
		// before next() only reaches responses created via the context
		// (c.json/c.body) — including error responses built by onError — so it
		// stays. Handlers that return a raw Response (the edge-cache paths in
		// lib/response-cache.ts) drop these prepared headers entirely, hence
		// the post-next backfill below.
		const corsOk = origin && (matches(origin, allowed) || isDev);
		if (corsOk) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Credentials", "true");
			c.header("Vary", "Origin");
		}

		await next();

		// Backfill onto raw Responses. Cache API / fetch responses have
		// immutable headers in workerd; reassigning through c.res makes Hono
		// re-wrap into a mutable Response.
		if (corsOk && !c.res.headers.has("Access-Control-Allow-Origin")) {
			c.res = new Response(c.res.body, c.res);
			c.res.headers.set("Access-Control-Allow-Origin", origin);
			c.res.headers.set("Access-Control-Allow-Credentials", "true");
			const vary = c.res.headers.get("Vary");
			const hasOriginVary = vary
				?.split(",")
				.some((v) => v.trim().toLowerCase() === "origin");
			if (!vary) c.res.headers.set("Vary", "Origin");
			else if (!hasOriginVary) c.res.headers.set("Vary", `${vary}, Origin`);
		}
	};
};
