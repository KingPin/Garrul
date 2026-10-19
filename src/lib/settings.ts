/**
 * Hybrid feature-flag resolution.
 *
 * Garrul's configuration was historically env-var-only (per-deploy). This
 * layer adds a runtime override: a row in the `settings` D1 table beats the
 * matching env var, which in turn falls back to a hardcoded default.
 *
 *   precedence:  DB row  >  env var  >  default
 *
 * Operators flip these from the admin Settings page (writes a `settings`
 * row, no redeploy). Leaving a flag "inherit" writes no row, so the env var
 * / default still applies and existing installs are unaffected.
 *
 * Comment-level features default ON (preserve current behavior). The new
 * page-level features default OFF so upgrading doesn't surface new UI on an
 * instance that never opted in.
 *
 * The resolved object is cached in KV (TREE_CACHE) for a short TTL so the
 * hot path — GET /api/v1/config, hit on every widget mount — avoids a D1
 * read. The admin save path busts the cache. (An env-var change via redeploy
 * can be masked by a warm cache for up to the TTL; acceptable.)
 */
import type { Bindings } from "../index";
import { COMMENT_SORTS, getAllSettings } from "../db/queries";
import { LOCALES } from "../i18n";
import { AUTO_LOCALE } from "../i18n/negotiate";
import { DEFAULT_REACTION_KINDS, REACTION_KIND_SET } from "../widget/reactions";
import { MAX_DEPTH } from "./tree";

export type FlagKey =
	| "comments_enabled"
	| "reactions_enabled"
	| "votes_enabled"
	| "downvotes_enabled"
	| "page_reactions_enabled"
	| "page_votes_enabled"
	| "show_deleted_placeholders"
	| "spam_first_comment_moderate"
	| "moderator_email_enabled"
	| "turnstile_always";

export type ResolvedFlags = Record<FlagKey, boolean>;

export type NumberKey =
	| "comments_per_page"
	| "replies_per_thread"
	| "auto_collapse_depth"
	| "auto_close_days"
	| "auto_close_at"
	| "community_min_votes"
	| "community_collapse_ratio"
	| "edit_window_minutes"
	| "spam_link_threshold"
	| "spam_honeypot_min_ms"
	| "spam_ai_threshold"
	| "ip_hash_retention_days"
	| "audit_log_retention_days"
	| "confirm_send_burst_max"
	| "confirm_send_daily_max";

export type ResolvedNumbers = Record<NumberKey, number>;

export type StringSettingKey = "default_locale" | "default_sort";

export type ResolvedStrings = Record<StringSettingKey, string>;

/** The two ordered-list text settings: which reaction kinds each surface offers. */
export const REACTION_KINDS_KEYS = [
	"comment_reaction_kinds",
	"page_reaction_kinds",
] as const;
export type ReactionKindsKey = (typeof REACTION_KINDS_KEYS)[number];

export type TextSettingKey =
	| "spam_blocklist"
	| "security_contact"
	| "staff_badge_label"
	| "reserved_names"
	| ReactionKindsKey;

export type ResolvedTexts = Record<TextSettingKey, string>;

