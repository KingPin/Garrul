import type { Bindings } from "../../index";
import { LOCALES } from "../../i18n";
import { AUTO_LOCALE } from "../../i18n/negotiate";
import {
	type FlagKey,
	type NumberKey,
	type ReactionKindsKey,
	type ResolvedFlags,
	type ResolvedNumbers,
	type ResolvedStrings,
	type ResolvedTexts,
	MAX_TEXT_SETTING_CHARS,
	SPAM_DECISIONS_MODEL_MAX,
	STAFF_BADGE_LABEL_MAX,
	TEXT_KEYS,
	isReactionKindsKey,
	numberBounds,
	reactionKinds,
} from "../../lib/settings";
import {
	MAX_TERMS,
	MAX_TERM_CHARS,
	MAX_WILDCARDS,
} from "../../lib/spam/blocklist";
import { REACTION_KINDS } from "../../widget/reactions";
import { EN } from "../../widget/strings";
import {
	renderSelect,
	renderStepper,
	renderSwitch,
	renderTabs,
	renderTextarea,
} from "../controls";
import { escapeHtml, jsLiteralRaw } from "../escape";

// Glyph + English label per kind, seeded into Alpine for the chip lists.
// English only, like the rest of the admin UI; derived from the vocabulary so
// a new kind shows up here without an edit.
const VOCAB_SEED = JSON.stringify(
	Object.fromEntries(
		REACTION_KINDS.map((r) => [r.kind, { emoji: r.emoji, label: EN[r.labelKey] as string }]),
	),
);

// One surface's chip list. The canonical value stays the comma-joined string
// in texts.<key> (the hidden input), so save() posts it like any text setting
// and the server's strict check (canonicalReactionKinds) is the only gate.
const renderKindChips = (key: ReactionKindsKey, label: string, help: string): string => `
<div class="field-stack">
  <span class="field-text">
    <strong>${escapeHtml(label)}</strong>
    <span class="muted">${help}</span>
  </span>
  <input type="hidden" name="${key}" x-model="texts.${key}">
  <ul class="kind-chips">
    <template x-for="kind in chipOrder('${key}')" :key="kind">
      <li class="kind-chip">
        <label>
          <input type="checkbox" :checked="kindOn('${key}', kind)"
                 :disabled="kindOn('${key}', kind) &amp;&amp; kindsOf('${key}').length === 1"
                 @change="toggleKind('${key}', kind)">
          <span aria-hidden="true" x-text="vocab[kind].emoji"></span>
          <span x-text="vocab[kind].label"></span>
        </label>
        <button type="button" class="btn-secondary" x-show="kindOn('${key}', kind)"
                :disabled="kindsOf('${key}').indexOf(kind) === 0"
                :aria-label="'Move ' + vocab[kind].label + ' earlier'"
                @click="moveKind('${key}', kind, -1)">↑</button>
        <button type="button" class="btn-secondary" x-show="kindOn('${key}', kind)"
                :disabled="kindsOf('${key}').indexOf(kind) === kindsOf('${key}').length - 1"
                :aria-label="'Move ' + vocab[kind].label + ' later'"
                @click="moveKind('${key}', kind, 1)">↓</button>
      </li>
    </template>
  </ul>
</div>`;

// Settings tabs. Email / Moderation tabs can slot in here later without
// touching the panel-toggle wiring (each panel just keys off `tab`).
const TABS = [
	{ id: "features", label: "Features" },
	{ id: "display", label: "Display" },
	{ id: "moderation", label: "Moderation" },
	{ id: "config", label: "Configuration" },
];

// Operator-facing labels + help for each runtime feature flag. Order here is
// the order rendered in the toggles card.
const FLAG_META: { key: FlagKey; label: string; help: string }[] = [
	{
		key: "comments_enabled",
		label: "Comments",
		help: "Accept new comments. When off, the composer is hidden and posting is rejected.",
	},
	{
		key: "reactions_enabled",
		label: "Emoji reactions (comments)",
		help: "Per-comment emoji reactions. Choose which emoji, and their order, under Reaction emoji below.",
	},
	{
		key: "votes_enabled",
		label: "Votes (comments)",
		help: "Up/down voting on comments and the sort-by-top option.",
	},
	{
		key: "downvotes_enabled",
		label: "Downvotes",
		help: "Allow the downvote arrow. Ignored while comment votes are off.",
	},
	{
		key: "page_reactions_enabled",
		label: "Page reactions",
		help: "Let readers react to the article itself with an emoji, without leaving a comment.",
	},
	{
		key: "page_votes_enabled",
		label: "Page vote",
		help: "A simple helpful/up vote tally on the article itself.",
	},
	{
		key: "show_deleted_placeholders",
		label: "Show deleted-comment placeholders",
		help: "Keep removed comments in the thread as a placeholder (\"[deleted]\" / \"[removed by a moderator]\") instead of dropping them. Replies are preserved either way.",
	},
];

