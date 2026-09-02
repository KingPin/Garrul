import { de } from "./de";
import { en, type StringKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";

export type { StringKey };

/** Plural-capable message value. See `tFor` for the selection rules. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | PluralForms;

export type Vars = Record<string, string | number>;
export type Translator = (key: StringKey, vars?: Vars) => string;

export type LocaleStatus = "source" | "reviewed" | "machine-seeded";

export interface LocaleMeta {
	/** English name — admin UI, docs. */
	readonly label: string;
	/** Native name — shown to operators choosing a locale. */
	readonly endonym: string;
	/**
	 * Right-to-left script. No RTL locale ships yet; the field exists so that
	 * adding one is a CSS pass rather than a schema change. The widget's
	 * layout already uses logical properties, so `dir` is the only switch.
	 */
	readonly rtl: boolean;
	/**
	 * Gates *automatic* selection.
	 *
	 * `source` and `reviewed` locales may be picked up from the host page's
	 * `<html lang>`. `machine-seeded` ones are LLM output that no native
	 * speaker has checked, so they require an explicit `data-lang=` opt-in —
	 * which means the only person who ever sees one is an operator who typed
	 * the tag, and therefore reads the language. That is what keeps shipping
	 * unreviewed translations honest.
	 */
	readonly status: LocaleStatus;
	/**
	 * GitHub handle of whoever vouches for this translation.
	 *
	 * Absent on machine-seeded locales, because nobody does yet — that is the
	 * honest state, and filling it in is what promotes a locale to `reviewed`.
	 * Unowned locale files are how comparable projects ended up with thirty of
	 * them, half untouched since 2019.
	 */
	readonly maintainer?: string;
}

/**
 * Where negotiation lands when nothing else matched, and what a handler binds
 * its translator to when there is no per-request one.
 *
 * Named `FALLBACK_LOCALE`, not `DEFAULT_LOCALE`, because that name is already
 * taken by the *env var* an operator sets to choose the site's language — and
 * that one defaults to `auto`, not to English. Two constants a line apart in an
 * import list, both plausibly "the default locale", meaning opposite things: one
 * is the end of the chain, the other is a step near the front of it.
 */
export const FALLBACK_LOCALE = "en";

/**
 * Every locale Garrul knows about.
 *
 * Everything but English is machine-seeded: LLM output that no native speaker
 * has checked. They ship because the alternative — holding translations until a
 * volunteer appears — is how a project ends up with none, and because the
 * `machine-seeded` status confines them to operators who explicitly asked for
 * the language. What fails in machine translation of ~90 short UI strings is
 * register and consistency, not comprehensibility: exactly what a native
 * operator spots in thirty seconds and fixes in a five-line PR.
 *
 * Keep this list sorted by tag after English, and keep `TABLES` and
 * `WIDGET_TABLES` in the same order — the parity test checks that a registered
 * locale has both, but nothing enforces the reading order for a human.
 */
export const LOCALES: Record<string, LocaleMeta> = {
	en: { label: "English", endonym: "English", rtl: false, status: "source" },
	de: { label: "German", endonym: "Deutsch", rtl: false, status: "machine-seeded" },
	es: { label: "Spanish", endonym: "Español", rtl: false, status: "machine-seeded" },
	fr: { label: "French", endonym: "Français", rtl: false, status: "machine-seeded" },
	it: { label: "Italian", endonym: "Italiano", rtl: false, status: "machine-seeded" },
};

export type LocaleTable = Partial<Record<StringKey, Message>>;

/**
 * Server-side string tables. English is the source; others may be partial.
 *
 * Exported so `tests/i18n-parity.test.ts` can check every registered locale
 * without a hand-maintained list of them — a list that would go stale the first
 * time someone adds a locale and forgets it, which is precisely the failure the
 * parity test exists to catch.
 */
export const TABLES: Record<string, LocaleTable> = { en, de, es, fr, it };

/**
 * Whitelist check. Everything that reaches `tFor` from a request goes here.
 *
 * `Object.hasOwn` rather than a truthiness test: a bare `LOCALES[v]` check
 * would accept inherited keys like `toString` and hand them to
 * `Intl.PluralRules`, which throws on a malformed tag.
 */
