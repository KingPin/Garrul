/**
 * Every English word the widget can render, in one keyed table.
 *
 * It lives on the *widget* side of the build on purpose. `tsconfig.widget.json`
 * compiles only `src/widget/**` with `"types": []`, so the widget cannot import
 * `src/i18n/` — but the server already imports from `src/widget/`, so the
 * dependency inverts cleanly: this file is the English source of truth, and
 * `/api/v1/config` merges a locale table over it for non-English readers.
 *
 * Keys are pure overhead in the bundle — the values were already in there — so
 * they are terse. The values are not: a translator only ever sees the value, so
 * every one of them has to be a complete, reorderable sentence or label.
 *
 * Two rules that keep this table translatable:
 *
 *   1. **No fragments.** A value is never concatenated with another value or
 *      with a variable. Anything variable is a `{placeholder}` *inside* the
 *      string, so a translator can move it — German and French routinely need
 *      it somewhere English doesn't put it.
 *   2. **No inline plural hacks.** A string whose wording depends on a count is
 *      an object of CLDR categories, resolved through `Intl.PluralRules`. Two
 *      keys need this; the other sixty are plain strings.
 */

/** CLDR plural categories, exactly as `Intl.PluralRules.select()` returns them. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;

/** A table entry: a plain string, or one string per plural category. */
export type StringValue = string | PluralForms;

export type StringTable = Readonly<Record<string, StringValue>>;

/** Interpolation values. Numbers are stringified; `n` also selects the plural. */
export type Vars = Readonly<Record<string, string | number>>;

export const EN = {
	// ── Composer ────────────────────────────────────────────────────────────
	// The toolbar *glyphs* (B, I, 🔗, </>, ❝, •) are deliberately not in here:
	// they read as icons rather than words, the way a word processor's B and I
	// do. Only their tooltips are translated.
	"w.toolbar": "Formatting",
	"w.md.bold": "Bold",
	"w.md.italic": "Italic",
	"w.md.link": "Link",
	"w.md.code": "Inline code",
	"w.md.quote": "Quote",
	"w.md.list": "Bulleted list",
	// Inserted into the author's own markdown when they hit a toolbar button
	// with nothing selected, so they end up reading it in the composer.
	"w.md.ph.bold": "bold",
	"w.md.ph.italic": "italic",
	"w.md.ph.link": "text",
	"w.md.ph.code": "code",
	"w.tab.write": "Write",
	"w.tab.preview": "Preview",
	"w.md_hint": "Styling with Markdown is supported",
	// Both modifiers named, because the widget cannot tell which one this
	// reader has: navigator.platform is deprecated and userAgentData is
	// Chromium-only. The CSS hides this line entirely on a coarse pointer.
	"w.kbd_hint": "⌘/Ctrl + Enter to post",
	"w.preview.empty": "Nothing to preview yet.",
	"w.preview.loading": "Loading preview…",
	"w.preview.failed": "Preview failed. Try again.",
	"w.name_ph": "Your name",
	"w.body_ph": "Add a comment…",
	"w.email_ph": "you@example.com",
	// A subscription is UNIQUE (post_slug, email) — it follows the thread, not
	// your own comment, so every new comment on the post is delivered. The old
	// wording ("on new replies") promised per-reply scoping the schema does not
	// have; say what actually arrives rather than under-deliver on the label.
	"w.notify": "Email me about new comments",
	"w.post_comment": "Post comment",
	"w.post_reply": "Post reply",
	"w.reply_ph": "Reply to @{name}…",
	"w.edit_ph": "Edit your comment…",
	"w.loading": "Loading…",
	"w.save": "Save",
	"w.cancel": "Cancel",

	// ── Anti-spam ───────────────────────────────────────────────────────────
	"w.ts.title": "Anti-spam check",
	"w.ts.checking": "Checking…",
	"w.ts.interactive": "Complete the anti-spam check above, then post again.",
	"w.ts.timeout":
		"The anti-spam check didn't load. Check your connection or reload the page.",
	"w.ts.retrying":
		"The anti-spam check hit a snag and is retrying. Post again in a moment.",
	"w.ts.failed":
		"Anti-spam check failed to load. Reload the page; if it keeps failing the site owner should check that https://challenges.cloudflare.com is reachable.",

	// ── A comment ───────────────────────────────────────────────────────────
	"w.verified": "verified",
	"w.edited": "· edited",
	"w.pending": "Pending approval",
	"w.removed_by_mod": "[removed by a moderator]",
	"w.deleted": "[deleted]",
	"w.lowscore.hide": "Hide comment",
	"w.lowscore.show": "Comment hidden (low score) — show",
	"w.reply": "Reply",
	"w.edit": "Edit",
	"w.delete": "Delete",
	"w.delete_confirm": "Delete this comment?",
	"w.report": "Report",
	"w.reported": "Reported, thanks",

	// ── Votes and reactions ─────────────────────────────────────────────────
	"w.vote.up": "Upvote",
	"w.vote.down": "Downvote",
	"w.page.helpful": "Was this helpful?",
	"w.page.up": "Upvote this page",
	"w.page.down": "Downvote this page",

	// ── The thread ──────────────────────────────────────────────────────────
	"w.replies": { one: "{n} reply", other: "{n} replies" },
	"w.more_replies": { one: "Show {n} more reply", other: "Show {n} more replies" },
	"w.loading_comments": "Loading comments",
	"w.empty.open": "Be the first to comment.",
	"w.empty.closed": "No comments yet.",
	"w.closed.post": "Comments are closed on this post.",
	"w.closed.aged": "This thread has been closed to new comments.",
	"w.closed.sunset": "Commenting has ended.",
	"w.closed.other": "Comments are closed.",
	"w.sort_by": "Sort by {control}",
	"w.sort.new": "Newest",
	"w.sort.top": "Top",
	"w.load_more": "Load older comments",
	"w.load_more_failed": "Could not load more: {detail}",

	// ── Identity ────────────────────────────────────────────────────────────
	// The provider names themselves (GitHub, Google, X…) are proper nouns and
	// stay out of the table — see PROVIDER_LABELS in embed.ts.
	"w.posting_as": "Posting as {name}",
	"w.sign_out": "Sign out",
	"w.signin_prompt": "Sign in to get a verified badge:",

	// ── Load failures ───────────────────────────────────────────────────────
	"w.err.transient":
		"Comments are temporarily unavailable. Please check back in a few minutes.",
	"w.err.generic": "Could not load comments.",

	// ── Attribution ─────────────────────────────────────────────────────────
	// "Garrul" is the product name and is never translated; it renders inside
	// the {link} slot.
	"w.powered_by": "Powered by {link}",
} satisfies StringTable;