// Each flag's env-var source and hardcoded default. `votes_enabled` /
// `downvotes_enabled` keep their legacy env names so existing wrangler.toml
// vars keep working.
const FLAGS: Record<FlagKey, { env: keyof Bindings; default: boolean }> = {
	comments_enabled: { env: "COMMENTS_ENABLED", default: true },
	reactions_enabled: { env: "REACTIONS_ENABLED", default: true },
	votes_enabled: { env: "VOTING_ENABLED", default: true },
	downvotes_enabled: { env: "DOWNVOTES_ENABLED", default: true },
	page_reactions_enabled: { env: "PAGE_REACTIONS_ENABLED", default: false },
	page_votes_enabled: { env: "PAGE_VOTES_ENABLED", default: false },
	// When OFF (default) a deleted comment with no surviving replies is pruned
	// from the public tree — current behavior. When ON, every deleted comment
	// is kept and rendered as a placeholder ("[deleted]" / "[removed by a
	// moderator]"), so threads never silently lose entries.
	show_deleted_placeholders: {
		env: "SHOW_DELETED_PLACEHOLDERS",
		default: false,
	},
	// Route every comment to `pending` until the author has one approved. A moderation
	// dial an operator wants to flip while watching the queue, so it resolves
	// here rather than requiring a redeploy. Note the env var was historically
	// matched with `=== "true"`; parseBool is laxer (any non-falsy string is
	// true), which only ever turns a previously-ignored value like "yes" on.
	spam_first_comment_moderate: {
		env: "SPAM_FIRST_COMMENT_MODERATE",
		default: false,
	},
	// Email the operator when a comment lands in the queue or gets reported
	// (src/lib/moderator-digest.ts). Default OFF for the usual upgrade reason,
	// with an extra one behind it: this is *outbound mail*, so an install that
	// silently started sending on upgrade would spend someone's Resend quota and
	// their sending domain's reputation without being asked.
	//
	// The flag also gates the enqueue, not just the send — with it off, an
	// instance writes no moderator_notifications rows at all rather than
	// accumulating a queue nobody drains.
	moderator_email_enabled: {
		env: "MODERATOR_EMAIL_ENABLED",
		default: false,
	},
	// Challenge signed-in authors too, instead of only anonymous ones. OFF
	// preserves the historical rule (session = no challenge); ON is for
	// operators seeing scripted posting from throwaway OAuth accounts, who
	// would rather every commenter solve a challenge than moderate the fallout.
	// Inert without TURNSTILE_SITE_KEY *and* TURNSTILE_SECRET — see
	// turnstileAlwaysOn in lib/turnstile.ts for why both credentials are part of
	// the predicate rather than separate guards.
	turnstile_always: {
		env: "TURNSTILE_ALWAYS",
		default: false,
	},
};

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

// Numeric display settings. Same precedence chain as FLAGS (DB > env >
// default), but each carries a [min, max] clamp so a junk or hostile value
// (negative, or a huge `comments_per_page` that would slice an enormous
// in-memory page) can't reach the slice/render paths.
const NUMBERS: Record<
	NumberKey,
	{ env: keyof Bindings; default: number; min: number; max: number }
