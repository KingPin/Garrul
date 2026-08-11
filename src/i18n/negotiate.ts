/**
 * Locale negotiation.
 *
 * The governing rule: **locale is a property of the site, not the reader.** A
 * German speaker reading an English blog should get an English widget — a
 * German comment box under English prose reads as broken, not helpful. So
 * `Accept-Language` and `navigator.language` are deliberately never consulted.
 * That is a design decision, not an omission; it also means no response here
 * ever needs to `Vary` on a header or carry a locale in a cache key.
 *
 * Precedence, most specific first:
 *
 *   1. `?lang=` — explicit. Comes from `data-lang` on the mount element, or
 *      from the iframe route's own query param. Per-embed, so it wins.
 *   2. The operator's `default_locale` setting, when they have actually set
 *      one. The built-in value is the sentinel `"auto"`, which is not a locale
 *      and therefore falls through — that is what distinguishes "never
 *      configured" from "deliberately set to English".
 *   3. `?hl=` — the host page's `<html lang>`, forwarded by the widget as a
 *      *hint*. Only `source`/`reviewed` locales may be selected this way;
 *      machine-seeded translations require the explicit opt-in at (1).
 *   4. English.
 *
 * (2) beats (3) because explicit configuration should beat inference:
 * `<html lang>` is frequently untouched theme boilerplate, while an operator
 * who opened the settings page and picked a language meant it.
 */
import { DEFAULT_LOCALE, LOCALES, isAutoSelectable } from "./index";

/**
 * Sentinel for "operator has not chosen" — deliberately not a valid tag, so it
 * simply fails to match and negotiation continues to the next source.
 */
export const AUTO_LOCALE = "auto";

/** Case-insensitive tag → canonical registry key. */
const CANONICAL = new Map<string, string>(
	Object.keys(LOCALES).map((tag) => [tag.toLowerCase(), tag]),
);

/** BCP-47's practical ceiling; anything longer is junk, not a language tag. */
const MAX_TAG_LENGTH = 35;

/**
 * Match a raw tag against the registry: exact first, then the primary subtag,
 * so `de-DE` and `de-AT` both land on `de`.
 *
 * Returns undefined rather than a default so callers can tell "no match" from
 * "matched English" — negotiation needs that distinction to fall through.
 */
export const matchLocale = (raw: string | null | undefined): string | undefined => {
	if (typeof raw !== "string") return undefined;
	const tag = raw.trim().toLowerCase();
	if (!tag || tag.length > MAX_TAG_LENGTH) return undefined;
	const exact = CANONICAL.get(tag);
	if (exact) return exact;
	const primary = tag.split("-")[0];
	return primary ? CANONICAL.get(primary) : undefined;
};

export interface LocaleSources {
	/** `?lang=` — explicit per-embed choice. */
	readonly requested?: string | null | undefined;
	/** The operator's `default_locale` setting (may be the `auto` sentinel). */
	readonly operatorDefault?: string | null | undefined;
	/** `?hl=` — host page `<html lang>`. Hint only; auto-selectable locales. */
	readonly hostPage?: string | null | undefined;
}

export const resolveLocale = (sources: LocaleSources): string => {
	const explicit = matchLocale(sources.requested);
	if (explicit) return explicit;

	const operator = matchLocale(sources.operatorDefault);
	if (operator) return operator;

	const hint = matchLocale(sources.hostPage);
	if (hint && isAutoSelectable(hint)) return hint;

	return DEFAULT_LOCALE;
};
