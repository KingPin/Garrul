/**
 * The widget's mount request.
 *
 * `GET /api/v1/bootstrap` answers, in one Worker invocation, what `/config`,
 * `/auth/me`, `/comments`, `/page-engagement` and `/subscribe/mine` each used to
 * answer separately. This module is the client half of it: the two fetches, the
 * locale-negotiation inputs they carry, and — the part that matters most — the
 * rule for when an answer is *unusable* and the caller has to fall back to the
 * five calls it replaced.
 *
 * It lives apart from embed.ts because it touches the network and never the DOM,
 * which makes it the one half of the boot path testable in the plain node pool
 * (`tests/widget-boot.test.ts`). Everything downstream of it renders, and
 * rendering needs a browser.
 *
 * The fallback is not a nicety. A self-hosted operator upgrades `embed.js`
 * (served by their Worker) and the Worker itself in one deploy, but a *cached*
 * bundle outlives a rollback, and someone pinning `embed.js` from one origin
 * against an older Worker on another is a supported shape. Getting this wrong
 * does not throw — it renders an empty comment list on a post that has comments.
 */

/** Newest-first or by rank. Matches `?sort=` on both mount calls. */
export type SortKey = "new" | "top";

export type PageVoteState = {
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
};

/**
 * `GET /api/v1/config`, and the byte-identical `config` section of
 * `GET /api/v1/bootstrap`.
 *
 * Every field is optional because this bundle has to render against a Worker
 * older than itself. The defaults in embed.ts's `loadOnce` are the contract for
 * what an absent field means, and they mirror the server's own
 * (`src/lib/settings.ts`).
 */
export type ConfigResponse = {
	turnstile_site_key?: string;
	turnstile_always?: boolean;
	edit_window_minutes?: number;
	max_body_chars?: number;
	providers?: string[];
	branding_hidden?: boolean;
	comments_enabled?: boolean;
	reactions_enabled?: boolean;
	voting_enabled?: boolean;
	downvotes_enabled?: boolean;
	page_reactions_enabled?: boolean;
	page_votes_enabled?: boolean;
	subscriptions_enabled?: boolean;
	replies_per_thread?: number;
	auto_collapse_depth?: number;
	community_min_votes?: number;
	community_collapse_ratio?: number;
	locale?: string;
	strings?: Record<string, string | Record<string, string>>;
	rtl?: boolean;
};

/** `GET /api/v1/page-engagement`, and bootstrap's `engagement` section. */
export type EngagementSection = {
	reactions?: Record<string, number>;
	my_reactions?: string[];
	votes?: PageVoteState;
};

/** `GET /api/v1/subscribe/mine`, and bootstrap's `subscription` section. */
export type SubscriptionSection = {
	subscribed?: boolean;
	pending?: boolean;
	id?: string | null;
};

/** `GET /api/v1/bootstrap` — every mount-time payload in one invocation. */
export type BootstrapResponse = {
	config?: ConfigResponse;
	/**
	 * Handed through uncast. Their real shapes (`Me`, `ListResponse`) belong to
	 * the renderer and this module has no business knowing them; it only checks
	 * that `comments` *looks* like a tree, which is the single question that
	 * decides whether the answer is mountable. The caller casts on receipt,
	 * exactly as it already does for the `/auth/me` and `/comments` bodies.
	 */
	user?: unknown;
	comments: unknown;
	engagement?: EngagementSection;
	subscription?: SubscriptionSection;
};

/**
 * Mount-time state the bootstrap call already answered, handed to the two
 * surfaces that used to fetch their own.
 *
 * `bootstrapped` is the load-bearing field, not the sections. It says the mount
 * asked every mount-time question in one request, so a *missing* section means
 * "nothing to show here", never "go and ask". Without it, a signed-in reader
 * whose `subscription` section was omitted — banned, erased, or an install with
 * no mail configured — would fall back to fetching `/subscribe/mine` and hand
 * back the invocation bootstrap just saved, to be told the same nothing.
 */
export type MountSeed = {
	bootstrapped: boolean;
	// Explicitly `| undefined` rather than bare optional: exactOptionalPropertyTypes
	// is on, and this object is built by *copying* two possibly-absent sections
	// across rather than by omitting keys.
	engagement?: EngagementSection | undefined;
	subscription?: SubscriptionSection | undefined;
};

