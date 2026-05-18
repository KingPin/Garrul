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
 * Carve-outs (CARVE_OUT_PATHS) bypass the Origin check entirely — used for
 * routes that legitimately receive no Origin header (uptime probes, OAuth
 * top-level browser navigation).
 */
import type { MiddlewareHandler } from "hono";

const CARVE_OUT_PATHS: readonly RegExp[] = [
	/^\/api\/v1\/health(\/|$)/,
	/^\/api\/v1\/auth\/[^/]+\/start(\/|$)/,
	/^\/api\/v1\/auth\/[^/]+\/callback(\/|$)/,
];

const parseAllowed = (raw: string | undefined): Set<string> => {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
};

const matches = (origin: string, allowed: Set<string>): boolean => {
	return allowed.has(origin);
};

const isCarveOut = (path: string): boolean =>
	CARVE_OUT_PATHS.some((re) => re.test(path));

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
		// legitimately receive no Origin header. Dev mode bypasses entirely
		// so curl + local clients work without juggling Origin headers.
		if (!isCarveOut(path) && !isDev) {
			if (!origin || !matches(origin, allowed)) {
				return c.json({ error: "err.origin.forbidden" }, 403);
			}
		}

		// Echo CORS headers on actual responses so cookies flow.
		if (origin && (matches(origin, allowed) || isDev)) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Credentials", "true");
			c.header("Vary", "Origin");
		}

		await next();
	};
};
