/**
 * CORS + Origin-header CSRF defense.
 *
 * ALLOWED_ORIGINS is a comma-separated list of origins permitted to embed
 * the widget. Used for both:
 *   - CORS preflight responses (Access-Control-Allow-* headers)
 *   - Origin-header check on state-changing requests (CSRF defense, since
 *     SameSite=None cookies opt out of the browser's default CSRF protection)
 *
 * Wildcards (*) are NOT supported — the spec disallows `*` together with
 * `credentials: include`, and we always want credentials.
 */
import type { MiddlewareHandler } from "hono";

const STATE_CHANGING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

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

export const corsAndCsrf = (): MiddlewareHandler => {
	return async (c, next) => {
		const origin = c.req.header("origin");
		// `ALLOWED_ORIGINS` is declared on Bindings and is always a string.
		// In dev we may also accept the special token "*dev*" to allow any
		// origin, but that requires ENV=dev too.
		const env = c.env as Record<string, string | undefined>;
		const allowed = parseAllowed(env.ALLOWED_ORIGINS);
		const isDev = env.ENV === "dev";

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

		// CSRF: state-changing requests must have a same-origin or allowlisted
		// Origin. GET / HEAD / OPTIONS are exempt.
		if (STATE_CHANGING.has(c.req.method)) {
			if (!origin || (!matches(origin, allowed) && !isDev)) {
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
