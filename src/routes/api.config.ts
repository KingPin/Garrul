/**
 * GET /api/v1/config — public widget bootstrap config.
 *
 * Exposes:
 *   - turnstile_site_key (the public site key — safe to ship to the
 *     browser; the secret stays server-side in TURNSTILE_SECRET).
 *
 * The widget calls this once on mount. Missing or empty → widget renders
 * without a Turnstile challenge (and anonymous POSTs will be rejected
 * server-side as a result).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";

const config = new Hono<{ Bindings: Bindings }>();

config.get("/", (c) => {
	return c.json({
		turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
	});
});

export { config };