> = {
	// Top-level threads per initial load and per Load-more click (server-side
	// slice in api.comments.ts).
	comments_per_page: { env: "COMMENTS_PER_PAGE", default: 25, min: 1, max: 200 },
	// Replies shown per parent before a "Show N more replies" button (widget).
	// 0 = show all replies.
	replies_per_thread: { env: "REPLIES_PER_THREAD", default: 3, min: 0, max: 100 },
	// A comment at depth >= this starts with its replies collapsed (widget).
	// 0 = never auto-collapse. Capped at the tree's MAX_DEPTH so the clamp
	// tracks the depth cap if it ever changes.
	auto_collapse_depth: {
		env: "AUTO_COLLAPSE_DEPTH",
		default: 3,
		min: 0,
		max: MAX_DEPTH,
	},
	// Thread auto-close: close a thread this many days after its publish anchor
	// (posts.published_at, else posts.created_at). 0 = disabled. Evaluated lazily
	// at read/write time (src/lib/thread.ts) — no cron, no status flips.
	auto_close_days: {
		env: "AUTO_CLOSE_DAYS",
		default: 0,
		min: 0,
		max: 3650,
	},
	// Instance-wide sunset: close ALL threads at/after this epoch-ms instant.
	// 0 = disabled. The admin UI exposes a date picker that writes the epoch.
	// Max ~ year 2100 so a fat-fingered value can't overflow the clamp.
	auto_close_at: {
		env: "AUTO_CLOSE_AT",
		default: 0,
		min: 0,
		max: 4102444800000,
	},
	// Community auto-collapse floor: minimum total votes (up+down) on a comment
	// before the collapse ratio is allowed to apply. Mandatory brigading guard —
	// without it a single downvote is 100% and would fold every new comment.
	community_min_votes: {
		env: "COMMUNITY_MIN_VOTES",
		default: 5,
		min: 0,
		max: 1000,
	},
	// Community auto-collapse ratio: percent of downvotes/total that folds a
	// comment (client-side, reversible, expandable). 0 = disabled. Gated on
	// downvotes_enabled. Applied only once community_min_votes is met.
	community_collapse_ratio: {
		env: "COMMUNITY_COLLAPSE_RATIO",
		default: 0,
		min: 0,
		max: 100,
	},
	// Minutes an author may edit their own comment after posting. 0 = editing
	// disabled outright.
	//
	// The pre-settings code fell back to 5 minutes when the env var was unset
	// or non-positive, while wrangler.example.toml, INSTALL.md and the admin
	// Configuration table all advertised 15. A single resolver can only have one
	// default, so it's 15 — the documented number, and the one every shipped
	// wrangler.toml already sets explicitly. Installs that omitted the var move
	// 5 → 15; installs that set it are unaffected. An explicit 0 now means "no
	// editing" instead of silently meaning 5.
	//
	// The ceiling is a week rather than a day because the pre-settings code had
	// no ceiling at all: parseIntSetting clamps env values too, so any max we
	// pick silently shortens the window for an install that already configured a
	// longer one. A week covers every realistic "let people fix typos later"
	// policy while keeping the stepper a sane range.
	edit_window_minutes: {
		env: "EDIT_WINDOW_MINUTES",
		default: 15,
		min: 0,
		max: 10_080,
	},
	// Flag a comment to `pending` when it carries MORE than this many links.
	// -1 = check disabled; 0 = flag any comment containing a link.
	//
	// The sentinel is load-bearing: this signal has always had three states, and
	// "off" could not collapse onto 0 without redefining what 0 does for anyone
	// running SPAM_LINK_THRESHOLD="0" today. An unset or junk env var resolves to
	// -1, matching the old `Number.isFinite(n) && n >= 0` gate.
	spam_link_threshold: {
		env: "SPAM_LINK_THRESHOLD",
		default: -1,
		min: -1,
		max: 50,
	},
	// Flag a comment to `pending` when the form was submitted faster than this
	// many milliseconds. 0 = disabled, which is also where an unset or junk env
	// var lands — the old gate was `> 0`, so no existing value changes meaning.
	// Only enforced when SPAM_FORM_TS_SECRET is also set (the timestamp is
	// HMAC-signed; unsigned timing is trivially forged).
	spam_honeypot_min_ms: {
		env: "SPAM_HONEYPOT_MIN_MS",
		default: 0,
		min: 0,
		max: 60_000,
	},
	// Queue a comment when the Workers AI classifier (Clef-flash) puts its spam
	// probability at or above this percent. Only read when
	// SPAM_PROVIDER=workers-ai. min is 1, not 0: 0 would queue every comment,
	// which is first-comment moderation for everyone, not a classifier.
	spam_ai_threshold: {
		env: "SPAM_AI_THRESHOLD",
		default: 70,
		min: 1,
		max: 100,
	},
	// Clear `comments.ip_hash` / `user_agent` and `reports.reporter_ip_hash`
	// once the row is this many days old. 0 = disabled (the default, so an
	// upgrade never starts deleting data an operator didn't ask it to).
	//
	// Unlike every other dial here, the effect is IRREVERSIBLE — the sweep
	// nulls columns, and nothing reconstructs them. Two consequences for the
	// shape of this entry:
	//
	//   - The default has to be 0. A shipped non-zero default would purge
	//     history on the first cron tick after an upgrade, before the operator
	//     had any chance to read the release notes.
	//   - The clamp cannot make the dangerous direction reachable by accident.
	//     min is 0 rather than a floor like 7 precisely because parseIntSetting
	//     clamps into [min, max]: a floor would rewrite an operator's explicit
	//     0 ("off") into 7 ("purge everything older than a week"), turning the
	//     safe value into the destructive one. The floor lives in the sweep
	//     instead (MIN_RETENTION_DAYS in src/db/ip-retention.ts), which refuses
	//     to run below it rather than silently substituting.
	//
	// Max is 3650 (10 years), matching auto_close_days — the other lifecycle
	// timer measured in days.
	ip_hash_retention_days: {
		env: "IP_HASH_RETENTION_DAYS",
		default: 0,
		min: 0,
		max: 3650,
	},
	// Same shape and the same "0 means keep forever" default, with a higher
	// refusal floor (30 days) because a moderation record stays useful far longer
	// than a hashed IP — see MIN_AUDIT_RETENTION_DAYS in src/db/audit-retention.ts.
	audit_log_retention_days: {
		env: "AUDIT_LOG_RETENTION_DAYS",
		default: 0,
		min: 0,
		max: 3650,
	},
	// The global ceiling on outbound confirmation email (src/lib/email-budget.ts).
	// Only the caps resolve here; the windows they divide stay constants, because
	// what an operator needs to change is "how many", not "over what period" —
	// and two dials are easier to reason about than four.
	//
	// min is 1, not 0, and that is the one place these differ from the retention
	// dials above: 0 would resolve to a ceiling that denies every confirmation
	// email, which reads as "off" but means "subscriptions are broken". There is
	// no "off" for a ceiling — an operator who wants effectively-unlimited sets
	// the max. The clamp therefore has no value that silently disables signups.
	confirm_send_burst_max: {
		env: "CONFIRM_SEND_BURST_MAX",
		default: 20,
		min: 1,
		max: 10_000,
	},
	confirm_send_daily_max: {
		env: "CONFIRM_SEND_DAILY_MAX",
		default: 200,
		min: 1,
		max: 100_000,
	},
};

