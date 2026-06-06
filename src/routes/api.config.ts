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
 *   - feature flags (comments_enabled, reactions_enabled, voting_enabled,
 *     downvotes_enabled, page_reactions_enabled, page_votes_enabled): which
 *     surfaces the widget should render. Resolved with DB-override > env >
 *     default precedence (see src/lib/settings.ts); operators toggle them at
 *     runtime from the admin Settings page.
 *   - numeric display settings (comments_per_page, replies_per_thread,
 *     auto_collapse_depth): page size and reply-collapse tuning, same
 *     DB-override > env > default precedence (see src/lib/settings.ts).
 *
 * The widget calls this once on mount. Missing or empty → widget renders
 * without a Turnstile challenge (and anonymous POSTs will be rejected
 * server-side as a result).
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { PROVIDERS, type ProviderId } from "../lib/oauth";
import { loadFlags, loadNumbers } from "../lib/settings";

const config = new Hono<{ Bindings: Bindings }>();

const isTruthy = (v: string | undefined): boolean =>
	v === "1" || v?.toLowerCase() === "true";

config.get("/", async (c) => {
	const minutes = Number.parseInt(c.env.EDIT_WINDOW_MINUTES, 10);
	const edit_window_minutes =
		Number.isFinite(minutes) && minutes > 0 ? minutes : 5;
	const providers = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => {
		const cfg = PROVIDERS[p];
		return !!c.env[cfg.client_id_env] && !!c.env[cfg.client_secret_env];
	});
	// Feature flags + numeric display settings, both resolved with
	// DB-override > env > default precedence.
	const [flags, numbers] = await Promise.all([
		loadFlags(c.env),
		loadNumbers(c.env),
	]);
	return c.json({
		turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
		edit_window_minutes,
		providers,
		branding_hidden: isTruthy(c.env.BRANDING_HIDDEN),
		comments_enabled: flags.comments_enabled,
		reactions_enabled: flags.reactions_enabled,
		voting_enabled: flags.votes_enabled,
		// Raw downvote switch, independent of comment voting. The widget
		// already guards the comment vote UI behind voting_enabled, and page
		// votes (page_votes_enabled) are a separate surface that also honors
		// this flag — coupling it to votes_enabled here would wrongly hide
		// page downvotes when only comment voting is off.
		downvotes_enabled: flags.downvotes_enabled,
		page_reactions_enabled: flags.page_reactions_enabled,
		page_votes_enabled: flags.page_votes_enabled,
		// Display/pagination. comments_per_page drives the server-side page
		// slice (included here for parity/debuggability); the widget consumes
		// replies_per_thread and auto_collapse_depth for client-side reply
		// collapsing.
		comments_per_page: numbers.comments_per_page,
		replies_per_thread: numbers.replies_per_thread,
		auto_collapse_depth: numbers.auto_collapse_depth,
	});
});

export { config };
