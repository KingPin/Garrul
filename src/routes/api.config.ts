/**
 * GET /api/v1/config — public widget bootstrap config.
 *
 * Exposes:
 *   - turnstile_site_key (the public site key — safe to ship to the
 *     browser; the secret stays server-side in TURNSTILE_SECRET).
 *   - providers: OAuth providers the operator has actually configured.
 *     Each entry requires BOTH client_id and client_secret to be set;
 *     the widget uses this to render only the login buttons that will work.
 *   - branding_hidden: when true, the widget skips the "Powered by Garrul"
 *     attribution. Operators flip this server-side via BRANDING_HIDDEN; it
 *     intentionally has no HTML/data-attribute opt-out.
 *
 * The widget calls this once on mount. Missing or empty → widget renders
 * without a Turnstile challenge (and anonymous POSTs will be rejected
 * server-side as a result).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { PROVIDERS, type ProviderId } from "../lib/oauth";

const config = new Hono<{ Bindings: Bindings }>();

const isTruthy = (v: string | undefined): boolean =>
	v === "1" || v?.toLowerCase() === "true";

// Defaults-on flag: present + falsy → off; absent → on. Mirrors the
// VOTING_ENABLED / DOWNVOTES_ENABLED semantics in api.votes.ts so the
// widget renders consistently with what the server will accept.
const isBoolishOn = (v: string | undefined): boolean => {
	if (v == null) return true;
	const norm = v.trim().toLowerCase();
	if (norm === "0" || norm === "false" || norm === "no" || norm === "off") {
		return false;
	}
	return true;
};

config.get("/", (c) => {
	const minutes = Number.parseInt(c.env.EDIT_WINDOW_MINUTES, 10);
	const edit_window_minutes =
		Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
	const providers = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => {
		const cfg = PROVIDERS[p];
		return !!c.env[cfg.client_id_env] && !!c.env[cfg.client_secret_env];
	});
	const voting_enabled = isBoolishOn(c.env.VOTING_ENABLED);
	return c.json({
		turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
		edit_window_minutes,
		providers,
		branding_hidden: isTruthy(c.env.BRANDING_HIDDEN),
		voting_enabled,
		// Downvotes implicitly off when voting itself is off (saves the
		// widget a second conditional).
		downvotes_enabled: voting_enabled && isBoolishOn(c.env.DOWNVOTES_ENABLED),
	});
});

export { config };