export const NUMBER_KEYS = Object.keys(NUMBERS) as NumberKey[];

// String-valued settings. Same precedence chain as FLAGS/NUMBERS (DB > env >
// default), but the safety property is different: a number is made safe by
// clamping, whereas a string is made safe by being *one of a known set*. Every
// entry therefore carries an `options` whitelist and anything outside it —
// junk, hostile, or merely stale — resolves to the built-in default rather
// than being escaped and passed along.
//
// `options` is a function rather than an array so the set is read at use time.
// The locale registry is the source of truth for which locales exist, and a
// snapshot taken at module load would silently go stale the moment locales are
// registered somewhere other than at the top of the module graph.
const STRINGS: Record<
	StringSettingKey,
	{ env: keyof Bindings; default: string; options: () => string[] }
> = {
	// The locale the widget, the feed and notification emails render in when the
	// embed doesn't ask for one explicitly.
	//
	// The default is the `auto` sentinel, not `"en"`, and the difference is
	// load-bearing: `auto` means "never configured", which lets negotiation fall
	// through to the host page's `<html lang>` hint. An explicit `"en"` means the
	// operator chose English and the hint is ignored. Collapsing the two would
	// make "I want English no matter what the theme says" unexpressible.
	//
	// The end of that chain is `FALLBACK_LOCALE` in src/i18n — deliberately not
	// named DEFAULT_LOCALE, so the constant and this env var can't be confused
	// for each other in an import list.
	default_locale: {
		env: "DEFAULT_LOCALE",
		default: AUTO_LOCALE,
		options: () => [AUTO_LOCALE, ...Object.keys(LOCALES)],
	},
	// The order a thread is served in when the embed doesn't ask for one.
	//
	// No `auto` sentinel here, unlike default_locale: there is no host-page hint
	// to fall through to, so "never configured" and "chose newest" want the same
	// behavior and a sentinel would only add a state with nothing behind it.
	//
	// `new` stays the default because it is what every existing install already
	// serves — an upgrade must not silently reorder every thread on the site.
	// Operators who want chronological order now have one place to say so.
	//
	// Options come from COMMENT_SORTS so the whitelist can't drift from the
	// sorts the query layer actually implements; `top` among them is why
	// resolveDefaultSort exists (see api.comments) — it is meaningless with
	// voting off and is coerced there rather than being hidden here, so turning
	// voting back on restores the operator's stated preference.
	default_sort: {
		env: "DEFAULT_SORT",
		default: "new",
		options: () => [...COMMENT_SORTS],
	},
};