/**
 * The locale negotiation inputs, as query params.
 *
 * The two calls that carry these are the only ones that cannot go through
 * embed.ts's `apiUrl()`: they are what *resolves* the locale, so they send the
 * raw inputs instead of the resolved answer. `hl` stays separate from `lang`
 * because the server treats them differently — an unreviewed translation is
 * reachable only through the operator's explicit `data-lang`, never through a
 * theme's stray `<html lang>`.
 */
const localeParams = (
	qs: URLSearchParams,
	langExplicit: string,
	langHint: string,
): void => {
	if (langExplicit) qs.set("lang", langExplicit);
	if (langHint) qs.set("hl", langHint);
};

/**
 * Send the session cookie. Both mount calls are cross-site by definition — the
 * widget runs on the host page's origin and the Worker is somewhere else — so
 * without this every reader is permanently signed out and `user` and
 * `subscription` are always absent.
 *
 * It is a constant, and cast, for one reason: `credentials` is a browser-only
 * `RequestInit` field, and `tests/widget-boot.test.ts` imports this module into
 * the *Worker*-typed program (`tsconfig.json` excludes `src/widget`, which stops
 * it being compiled on its own but not from being pulled in by an import), where
 * `@cloudflare/workers-types` declares a `RequestInit` that has no such field.
 * The authoritative check on this file is still `tsconfig.widget.json`. The cast
 * is the seam between those two global type sets, not a claim about the value —
 * so keep it to this one line rather than casting at a call site, and keep the
 * rest of the module free of browser-only API surface.
 */
const CREDENTIALED = { credentials: "include" } as unknown as RequestInit;

/**
 * `GET /api/v1/config`. Only the legacy boot path calls this — a bootstrapped
 * mount already has the same body in hand.
 *
 * Throws on a network failure, and answers `null` on any non-2xx: the caller
 * wraps both in the same catch, because a missing config degrades to documented
 * defaults rather than to an error.
 */
export const fetchConfig = async (
	apiBase: string,
	langExplicit: string,
	langHint: string,
): Promise<ConfigResponse | null> => {
	const qs = new URLSearchParams();
	localeParams(qs, langExplicit, langHint);
	const query = qs.toString();
	const res = await fetch(
		`${apiBase}/api/v1/config${query ? `?${query}` : ""}`,
		CREDENTIALED,
	);
	return res.ok ? ((await res.json()) as ConfigResponse) : null;
};

/**
 * The mount request: config, session, the first page of comments, and the two
 * optional surfaces, in one Worker invocation instead of up to five.
 *
 * Answers `null` for *any* unusable response — a 404 from a Worker that predates
 * the endpoint, any other non-2xx, a body with no comment tree in it, or a
 * network failure. The caller then runs exactly the boot path this replaced.
 *
 * One bucket on purpose: the fallback *is* the old code, so *why* bootstrap
 * could not answer changes nothing about what to do next. A genuine outage still
 * surfaces to the reader as an error, because the legacy tree fetch fails too
 * and that is the call whose failure renders one.
 */
export const fetchBootstrap = async (
	apiBase: string,
	slug: string,
	sort: SortKey,
	langExplicit: string,
	langHint: string,
): Promise<BootstrapResponse | null> => {
	try {
		const qs = new URLSearchParams({ slug });
		if (sort !== "new") qs.set("sort", sort);
		localeParams(qs, langExplicit, langHint);
		const res = await fetch(
			`${apiBase}/api/v1/bootstrap?${qs.toString()}`,
			CREDENTIALED,
		);
		if (!res.ok) return null;
		const body = (await res.json()) as BootstrapResponse | null;
		if (!body) return null;
		// A thread array is what "this is a mountable answer" means. Anything else
		// — an error envelope, a truncated proxy response, a captive portal's login
		// page served as JSON — is not one, and the legacy path is a far better
		// guess than rendering an empty thread list as if the post had no comments.
		const tree = body.comments as { threads?: unknown } | null;
		if (!tree || !Array.isArray(tree.threads)) return null;
		return body;
	} catch {
		return null;
	}
};