// Moderation-tab flags. Split from FLAG_META so the Features tab stays a list
// of reader-facing surfaces; both arrays feed the same save payload.
const MOD_FLAG_META: { key: FlagKey; label: string; help: string }[] = [
	{
		key: "spam_first_comment_moderate",
		label: "Hold every author's first comment",
		help: "Route each author's comments to the moderation queue until you approve one of them. Nothing is dropped — you approve or reject it. Cost: one indexed D1 read per comment.",
	},
	{
		key: "turnstile_always",
		label: "Challenge signed-in commenters too",
		help: "Require a Turnstile challenge on every comment, not just anonymous ones. Off by default — a signed-in reader posts without one. Needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET configured; without them this does nothing. Cost: Turnstile itself is free. Each challenge adds one Worker request for the challenge frame and one siteverify call when the comment posts.",
	},
	{
		key: "moderator_email_enabled",
		label: "Email me about the queue",
		help: "Send a digest to ADMIN_EMAILS (or MODERATOR_NOTIFY_EMAILS) when comments land in the queue or get reported. Needs email configured — EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM and PUBLIC_BASE_URL — and stays silent without it.",
	},
];

const ALL_FLAG_META = [...FLAG_META, ...MOD_FLAG_META];

// Operator-facing labels + help for each numeric display setting. Bounds are
// pulled from the settings registry so the input min/max can't drift from the
// server-side clamp.
const NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "comments_per_page",
		label: "Comments per page",
		help: "Top-level comments shown per initial load. \"Load older comments\" reveals the next batch.",
	},
	{
		key: "replies_per_thread",
		label: "Replies before “show more”",
		help: "Replies shown under each comment before a “Show N more replies” button. 0 = show all.",
	},
	{
		key: "auto_collapse_depth",
		label: "Auto-collapse depth",
		help: "Replies nested at this depth or deeper start collapsed. 0 = never auto-collapse.",
	},
];

// Moderation-tab steppers. auto_close_at is NOT here — it's an epoch instant
// rendered with a date picker (raw epoch ms is unusable in a stepper); see the
// auto-close card below.
const MOD_NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "edit_window_minutes",
		label: "Edit window (minutes)",
		help: "How long after posting an author may still revise their own comment. 0 = no editing at all.",
	},
	{
		key: "auto_close_days",
		label: "Auto-close after (days)",
		help: "Close a thread to new comments this many days after the article's publish date (or, if the host page doesn't send one, the first comment's date). 0 = never auto-close by age. Existing comments stay visible.",
	},
	{
		key: "community_min_votes",
		label: "Auto-collapse: minimum votes",
		help: "A comment needs at least this many total votes before the downvote ratio can collapse it. Guards new comments from being folded by a single downvote. Ignored when the ratio below is 0.",
	},
	{
		key: "community_collapse_ratio",
		label: "Auto-collapse: downvote %",
		help: "Fold a comment (readers can still expand it) once this percent of its votes are downvotes and it has met the minimum above. 0 = never auto-collapse. Needs downvotes enabled.",
	},
];

// Privacy retention. Lives on the Moderation tab because that's what the stored
// hashes are *for* — the dial trades moderation depth (spotting a ban evader on
// the same network, deduping reports) for a smaller blast radius if the database
// or the hashing secret ever leaks.
//
// The only setting here whose effect can't be undone by setting it back, so the
// help text has to say so: the cron nulls the columns, and nothing rebuilds
// them. The 7-day floor is not expressible in the stepper's min (that has to
// stay 0 so "off" remains reachable), so the sweep enforces it by refusing —
// see MIN_RETENTION_DAYS in src/db/ip-retention.ts.
const PRIVACY_NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "ip_hash_retention_days",
		label: "Clear stored IP hashes after (days)",
		help: "Erase the hashed IP and user-agent on comments and reports once they're this old. 0 = keep them for the life of the row (the default). Values from 1 to 6 are ignored — the sweep refuses anything under 7 days so a typo can't wipe nearly everything. Irreversible: a cleared hash is gone, and with it the ability to spot a ban evader on that network. Anonymous ghost accounts are never swept — their hash is the identity itself.",
	},
	{
		key: "audit_log_retention_days",
		label: "Delete audit-log rows after (days)",
		help: "Prune the moderation audit trail once entries are this old. 0 = keep it forever (the default). Values from 1 to 29 are ignored — the sweep refuses anything under 30 days, a higher floor than the IP one because a moderation record stays useful for months. Irreversible, and whole rows go rather than being redacted: an audit entry with the actor stripped out reads as evidence while proving nothing. Set this if \"we keep moderation records indefinitely\" is a retention period you'd rather not have to justify.",
	},
];