export const STRING_KEYS = Object.keys(STRINGS) as StringSettingKey[];

/**
 * Upper bound on a stored text setting, in characters.
 *
 * Free-form operator text is the one settings shape that can't be made safe by
 * clamping (numbers) or by a whitelist (strings), so the safety property here is
 * *boundedness*: the value rides in the KV settings blob read on every widget
 * mount, and it is re-parsed on the comment-POST path. 20k characters is far
 * more than any real muted-words list and still leaves the blob small.
 *
 * Per-term limits are the matcher's business, not this layer's — see
 * `parseBlocklist` in src/lib/spam/blocklist.ts, which drops individual terms
 * that are too long or too wildcard-heavy. This cap only stops the *setting*
 * from becoming unbounded.
 */
export const MAX_TEXT_SETTING_CHARS = 20_000;

/** Cap on the staff badge label: it sits inline next to a commenter's name. */
export const STAFF_BADGE_LABEL_MAX = 32;

// Free-form text settings. Same precedence chain as everything above
// (DB > env > default), but neither clamped nor whitelisted — see
// MAX_TEXT_SETTING_CHARS for why boundedness is the invariant instead.
//
// Values are stored raw and parsed at the point of use. Storing the parsed form
// here would push a parser's output through the memo, so a change to the
// grammar would wait out the memo window; a raw string
// re-parsed downstream costs microseconds and can never go stale against the
// code that reads it.
//
// `env` is optional and `max` overrides the global MAX_TEXT_SETTING_CHARS cap
// per key — added for staff_badge_label, which is DB-only (no env var) and
// far shorter than a muted-words list.
const TEXTS: Record<
	TextSettingKey,
	{ env?: keyof Bindings; default: string; max?: number }
> = {
	// Operator-maintained muted-words list, one term per line. Empty by default:
	// this is a moderation policy, and an upgrade must never start holding
	// comments against a list the operator didn't write.
	spam_blocklist: { env: "SPAM_BLOCKLIST", default: "" },
	// Vulnerability-disclosure contact for /.well-known/security.txt (RFC 9116):
	// an email address or an https:// URL. Empty by default — the route serves
	// 404 until the operator opts in, because a Contact field is the one thing
	// the RFC makes mandatory and inventing one would point researchers nowhere.
	security_contact: { env: "SECURITY_CONTACT", default: "" },
	// Operator wording for the widget's staff badge. Empty (the default) means
	// "use the reader's locale string", so the badge stays translated until an
	// operator deliberately picks one word for everyone. No env var: this is
	// presentation, set from the Settings page, and a deploy-time default would
	// cost an env name across every install doc for no operator benefit.
	staff_badge_label: { default: "", max: STAFF_BADGE_LABEL_MAX },
	// Names an anonymous commenter may not post under, one per line, on top of
	// the names signed-in users already post under (isNameClaimed). Empty by
	// default and DB-only, for the same reasons as staff_badge_label.
	reserved_names: { default: "" },
	// Which reaction kinds each surface offers, in render order, as a
	// comma-separated list of vocabulary kinds (src/widget/reactions.ts).
	// Stored raw like the rest of this group and normalized at use by
	// `reactionKinds`, so a row naming a kind a later release drops still
	// resolves to the kinds that remain.
	//
	// No env var, deliberately: an env name costs a config-registry entry, a
	// manifest bump and a docs-gate update, for a list nobody pins per deploy.
	// The Settings page is the only writer and Reset restores the default —
	// the six kinds every install shipped with, so an upgrade renders exactly
	// what it rendered before.
	comment_reaction_kinds: { default: DEFAULT_REACTION_KINDS.join(",") },
	page_reaction_kinds: { default: DEFAULT_REACTION_KINDS.join(",") },
};

