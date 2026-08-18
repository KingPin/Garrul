/**
 * GET /api/v1/config — public widget bootstrap config.
 *
 * Exposes:
 *   - turnstile_site_key (the public site key — safe to ship to the
 *     browser; the secret stays server-side in TURNSTILE_SECRET).
 *   - turnstile_always: whether signed-in commenters get challenged too.
 *     Default false (session = no challenge). The widget uses it to decide
 *     whether to render the challenge slot for a signed-in reader, and the
 *     POST handler resolves the same predicate before demanding a token.
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
 *   - subscriptions_enabled: whether this install can send mail, derived from
 *     EMAIL_FROM + PUBLIC_BASE_URL. Not an operator toggle — it tells the widget
 *     whether to offer the subscribe affordances at all, since `POST
 *     /api/v1/subscribe` fails closed on the same pair.
 *   - numeric display settings (comments_per_page, replies_per_thread,
 *     auto_collapse_depth, edit_window_minutes): page size, reply-collapse and
 *     edit-window tuning, same DB-override > env > default precedence (see
 *     src/lib/settings.ts). edit_window_minutes of 0 means editing is off; the
 *     widget hides the Edit affordance and the PATCH route rejects regardless.
 *   - community auto-collapse thresholds (community_min_votes,
 *     community_collapse_ratio): the widget folds heavily-downvoted comments
 *     client-side using these (see src/widget). 0 ratio = disabled.
 *   - max_body_chars: the comment-length ceiling from lib/markdown.ts. Not an
 *     operator setting; it is here so the composer's character counter counts
 *     down against the same number validateBody enforces.
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
import { MAX_BODY_CHARS } from "../lib/markdown";
import { loadSettings, type ResolvedSettings } from "../lib/settings";
import { turnstileAlwaysOn } from "../lib/turnstile";
import { FALLBACK_LOCALE, LOCALES } from "../i18n";
import { resolveLocale } from "../i18n/negotiate";
import { WIDGET_TABLES } from "../i18n/widget";

const config = new Hono<{ Bindings: Bindings }>();

const isTruthy = (v: string | undefined): boolean =>
	v === "1" || v?.toLowerCase() === "true";

/**
 * Resolve the widget's locale from the request's negotiation inputs.
 *
 * Full negotiation, including the operator's `default_locale` — which the
 * `/api/*` locale middleware deliberately skips, since it would put a settings
 * read on every API request to answer a question only the widget's boot call
 * asks. The widget takes the answer from here and echoes it as `?lang=`
 * afterwards, so the middleware still sees the resolved locale on every later
 * call.
 *
 * Shared with `GET /api/v1/bootstrap`, which serves the same config section and
 * must resolve the locale identically — a second spelling of this would be a
 * silent way for the two boot paths to disagree about language.
 */
export const resolveConfigLocale = (
	requested: string | undefined,
	hostPage: string | undefined,
	operatorDefault: string,
): string =>
	resolveLocale({ requested, operatorDefault, hostPage });

/**
 * Build the public widget config body.
 *
 * Pure: every input is passed in, so the caller decides how settings and the
 * locale were obtained. `GET /api/v1/config` loads its own settings;
 * `GET /api/v1/bootstrap` already holds them (it needs the same object for the
 * comment tree) and hands them over rather than paying a second read.
 *
 * The shape returned here is the *whole* contract for both callers — the
 * bootstrap route embeds it verbatim under a `config` key, and
 * `tests/bootstrap.test.ts` pins that the two stay byte-identical.
 */
export const buildConfigPayload = (
	env: Bindings,
	resolved: ResolvedSettings,
	locale: string,
): Record<string, unknown> => {
	const { flags, numbers } = resolved;
	// Provider client-id/secret env-var names are typed as plain strings on
	// ProviderConfig, so index the bindings through a string-keyed view.
	const envRecord = env as unknown as Record<string, string | undefined>;
	const providers = (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => {
		const cfg = PROVIDERS[p];
		return (
			!!envRecord[cfg.client_id_env] && !!envRecord[cfg.client_secret_env]
		);
	});
	// English costs zero bytes: EN is compiled into the widget bundle. Other
	// locales get their own table only — missing keys fall back to English per
	// key in the widget, which is what lets a partial translation ship.
	const localized =
		locale === FALLBACK_LOCALE
			? {}
			: {
					strings: WIDGET_TABLES[locale] ?? {},
					rtl: LOCALES[locale]?.rtl === true,
				};
	return {
		locale,
		...localized,
		turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
		// Already folded together with both Turnstile credentials
		// (turnstileAlwaysOn), so the widget never has to re-derive "is a
		// challenge possible here" — an install with the flag on but no key or
		// no secret reports false, exactly matching what the POST handler will
		// enforce.
		turnstile_always: turnstileAlwaysOn(
			flags.turnstile_always,
			env.TURNSTILE_SITE_KEY,
			env.TURNSTILE_SECRET,
		),
		edit_window_minutes: numbers.edit_window_minutes,
		providers,
		branding_hidden: isTruthy(env.BRANDING_HIDDEN),
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
		// Derived, not an operator setting: "can this install send mail at all".
		// Both are required for a double-opt-in — without EMAIL_FROM there is
		// nothing to send from, and without PUBLIC_BASE_URL the confirmation link
		// in the mail has no origin to point at. `POST /api/v1/subscribe` already
		// fails closed with 503 on exactly this pair; the flag lets the widget
		// avoid *offering* a subscription it knows would 503. RESEND_API_KEY is
		// deliberately not part of the test — it is a secret, and a widget that
		// went dark when the key alone was missing would hide the misconfiguration
		// rather than surface it (the route logs and refunds send budget instead).
		subscriptions_enabled: !!(env.EMAIL_FROM && env.PUBLIC_BASE_URL),
		// Display/pagination. comments_per_page drives the server-side page
		// slice (included here for parity/debuggability); the widget consumes
		// replies_per_thread and auto_collapse_depth for client-side reply
		// collapsing.
		// The body-length ceiling the widget counts down against. Not operator
		// tunable — it is a constant in lib/markdown.ts, shipped here only so the
		// composer and the validator can never disagree about it.
		max_body_chars: MAX_BODY_CHARS,
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
	};
};

config.get("/", async (c) => {
	// Flags, numeric display settings and string settings, all resolved with
	// DB-override > env > default precedence. One call rather than three
	// per-group ones: this route needs every group, and they share a cache entry
	// and a single D1 read — asking for them separately would just be three
	// concurrent misses racing to derive the same object.
	const resolved = await loadSettings(c.env);
	const locale = resolveConfigLocale(
		c.req.query("lang"),
		c.req.query("hl"),
		resolved.strings.default_locale,
	);
	return c.json(buildConfigPayload(c.env, resolved, locale));
});

export { config };