// The outbound confirmation-email ceiling (src/lib/email-budget.ts). Its own
// card rather than folded into anti-spam heuristics above, because it is the one
// dial on this page whose *default* an operator may need to raise: the heuristics
// fail toward the moderation queue, whereas an exhausted send budget 429s a real
// reader trying to subscribe. Labels say "global" out loud for that reason —
// nothing here is per-reader, so one abusive burst does spend everyone's window.
//
// Windows aren't shown because they aren't settable; see the comment on
// CONFIRM_BURST_WINDOW_SEC for why they stay constants.
const EMAIL_NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "confirm_send_burst_max",
		label: "Confirmation emails per minute (global)",
		help: "Total subscription-confirmation emails this instance will send in any 60-second window, across all readers. Raise it if a post gets busy enough that genuine subscribers see \"too many requests\" — the log line to look for in `wrangler tail` is `confirmation email budget exhausted`. Cannot be set to 0: a 0 ceiling silently breaks all new subscriptions rather than disabling the check.",
	},
	{
		key: "confirm_send_daily_max",
		label: "Confirmation emails per day (global)",
		help: "Same counter over a 24-hour window. The default 200 sits deliberately above Resend's free-tier 100/day, so your mail provider's limit is what a normal instance meets first. Lower it below 100 (minus your expected digest volume) if you'd rather Garrul stop sending before your provider starts rejecting.",
	},
];

// Anti-spam dials. The classifier provider and its credentials stay
// deploy-time (see the Configuration tab) — these are the ones worth
// retuning while watching the queue fill up.
const SPAM_NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "spam_link_threshold",
		label: "Link threshold",
		help: "Queue a comment carrying more than this many links. -1 = check off; 0 = queue anything with a link at all. Cost: none — it counts links in memory.",
	},
	{
		key: "spam_honeypot_min_ms",
		label: "Minimum fill time (ms)",
		help: "Queue a comment submitted faster than this after the form loaded — bots post instantly, people don't. 0 = check off. Cost: one extra Worker request per reader who starts writing, to fetch the signed form token.",
	},
	{
		key: "spam_ai_threshold",
		label: "AI spam threshold (%)",
		help: "Only used when SPAM_PROVIDER is workers-ai or decisions. Queue a comment when the classifier rates it at least this likely to be spam. Lower catches more spam and queues more real comments. Each comment's detail page shows the classifier score (0–1), so you can tune this against real traffic. Cost: one model call per comment; the model sets the price. The threshold does not change the cost.",
	},
];

// Locale options for the Display tab.
//
// Each entry shows the endonym first (a German operator scanning the list looks
// for "Deutsch", not "German"), and machine-seeded translations say so right in
// the option label. That disclosure lives *here*, at the point where the choice
// is made, and deliberately nowhere in the widget: the reader didn't pick the
// locale and can't fix it, so a banner there would only make the site look
// unfinished to its own audience.
const localeOptions = (): { value: string; label: string }[] => [
	{
		value: AUTO_LOCALE,
		label: "Follow the page (<html lang>), else English",
	},
	...Object.entries(LOCALES).map(([tag, meta]) => {
		const name =
			meta.endonym === meta.label
				? `${meta.label} (${tag})`
				: `${meta.endonym} — ${meta.label} (${tag})`;
		return {
			value: tag,
			label:
				meta.status === "machine-seeded"
					? `${name} — machine-translated, not yet reviewed`
					: name,
		};
	}),
];