export const TEXT_KEYS = Object.keys(TEXTS) as TextSettingKey[];

export const isReactionKindsKey = (key: string): key is ReactionKindsKey =>
	(REACTION_KINDS_KEYS as readonly string[]).includes(key);

/**
 * Save-path check for a reaction-kind list. Strict, like the string
 * whitelist: every entry must be a known kind and there must be at least
 * one. A stale admin page must not quietly save a different list than the
 * one it shows. Repeats are folded rather than rejected — they are harmless
 * and the chip UI can't produce them. Returns the canonical form, or null.
 */
export const canonicalReactionKinds = (raw: string): string | null => {
	const parts = raw.split(",").map((k) => k.trim());
	if (parts.some((k) => !REACTION_KIND_SET.has(k))) return null;
	return [...new Set(parts)].join(",");
};

/**
 * The enabled kinds for one surface, in the operator's order. Lenient,
 * because a resolver has nobody to report to: unknown kinds and repeats are
 * dropped, and an empty result means the default. `undefined` is a real
 * input — a settings blob cached by the previous release has no such key.
 */
export const reactionKinds = (
	texts: ResolvedTexts,
	key: ReactionKindsKey,
): string[] => {
	const raw = (texts[key] as string | undefined) ?? "";
	const kinds = [...new Set(raw.split(",").map((k) => k.trim()))].filter((k) =>
		REACTION_KIND_SET.has(k),
	);
	return kinds.length > 0 ? kinds : [...DEFAULT_REACTION_KINDS];
};

/** Per-key length cap for a text setting (save path rejects, resolver truncates). */
export const textMax = (key: TextSettingKey): number =>
	TEXTS[key].max ?? MAX_TEXT_SETTING_CHARS;

/** The accepted values for a string setting (used by the admin UI + save path). */
export const stringOptions = (key: StringSettingKey): string[] =>
	STRINGS[key].options();

/** The built-in default for a string setting, for the admin UI's option list. */
export const stringDefault = (key: StringSettingKey): string =>
	STRINGS[key].default;

/** Min/max clamp bounds for a numeric setting (used by the admin UI inputs). */
export const numberBounds = (
	key: NumberKey,
): { default: number; min: number; max: number } => {
	const { default: def, min, max } = NUMBERS[key];
	return { default: def, min, max };
};

// Settings are resolved once per isolate per memo window and served from
// module memory. KV used to front this (one entry, hour TTL) and the entry
// re-populated on every miss — from anonymous traffic, on every colo, against
// a free-tier cap of 1000 KV writes/day account-wide. With no writer on the
// read path the entry is a guaranteed miss, so the read went too: memo → D1.
//
// The name is kept only so `bustSettingsCache` can delete an entry written by
// a pre-upgrade isolate during a rolling deploy.
const CACHE_KEY_RESOLVED = "settings:resolved";
// Staleness bound across isolates after a save or an env-var redeploy. Same
// isolate is immediate (see `generation`). 60 s costs one read of ≤~35
// `settings` rows per active isolate per memo window — nothing against 5M D1 rows/day — and
// replaces an up-to-an-hour bound that AGENTS-OPERATE.md used to document.
const SETTINGS_MEMO_MS = 60_000;