export type WidgetKey = keyof typeof EN;

/** Resolve a translated string, or the key itself if nothing matches. */
export type Translate = (key: WidgetKey, vars?: Vars) => string;

/**
 * Split a translated string around one placeholder, so a slot can render as its
 * own element — a styled name, a link, a `<select>` — without chopping the
 * sentence into fragments a translator can't reorder. Every other placeholder
 * is interpolated as usual.
 */
export type TranslateAround = (
	key: WidgetKey,
	slot: string,
	vars?: Vars,
) => [string, string];

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Substitute `{name}` from `vars`. The replacement-*function* form is load-
 * bearing: values are user-supplied (author names, post titles, error detail)
 * and the string form of `String.replace` treats `$&`, `` $` `` and `$1` in a
 * replacement as instructions. An unknown placeholder is left verbatim rather
 * than blanked, so a typo in a translation is visible instead of silent.
 */
const interpolate = (template: string, vars: Vars | undefined): string => {
	if (!vars) return template;
	return template.replace(PLACEHOLDER, (whole, name: string) => {
		const v = vars[name];
		return v === undefined ? whole : String(v);
	});
};

/**
 * Pick the wording for `n` out of a category map.
 *
 * The fallback chain is selected → `other` → `one` → English, and every hop
 * earns its place. `de`/`es`/`fr` never need the last two, but Russian and
 * Polish never return `other` for an integer at all, so a table that only
 * filled `other` would render nothing for them — a breakage invisible to
 * anyone who doesn't read the language.
 */
const selectPlural = (
	forms: PluralForms,
	key: WidgetKey,
	n: number,
	rules: Intl.PluralRules,
): string => {
	const chosen = forms[rules.select(n)] ?? forms.other ?? forms.one;
	if (chosen !== undefined) return chosen;
	const english = EN[key];
	if (typeof english === "string") return english;
	return english.other ?? english.one ?? key;
};

/**
 * Build the widget's translator over a string table.
 *
 * Per-key fallback to English is the point: a translation that is missing keys
 * (the normal state of a community translation between PRs) degrades to English
 * exactly where it is incomplete, rather than rendering a raw key or blocking
 * the locale from shipping at all.
 *
 * `Intl.PluralRules` is constructed once per table, not per call — it is the
 * single most expensive thing here and the widget re-renders the whole tree on
 * every reload.
 */
export const makeS = (
	table: StringTable = EN,
	locale = "en",
): { s: Translate; sAround: TranslateAround } => {
	// An unregistered or malformed tag would throw and take the widget's first
	// render with it. English plural rules are the honest fallback: the table
	// this happened to came from the server, which only sends known locales.
	let rules: Intl.PluralRules;
	try {
		rules = new Intl.PluralRules(locale);
	} catch {
		rules = new Intl.PluralRules("en");
	}

	const template = (key: WidgetKey, vars: Vars | undefined): string => {
		const value = table[key] ?? EN[key];
		if (value === undefined) return key;
		if (typeof value === "string") return value;
		const n = typeof vars?.n === "number" ? vars.n : 0;
		return selectPlural(value, key, n, rules);
	};

	return {
		s: (key, vars) => interpolate(template(key, vars), vars),
		sAround: (key, slot, vars) => {
			const raw = template(key, vars);
			const marker = `{${slot}}`;
			const at = raw.indexOf(marker);
			// A translation that dropped the slot still has to render the element,
			// so put the whole sentence before it rather than losing either.
			if (at < 0) return [interpolate(raw, vars), ""];
			return [
				interpolate(raw.slice(0, at), vars),
				interpolate(raw.slice(at + marker.length), vars),
			];
		},
	};
};