export const renderSettings = (
	env: Bindings,
	flags: ResolvedFlags,
	numbers: ResolvedNumbers,
	strings: ResolvedStrings,
	texts: ResolvedTexts,
): string => {
	const rows: [string, string][] = [
		["ENV", env.ENV ?? "(unset)"],
		["ALLOWED_ORIGINS", env.ALLOWED_ORIGINS ?? "(unset)"],
		["ADMIN_EMAILS", env.ADMIN_EMAILS ?? "(unset)"],
		["TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY ? "(set)" : "(unset)"],
		["GH_CLIENT_ID", env.GH_CLIENT_ID ? "(set)" : "(unset)"],
		["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID ? "(set)" : "(unset)"],
		["FACEBOOK_CLIENT_ID", env.FACEBOOK_CLIENT_ID ? "(set)" : "(unset)"],
		["TWITTER_CLIENT_ID", env.TWITTER_CLIENT_ID ? "(set)" : "(unset)"],
		["DISCORD_CLIENT_ID", env.DISCORD_CLIENT_ID ? "(set)" : "(unset)"],
		[
			"OAUTH_CALLBACK_BASE",
			env.OAUTH_CALLBACK_BASE ?? "(falls back to request origin)",
		],
		["EMAIL_PROVIDER", env.EMAIL_PROVIDER ?? "(unset)"],
		["SPAM_PROVIDER", env.SPAM_PROVIDER || "(unset)"],
		["AKISMET_API_KEY", env.AKISMET_API_KEY ? "(set)" : "(unset)"],
		["AKISMET_SITE_URL", env.AKISMET_SITE_URL ?? "(unset)"],
		["SPAM_DECISIONS_URL", env.SPAM_DECISIONS_URL || "(default: OpenRouter)"],
		["SPAM_DECISIONS_API_KEY", env.SPAM_DECISIONS_API_KEY ? "(set)" : "(unset)"],
		["SPAM_FORM_TS_SECRET", env.SPAM_FORM_TS_SECRET ? "(set)" : "(unset)"],
	];
	const body = rows
		.map(
			([k, v]) =>
				`<tr><td><code>${k}</code></td><td>${escapeHtml(v)}</td></tr>`,
		)
		.join("");

	// Feature-flag toggles. Each checkbox reflects the *resolved* effective
	// value (DB override > env > default). Saving writes an explicit DB row
	// per flag (overriding env); "Reset to defaults" clears the rows so the
	// env vars / built-in defaults apply again.
	const toggles = FLAG_META.map((f) =>
		renderSwitch({
			name: f.key,
			model: `flags.${f.key}`,
			label: f.label,
			help: f.help,
		}),
	).join("");

	// Numeric display settings. Each stepper reflects the resolved effective
	// value; min/max mirror the server-side clamp (numberBounds).
	const stepper = (f: { key: NumberKey; label: string; help: string }) => {
		const b = numberBounds(f.key);
		return renderStepper({
			name: f.key,
			model: `nums.${f.key}`,
			min: b.min,
			max: b.max,
			label: f.label,
			help: f.help,
		});
	};
	const numberInputs = NUMBER_META.map(stepper).join("");
	const modNumberInputs = MOD_NUMBER_META.map(stepper).join("");
	const spamNumberInputs = SPAM_NUMBER_META.map(stepper).join("");
	const privacyNumberInputs = PRIVACY_NUMBER_META.map(stepper).join("");
	const emailNumberInputs = EMAIL_NUMBER_META.map(stepper).join("");
	const modToggles = MOD_FLAG_META.map((f) =>
		renderSwitch({
			name: f.key,
			model: `flags.${f.key}`,
			label: f.label,
			help: f.help,
		}),
	).join("");

	// The honeypot timing check silently does nothing without the HMAC key that
	// signs the form timestamp — an unsigned timestamp is trivially forged, so
	// evaluateSpam skips the check entirely. Say so rather than letting an
	// operator turn on a dial that can't fire.
	//
	// Seeded into Alpine rather than baked into the server render: save() does
	// not reload, so a server-only warning would stay hidden through the exact
	// transition that creates the problem (operator raises the dial off 0, gets
	// a "saved" toast, and never learns the check is inert). The secret itself
	// is deploy-time, so its presence can't change while the page is open.
	const hasFormTsSecret = Boolean(env.SPAM_FORM_TS_SECRET);

	const localeSelect = renderSelect({
		name: "default_locale",
		model: "strs.default_locale",
		options: localeOptions(),
		label: "Language",
		help: "Language for the widget, the Atom feed and notification emails. Comment text is never translated. An embed can override this per-page with data-lang. \"Follow the page\" reads the host page's <html lang> — reviewed translations only, so a machine-translated language has to be chosen here or on the embed.",
	});

	// The muted-words list. Caps come from the matcher's own exports rather than
	// being retyped here, so tightening one can't leave the help text promising
	// the old number.
	// "Top" needs voting to mean anything, but it is still *offered* with voting
	// off — dropping the option would make an already-saved `top` unrepresentable
	// in the control, and the next save would silently rewrite it to `new`. That
	// is the one outcome the server's coercion exists to prevent, so the option
	// stays and says it is inactive instead (the same "say so rather than hide
	// it" treatment as the spam dial above).
	const sortSelect = renderSelect({
		name: "default_sort",
		model: "strs.default_sort",
		options: [
			{ value: "new", label: "Newest first" },
			{ value: "old", label: "Oldest first — chronological" },
			{
				value: "top",
				label: flags.votes_enabled
					? "Top — highest score first"
					: "Top — highest score first (inactive: voting is off)",
			},
		],
		label: "Default order",
		help: "Order top-level comments load in. Readers can still switch order themselves; this is only where they start. \"Top\" needs voting enabled — with voting off it serves newest first instead, and your choice here is kept for if you turn voting back on.",
	});

	// Which Clef model the classifier calls. Lives with the threshold on the
	// Anti-spam tab because the two are tuned together: a bigger model is worth
	// trying when the threshold alone can't separate spam from real comments.
	const aiModelSelect = renderSelect({
		name: "spam_ai_model",
		model: "strs.spam_ai_model",
		options: [
			{ value: "clef-flash", label: "Clef-flash — 9B, cheapest (default)" },
			{ value: "clef", label: "Clef — 27B, about 6× the cost per comment" },
		],
		label: "AI classifier model",
		help: "Only used when SPAM_PROVIDER is workers-ai. Clef-flash costs roughly 1–3 neurons per comment, so the 10,000 free neurons a day cover a few thousand comments. Clef costs roughly 6–20, which covers about 500–1,500. Past the free allowance on the Free plan, checks fail and comments post without an AI check. Clef is also slower; a check that runs past 5 seconds counts as no opinion. Usage shows the measured average per call.",
	});

	// The BYOK model is free-form, so it is a text setting, not a select. It
	// sits with the Clef choice because both answer "which model decides".
	const decisionsModelTextarea = renderTextarea({
		name: "spam_decisions_model",
		model: "texts.spam_decisions_model",
		label: "Decision model (bring your own key)",
		help: `Only used when SPAM_PROVIDER is <code>decisions</code>. The model id
		as your endpoint names it — on OpenRouter, <code>vendor/model</code>.
		Change it here to compare models on real traffic: each comment's detail
		page records the model that was asked. Empty skips the check. <strong>Reset to defaults</strong>
		(clears every override) returns it to <code>SPAM_DECISIONS_MODEL</code>.`,
		rows: 1,
		maxlength: SPAM_DECISIONS_MODEL_MAX,
		placeholder: "~typesafe/jev-latest",
	});

	const blocklistTextarea = renderTextarea({
		name: "spam_blocklist",
		model: "texts.spam_blocklist",
		label: "Muted words",
		help: `One term per line. A bare term matches whole words only, so
		<code>ass</code> does not flag "class"; wrap it in <code>*</code> to match
		anywhere (<code>*casino*</code>) or trail one for a prefix
		(<code>t.me/*</code>). Case-insensitive, and lookalike forms
		(<code>ｖｉａｇｒａ</code>) and zero-width characters are folded away —
		but accents are kept and leetspeak is not decoded. This is not a regex:
		<code>.</code> and <code>(</code> are literal. Lines starting with
		<code>#</code> are comments. Checked against the comment body, author name
		and page URL. A hit sends the comment to the queue; nothing is ever
		silently dropped. Up to ${MAX_TERMS} terms, ${MAX_TERM_CHARS} characters
		and ${MAX_WILDCARDS} wildcards each — a term over those limits is skipped,
		the rest of the list still applies. Cost: none — the list is matched in
		memory and adds no database or KV traffic.`,
		rows: 10,
		maxlength: MAX_TEXT_SETTING_CHARS,
		placeholder: "viagra\n*casino*\nt.me/*",
	});

	const reservedNamesTextarea = renderTextarea({
		name: "reserved_names",
		model: "texts.reserved_names",
		label: "Reserved names",
		help: `One name per line. An anonymous commenter can't post under any of
		them. Matching ignores case, spaces, <code>.</code> <code>_</code>
		<code>-</code> and lookalike forms, so <code>Site Admin</code> also
		catches <code>site_admin</code> and <code>ＳＩＴＥＡＤＭＩＮ</code>. Whole names
		only: <code>admin</code> does not refuse "admin fan". Lines starting with
		<code>#</code> are comments. Names that signed-in users already post
		under are refused automatically; list only names you want held back on
		top of those — your own, or your site's.`,
		rows: 4,
		maxlength: MAX_TEXT_SETTING_CHARS,
		placeholder: "Site Admin\nModerator",
	});

	const securityContactTextarea = renderTextarea({
		name: "security_contact",
		model: "texts.security_contact",
		label: "Disclosure contact",
		help: `An email address, or an <code>https://</code> or
		<code>mailto:</code> URI. Anything else is treated as unset. Empty (the
		default) keeps the route a 404 — the file is only served once there is a
		real contact behind it.`,
		rows: 2,
		maxlength: MAX_TEXT_SETTING_CHARS,
		placeholder: "security@example.com",
	});

	const staffLabelTextarea = renderTextarea({
		name: "staff_badge_label",
		model: "texts.staff_badge_label",
		label: "Staff badge label",
		help: `Shown next to a moderator's name on comments they chose to post as
		staff. Empty (the default) uses the reader's language — "Staff" in
		English. Up to ${STAFF_BADGE_LABEL_MAX} characters.`,
		rows: 1,
		maxlength: STAFF_BADGE_LABEL_MAX,
		placeholder: "Staff",
	});

	const commentKindChips = renderKindChips(
		"comment_reaction_kinds",
		"Comment reaction emoji",
		"Which emoji readers can leave on a comment, left to right. Signed-in readers see every enabled emoji on every comment, so more than about six gets crowded. Turning one off hides it; reactions already left are kept and reappear if you turn it back on. At least one stays on — use the switch above to turn reactions off.",
	);
	const pageKindChips = renderKindChips(
		"page_reaction_kinds",
		"Page reaction emoji",
		"Which emoji the article bar offers, left to right. Each shows with its label, so a long list wraps onto more lines. Only used while Page reactions is on.",
	);

	const initial = JSON.stringify(
		Object.fromEntries(ALL_FLAG_META.map((f) => [f.key, flags[f.key]])),
	);
	// Seed the whole resolved numbers object so keys surfaced as non-stepper
	// controls (auto_close_at, via the date picker) round-trip on save too.
	const numInitial = JSON.stringify(numbers);
	const strInitial = JSON.stringify(strings);
	// The other three seeds get away with bare JSON.stringify because their
	// values cannot be arbitrary: booleans, clamped numbers, and strings the
	// handler whitelists. A text setting is whatever the operator typed, so it
	// goes through jsLiteralRaw like every other free-form value embedded in an
	// x-data blob — JSON.stringify leaves U+2028/U+2029 raw, and those are line
	// terminators that end the string literal inside the Alpine expression.
	const textInitial = `{${TEXT_KEYS.map(
		// Reaction lists seed from the lenient read, not the raw row: one junk
		// stored kind would otherwise fail every unrelated save with a 400.
		(k) =>
			`${jsLiteralRaw(k)}:${jsLiteralRaw(isReactionKindsKey(k) ? reactionKinds(texts, k).join(",") : texts[k])}`,
	).join(",")}}`;

	return `
<div x-data="{
  tab: 'features',
  busy: false,
  flags: ${escapeHtml(initial)},
  nums: ${escapeHtml(numInitial)},
  strs: ${escapeHtml(strInitial)},
  texts: ${escapeHtml(textInitial)},
  vocab: ${escapeHtml(VOCAB_SEED)},
  // The enabled kinds for one surface, parsed from its comma-joined text
  // value. hasOwnProperty, not 'in': a hand-edited row naming 'constructor'
  // must not reach vocab[kind].emoji.
  kindsOf(key) {
    return this.texts[key].split(',').map((k) => k.trim())
      .filter((k, i, a) => Object.prototype.hasOwnProperty.call(this.vocab, k) && a.indexOf(k) === i);
  },
  kindOn(key, kind) { return this.kindsOf(key).includes(kind); },
  // Enabled kinds in their saved order, then the rest in vocabulary order.
  chipOrder(key) {
    const on = this.kindsOf(key);
    return [...on, ...Object.keys(this.vocab).filter((k) => !on.includes(k))];
  },
  toggleKind(key, kind) {
    const l = this.kindsOf(key);
    const i = l.indexOf(kind);
    if (i === -1) l.push(kind);
    else if (l.length > 1) l.splice(i, 1);
    this.texts[key] = l.join(',');
  },
  moveKind(key, kind, d) {
    const l = this.kindsOf(key);
    const i = l.indexOf(kind);
    const j = i + d;
    if (i === -1 || j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    this.texts[key] = l.join(',');
  },
  hasFormTsSecret: ${hasFormTsSecret},
  // Deliberately just a line count, not a re-implementation of the matcher's
  // parse rules: a second copy of the grammar in Alpine would drift from the
  // server's, and the number an operator actually wants is 'did my paste land'.
  // Single quotes, not double: this whole blob is one double-quoted HTML
  // attribute, so a double quote typed anywhere in it — comments included —
  // ends the attribute early and dumps the rest onto the page as text.
  get blocklistTermCount() {
    return this.texts.spam_blocklist
      .split('\\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).length;
  },
  // Friendly proxy over the epoch-ms auto_close_at: the date picker reads/writes
  // a YYYY-MM-DD string; the canonical value stays the number in nums. Empty
  // string clears it to 0 (disabled). End-of-day UTC so the chosen date is fully
  // included before the sunset trips.
  get autoCloseDate() {
    return this.nums.auto_close_at
      ? new Date(this.nums.auto_close_at).toISOString().slice(0, 10)
      : '';
  },
  set autoCloseDate(v) {
    this.nums.auto_close_at = v ? Date.parse(v + 'T23:59:59Z') : 0;
  },
  async save() {
    this.busy = true;
    try {
      const r = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flags: this.flags, numbers: this.nums, strings: this.strs, texts: this.texts }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Save failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Settings saved' });
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Save failed', kind: 'bad' });
    } finally {
      this.busy = false;
    }
  },
  async reset() {
    if (!confirm('Clear all runtime overrides and fall back to env vars / defaults?')) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Reset failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Reset to defaults' });
      setTimeout(() => location.reload(), 300);
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Reset failed', kind: 'bad' });
      this.busy = false;
    }
  },
}">
  ${renderTabs("tab", TABS)}

  <form @submit.prevent="save()">
    <div class="card" x-show="tab === 'features'">
      <h2>Features</h2>
      <p class="muted">Toggle features without a redeploy. A toggle here overrides
      the matching env var (<code>VOTING_ENABLED</code>, <code>REACTIONS_ENABLED</code>,
      …); "Reset to defaults" clears the overrides so the env vars / built-in
      defaults apply again.</p>
      ${toggles}
      <h3>Reaction emoji</h3>
      ${commentKindChips}${pageKindChips}
    </div>

    <div class="card" x-show="tab === 'display'" x-cloak>
      <h2>Display &amp; pagination</h2>
      <p class="muted">Control how many comments load at once and how nested
      replies collapse. Smaller values keep a busy thread from pushing the rest
      of the page down.</p>
      ${numberInputs}
      ${sortSelect}
      ${localeSelect}
    </div>

    <div class="card" x-show="tab === 'moderation'" x-cloak>
      <h2>Moderation</h2>
      <p class="muted">The edit window, thread auto-close and community
      auto-collapse. Auto-close and auto-collapse are off by default. Closing a
      thread only blocks <em>new</em> comments — existing ones stay visible and
      votes/reactions stay live. Auto-collapse just folds heavily-downvoted
      comments; readers can still expand them.</p>
      ${modNumberInputs}
      <div class="field-row">
        <span class="field-control">
          <input type="date" x-model="autoCloseDate">
          <button type="button" class="secondary" @click="autoCloseDate = ''"
                  x-show="nums.auto_close_at">Clear</button>
        </span>
        <span class="field-text">
          <strong>Close all threads on</strong>
          <span class="muted">Instance-wide sunset: once this date passes, no
          thread accepts new comments. Leave empty to disable. Takes effect
          within a few minutes of the date passing.</span>
        </span>
      </div>
      <!-- Canonical epoch-ms value for auto_close_at; the date picker above is a
           proxy over it. Kept as the named number input so it saves like every
           other numeric setting. -->
      <input type="hidden" name="auto_close_at" x-model.number="nums.auto_close_at"
             min="${numberBounds("auto_close_at").min}"
             max="${numberBounds("auto_close_at").max}">
      ${staffLabelTextarea}
    </div>

    <div class="card" x-show="tab === 'moderation'" x-cloak>
      <h2>Anti-spam heuristics</h2>
      <p class="muted">Cheap local checks that run before the optional
      classifier. A tripped check never drops a comment — it routes it to the
      queue, so tune these while watching what lands there. The classifier
      provider and its API keys stay in <code>wrangler.toml</code>; see the
      Configuration tab.</p>
      <p class="muted">Each hint below names what the check costs per comment.
      On top of that, any check that runs writes one verdict row to D1 (about
      three rows written with its indexes, against 100,000 a day on the free
      tier). The classifier is skipped when a check has already queued the
      comment. <a href="/admin/usage">Usage</a> shows today's totals.</p>
      ${modToggles}
      ${spamNumberInputs}
      ${aiModelSelect}
      ${decisionsModelTextarea}
      <p class="muted" x-show="nums.spam_honeypot_min_ms > 0 && !hasFormTsSecret" x-cloak>
      <strong>Fill-time check is inactive.</strong> It needs
      <code>SPAM_FORM_TS_SECRET</code> to sign the form timestamp — without it an
      unsigned time is trivially forged, so the check is skipped. Set the secret
      with <code>wrangler secret put SPAM_FORM_TS_SECRET</code> and redeploy.</p>
      ${blocklistTextarea}
      <p class="muted" x-show="blocklistTermCount > 0" x-cloak>
      <span x-text="blocklistTermCount"></span> term(s).
      <span x-show="blocklistTermCount > ${MAX_TERMS}"><strong>Only the first
      ${MAX_TERMS} are checked</strong> — the rest are ignored.</span></p>
      <p class="muted">Clearing the box saves an <em>empty</em> list, which is not
      the same as never having set one: it overrides whatever
      <code>SPAM_BLOCKLIST</code> your deploy ships. "Reset to defaults" is the
      way back to that.</p>
      ${reservedNamesTextarea}
    </div>

    <div class="card" x-show="tab === 'moderation'" x-cloak>
      <h2>Confirmation-email ceiling</h2>
      <p class="muted">A hard cap on how much subscription-confirmation mail this
      instance will send, counted globally rather than per reader. It exists
      because the other two limits on that endpoint can both be walked past by an
      attacker cycling email addresses, so this is the one that holds — at the
      cost of being shared: a spent window turns away genuine new subscribers
      until it rolls. Already-confirmed subscribers and their digests are never
      affected. Denials are logged, so watch <code>wrangler tail</code> before
      assuming these need raising.</p>
      ${emailNumberInputs}
    </div>

    <div class="card" x-show="tab === 'moderation'" x-cloak>
      <h2>Privacy retention</h2>
      <p class="muted">Garrul stores a keyed hash of the commenter's IP (never
      the address itself) so you can spot a ban evader on the same network and
      dedupe abuse reports. Retention puts an expiry on that: past the window,
      the cron erases the hash and user-agent from comments and reports, so a
      database export carries a bounded slice of history instead of everything
      the instance has ever seen. Off by default.</p>
      ${privacyNumberInputs}
      <p class="muted"><strong>This one can't be undone.</strong> Setting the
      window back to 0 stops future sweeps; it does not restore what a sweep
      already erased. Watch it run, and drain a backlog on demand, from
      <a href="/admin/operator">Operator</a>.</p>
    </div>

    <div class="card" x-show="tab === 'moderation'" x-cloak>
      <h2>Vulnerability disclosure</h2>
      <p class="muted">Where a security researcher should report a
      vulnerability in this instance. When set, it is published at
      <a href="/.well-known/security.txt" target="_blank" rel="noopener"><code>/.well-known/security.txt</code></a>
      (RFC 9116), the standard place researchers look. Unset, that route
      answers 404.</p>
      ${securityContactTextarea}
    </div>

    <p class="settings-actions" x-show="tab !== 'config'">
      <button type="submit" class="btn-primary" :disabled="busy">Save settings</button>
      <button type="button" class="secondary" @click="reset()" :disabled="busy">Reset to defaults</button>
    </p>
  </form>

  <div class="card" x-show="tab === 'config'" x-cloak>
    <h2>Configuration</h2>
    <p class="muted">These remain environment variables. Change them with
    <code>wrangler secret put NAME</code> (or edit <code>wrangler.toml</code>
    <code>[vars]</code> for non-secrets) and redeploy.</p>
    <table>
      <thead><tr><th>Variable</th><th>Value</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <h3>Bindings</h3>
    <ul>
      <li><code>DB</code> — D1 database (comments, users, reactions, posts)</li>
      <li><code>RATE_LIMITS</code>, <code>OAUTH_STATE</code>, <code>SESSIONS</code>, <code>TREE_CACHE</code> — KV namespaces</li>
      <li><code>ANALYTICS</code> — Workers Analytics Engine dataset (optional)</li>
    </ul>
  </div>
</div>`;
};