// Defaults-on/off boolish parse: present + falsy → false; anything else
// non-empty → true. Mirrors api.votes.ts / api.config.ts semantics so the
// widget, server gates, and admin UI all agree.
const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
	if (raw == null) return fallback;
	const v = raw.trim().toLowerCase();
	if (v === "") return fallback;
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	return true;
};

// Parse an integer setting and clamp it into [min, max]. Junk / empty / NaN
// falls back to `fallback` (which callers pass already inside the bounds).
export const parseIntSetting = (
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number => {
	if (raw == null) return fallback;
	const v = raw.trim();
	if (v === "") return fallback;
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
};

/**
 * Resolve a string setting against a whitelist. Anything not on the list —
 * empty, junk, hostile, or a locale that used to exist and no longer does —
 * falls back to `fallback`.
 *
 * Matching is case-insensitive and returns the *canonical* option, so an
 * operator writing `DEFAULT_LOCALE="EN"` gets `en` rather than the default.
 * It is deliberately not laxer than that: this is a whitelist, and a value
 * that isn't on it must not be repaired into something that is.
 */
export const parseStringSetting = (
	raw: string | undefined,
	fallback: string,
	options: readonly string[],
): string => {
	if (raw == null) return fallback;
	const v = raw.trim().toLowerCase();
	if (v === "") return fallback;
	return options.find((opt) => opt.toLowerCase() === v) ?? fallback;
};

/**
 * Resolve a free-form text setting: trim, then truncate to the cap.
 *
 * Truncation is deliberately silent and lossy at *read* time, because a
 * resolver has no way to report. The admin save path rejects an over-long value
 * outright (see POST /admin/settings) so the only way to reach the cap here is
 * an env var, where a truncated muted-words list still fails safe: terms are
 * newline-delimited and a clipped tail drops terms rather than corrupting the
 * ones before it.
 */
export const parseTextSetting = (
	raw: string | undefined,
	fallback: string,
	max = MAX_TEXT_SETTING_CHARS,
): string => {
	if (raw == null) return fallback;
	const v = raw.trim();
	if (v === "") return fallback;
	return v.length > max ? v.slice(0, max) : v;
};

const resolveTexts = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedTexts => {
	const out = {} as ResolvedTexts;
	for (const key of TEXT_KEYS) {
		const spec = TEXTS[key];
		const raw =
			key in dbSettings
				? dbSettings[key]
				: spec.env
					? (env[spec.env] as string | undefined)
					: undefined;
		out[key] = parseTextSetting(raw, spec.default, textMax(key));
	}
	return out;
};

const resolveStrings = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedStrings => {
	const out = {} as ResolvedStrings;
	for (const key of STRING_KEYS) {
		const spec = STRINGS[key];
		const raw =
			key in dbSettings
				? dbSettings[key]
				: (env[spec.env] as string | undefined);
		out[key] = parseStringSetting(raw, spec.default, spec.options());
	}
	return out;
};

const resolveNumbers = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedNumbers => {
	const out = {} as ResolvedNumbers;
	for (const key of NUMBER_KEYS) {
		const spec = NUMBERS[key];
		const raw =
			key in dbSettings
				? dbSettings[key]
				: (env[spec.env] as string | undefined);
		out[key] = parseIntSetting(raw, spec.default, spec.min, spec.max);
	}
	return out;
};

const resolve = (
	env: Bindings,
	dbSettings: Record<string, string>,
): ResolvedFlags => {
	const out = {} as ResolvedFlags;
	for (const key of FLAG_KEYS) {
		const spec = FLAGS[key];
		if (key in dbSettings) {
			// DB row wins. Fall back to the default if the stored string is junk.
			out[key] = parseBool(dbSettings[key], spec.default);
		} else {
			out[key] = parseBool(env[spec.env] as string | undefined, spec.default);
		}
	}
	return out;
};

/** Every resolved settings group, as held in the per-isolate memo. */
export interface ResolvedSettings {
	readonly flags: ResolvedFlags;
	readonly numbers: ResolvedNumbers;
	readonly strings: ResolvedStrings;
	readonly texts: ResolvedTexts;
}

/** Read D1 and resolve every group. */
const deriveSettings = async (env: Bindings): Promise<ResolvedSettings> => {
	const dbSettings = await getAllSettings(env.DB);
	return {
		flags: resolve(env, dbSettings),
		numbers: resolveNumbers(env, dbSettings),
		strings: resolveStrings(env, dbSettings),
		texts: resolveTexts(env, dbSettings),
	};
};

/**
 * Memo of the last derivation plus the derivation in flight, if any.
 *
 * Concurrent cold callers share one derivation (one D1 read per burst, not
 * one per request). `generation` makes `bustSettingsCache` immediate in this
 * isolate: a derive captures the generation it started under and, on settle,
 * publishes into the memo only if no bust happened meanwhile; a caller that
 * arrives after a bust never joins the pre-bust promise. Without that, a load
 * that began before an admin save could finish after it and pin old values
 * for another memo window.
 *
 * Module state is safe for the same reason the plural-rules cache in
 * src/i18n/index.ts is: nothing request-scoped is stored.
 */
let memo: { value: ResolvedSettings; at: number } | null = null;
let inFlight: Promise<ResolvedSettings> | null = null;
let generation = 0;

/**
 * Resolve every setting (DB override > env > default), memoized per isolate.
 *
 * Prefer this over the per-group helpers when a caller needs more than one
 * group: it makes the single derivation explicit at the call site.
 */
export const loadSettings = async (
	env: Bindings,
): Promise<ResolvedSettings> => {
	const now = Date.now();
	if (memo && now - memo.at < SETTINGS_MEMO_MS) return memo.value;
	if (inFlight) return inFlight;
	const started = generation;
	const pending = deriveSettings(env).then(
		(value) => {
			if (generation === started) {
				memo = { value, at: Date.now() };
				inFlight = null;
			}
			return value;
		},
		(err) => {
			if (generation === started) inFlight = null;
			throw err;
		},
	);
	inFlight = pending;
	return pending;
};

/** Resolved feature flags. */
export const loadFlags = async (env: Bindings): Promise<ResolvedFlags> =>
	(await loadSettings(env)).flags;

/** Resolved numeric display settings. */
export const loadNumbers = async (env: Bindings): Promise<ResolvedNumbers> =>
	(await loadSettings(env)).numbers;

/**
 * Resolved string settings.
 *
 * Deliberately *not* called from the per-request locale middleware: that runs
 * on every `/api/*` request, and a KV read there would land on routes that read
 * nothing else. The operator default is applied once, at `GET /api/v1/config`,
 * and the widget echoes the resolved locale back on subsequent calls.
 */
export const loadStrings = async (env: Bindings): Promise<ResolvedStrings> =>
	(await loadSettings(env)).strings;

/**
 * Resolved free-form text settings.
 *
 * Not exposed through `GET /api/v1/config` as a group. The muted-words list is
 * moderation policy and must not reach a network tab — it is a map of exactly
 * what to avoid typing. The config route serves only the two reaction-kind
 * lists, which are derived arrays.
 */
export const loadTexts = async (env: Bindings): Promise<ResolvedTexts> =>
	(await loadSettings(env)).texts;

/**
 * Drop the memo so the next read in this isolate re-derives, detach any
 * derive already in flight so it cannot publish pre-save values, and delete
 * the legacy KV entry a pre-upgrade isolate may still write during a rolling
 * deploy. Other isolates pick the change up within SETTINGS_MEMO_MS.
 */
export const bustSettingsCache = (env: Bindings): Promise<void> => {
	generation++;
	memo = null;
	inFlight = null;
	return env.TREE_CACHE.delete(CACHE_KEY_RESOLVED).catch(() => {});
};