export const isLocale = (v: string | null | undefined): v is string =>
	typeof v === "string" && Object.hasOwn(LOCALES, v);

/** Eligible for automatic selection from the host page's `<html lang>`. */
export const isAutoSelectable = (locale: string): boolean => {
	const meta = LOCALES[locale];
	return meta !== undefined && meta.status !== "machine-seeded";
};

/**
 * Memoized Intl.PluralRules.
 *
 * This is module-level state, but unlike the `active` locale it replaces it is
 * a pure cache of immutable objects keyed by locale — nothing request-scoped
 * is stored, so there is nothing to leak between concurrent requests.
 */
const pluralRules = new Map<string, Intl.PluralRules>();
const rulesFor = (locale: string): Intl.PluralRules => {
	let rules = pluralRules.get(locale);
	if (!rules) {
		rules = new Intl.PluralRules(locale);
		pluralRules.set(locale, rules);
	}
	return rules;
};

/**
 * Category fallbacks, applied after the locale's own selected category.
 *
 * `one` is in the chain because several languages (Russian, Polish, Ukrainian)
 * never select `other` for an integer — a table filled in only as
 * `{one, other}` would otherwise resolve to nothing for most counts. None of
 * those locales ship yet; the chain costs one array entry and removes a
 * silent-breakage class that nobody could see in review.
 */
const FALLBACK_FORMS: Intl.LDMLPluralRule[] = ["other", "one"];

/**
 * Resolve a message to a raw template string.
 *
 * Plural values select on the `count` var — that name is the contract, and
 * `pluralsMissingSelector` in tests/i18n-parity.test.ts enforces that literal
 * call sites for a plural key pass it. Without `count` this doesn't throw and
 * doesn't render braces: it takes the first fallback form, so a caller who
 * forgot gets the plural wording for every value.
 */
const selectForm = (
	msg: Message | undefined,
	locale: string,
	vars?: Vars,
): string | undefined => {
	if (msg === undefined) return undefined;
	if (typeof msg === "string") return msg;
	const n = Number(vars?.count);
	const forms = Number.isFinite(n)
		? [rulesFor(locale).select(n), ...FALLBACK_FORMS]
		: FALLBACK_FORMS;
	for (const form of forms) {
		const value = msg[form];
		if (typeof value === "string") return value;
	}
	return undefined;
};

/**
 * Substitute `{name}` placeholders.
 *
 * The replacement *function* form is deliberate: it stops `$&`, `` $` `` and
 * friends in a var value (author names, post titles — all user-supplied) from
 * being interpreted as replacement patterns. Do not simplify this to a string
 * replacement. Values still get HTML-escaped at the render site; this layer is
 * not an escaping boundary.
 */
const interpolate = (raw: string, vars?: Vars): string => {
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
		name in vars ? String(vars[name]) : `{${name}}`,
	);
};

/**
 * Build a translator bound to one locale.
 *
 * Lookup order: the locale's table, then English, then the key itself. That
 * per-key fallback is what lets a partial translation ship — a locale file
 * missing a key renders English there and stays correct everywhere else,
 * instead of blocking every future string addition on three translators.
 *
 * Locale is a parameter rather than module state on purpose. A single Worker
 * isolate serves concurrent requests, so a mutable module-level "active
 * locale" leaks across requests at every `await`.
 */
export const tFor = (locale: string): Translator => {
	const loc = isLocale(locale) ? locale : FALLBACK_LOCALE;
	const table = TABLES[loc] ?? en;
	return (key, vars) => {
		const raw =
			selectForm(table[key], loc, vars) ?? selectForm(en[key], FALLBACK_LOCALE, vars) ?? key;
		return interpolate(raw, vars);
	};
};

/**
 * English translator.
 *
 * Kept as a bound export so the operator-facing surfaces that are English by
 * design — the Telegram bot and the admin routes — can import it directly.
 * Request-scoped code should use `c.get("t")` instead (see src/lib/locale.ts).
 */
export const t: Translator = tFor(FALLBACK_LOCALE);
