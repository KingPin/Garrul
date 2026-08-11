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
 *     auto_collapse_depth, edit_window_minutes): page size, reply-collapse and
 *     edit-window tuning, same DB-override > env > default precedence (see
 *     src/lib/settings.ts). edit_window_minutes of 0 means editing is off; the
 *     widget hides the Edit affordance and the PATCH route rejects regardless.
 *   - community auto-collapse thresholds (community_min_votes,
 *     community_collapse_ratio): the widget folds heavily-downvoted comments
 *     client-side using these (see src/widget). 0 ratio = disabled.
 *   - locale, and for anything but English a `strings` table and `rtl` flag.
 *     This is where the widget learns which language it is in; it echoes the
 *     answer back as `?lang=` on every later call so server error bodies match.
 *
 * The widget calls this once on mount. Missing or empty → widget renders
 * without a Turnstile challenge (and anonymous POSTs will be rejected
 * server-side as a result).
 *
 * **This response carries no cache headers, and that is load-bearing.** It
 * varies by locale (and by session, for the provider list). Anyone adding
 * `cache-control` here must put the locale in the cache key first — otherwise
 * whichever language happened to warm the edge is the one every reader gets.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { PROVIDERS, type ProviderId } from "../lib/oauth";
import { loadFlags, loadNumbers, loadStrings } from "../lib/settings";
import { DEFAULT_LOCALE, LOCALES } from "../i18n";
import { resolveLocale } from "../i18n/negotiate";
import { WIDGET_TABLES } from "../i18n/widget";

const config = new Hono<{ Bindings: Bindings }>();

const isTruthy = (v: string | undefined): boolean =>
	v === "1" || v?.toLowerCase() === "true";

config.get("/", async (c) => {
	// Provider client-id/secret env-var names are typed as plain strings on
	// ProviderConfig, so index the bindings through a string-keyed view.
	const env = c.env as unknown as Record<string, string | undefined>;
	const providers = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => {
		const cfg = PROVIDERS[p];
		return !!env[cfg.client_id_env] && !!env[cfg.client_secret_env];
	});
	// Feature flags + numeric display settings, both resolved with
	// DB-override > env > default precedence.
	const [flags, numbers, strings] = await Promise.all([
		loadFlags(c.env),
		loadNumbers(c.env),
		loadStrings(c.env),
	]);
	// Full negotiation, including the operator's default_locale — which the
	// /api/* locale middleware deliberately skips, since it would put a settings
	// read on every API request to answer a question only this route asks. The
	// widget takes the answer from here and echoes it as ?lang= afterwards, so
	// the middleware still sees the resolved locale on every later call.
	const locale = resolveLocale({
		requested: c.req.query("lang"),
		operatorDefault: strings.default_locale,
		hostPage: c.req.query("hl"),
	});
	// English costs zero bytes: EN is compiled into the widget bundle. Other
	// locales get their own table only — missing keys fall back to English per
	// key in the widget, which is what lets a partial translation ship.
	const localized =
		locale === DEFAULT_LOCALE
			? {}
			: {
					strings: WIDGET_TABLES[locale] ?? {},
					rtl: LOCALES[locale]?.rtl === true,
				};
	return c.json({
		locale,
		...localized,
		turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
		edit_window_minutes: numbers.edit_window_minutes,
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
		// Community auto-collapse thresholds. The widget folds a comment when
		// down/(up+down) ≥ ratio once total votes ≥ floor (and downvotes are
		// enabled). Collapse is derived client-side because votes deliberately
		// don't bust the tree cache (see api.votes.ts) — a server flag would be
		// stale against the cached score the widget already shows. 0 ratio = off.
		community_min_votes: numbers.community_min_votes,
		community_collapse_ratio: numbers.community_collapse_ratio,
	});
});

export { config };
