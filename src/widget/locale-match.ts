/**
 * BCP-47 tag → one of a given set of locale keys. Pure, no imports, so both
 * the server (src/i18n/negotiate.ts, against the live registry) and the static
 * iframe shell (src/widget/frame.ts, against a list baked in at build time)
 * run the same rules.
 */

/** Case-insensitive tag → canonical key, scanned: the list is a handful long. */
const canonical = (keys: readonly string[], tag: string): string | undefined => {
	for (const key of keys) {
		if (key.toLowerCase() === tag) return key;
	}
	return undefined;
};

/** BCP-47's practical ceiling; anything longer is junk, not a language tag. */
const MAX_TAG_LENGTH = 35;

/**
 * Macrolanguage → the shipped table that serves it. `no` and `nb` are sibling
 * primary subtags, so the primary-subtag hop below can't bridge them the way it
 * bridges `pt-BR` → `pt`; without this a host page tagged `<html lang="no">`
 * gets English. Only the primary subtag is aliased, so `no-NO` lands here too.
 * If Nynorsk ever ships as `nn`, `no` stays on Bokmål — that is what the
 * macrolanguage tag means in practice on the web.
 */
const MACROLANGUAGE_ALIASES: Record<string, string> = { no: "nb" };

/** Chinese regions that use Traditional Chinese when no script is specified. */
const TRADITIONAL_CHINESE_REGIONS = new Set(["tw", "hk", "mo"]);

/**
 * Resolve Chinese script and region subtags without reading BCP 47 extensions.
 * An explicit script wins over the region: `zh-Hans-TW` must not become
 * Traditional Chinese just because its region is Taiwan.
 */
const traditionalChineseLocale = (
	keys: readonly string[],
	subtags: string[],
): string | undefined => {
	if (subtags[0] !== "zh") return undefined;

	// Extension sequences begin with a singleton (`u`, `x`, etc.). Their values
	// are opaque and must not be mistaken for script or region subtags.
	const extensionStart = subtags.findIndex(
		(subtag, index) => index > 0 && /^[a-z0-9]$/.test(subtag),
	);
	const languageSubtags = extensionStart < 0 ? subtags : subtags.slice(0, extensionStart);

	const second = languageSubtags[1];
	const hasScript = second !== undefined && /^[a-z]{4}$/.test(second);
	if (hasScript) {
		if (second !== "hant") return undefined;
		return canonical(keys, "zh-hant");
	}

	return TRADITIONAL_CHINESE_REGIONS.has(second ?? "") ? canonical(keys, "zh-hant") : undefined;
};

/** Exact match first, then Traditional Chinese, then the primary subtag. */
export const matchLocaleIn = (
	keys: readonly string[],
	raw: string | null | undefined,
): string | undefined => {
	if (typeof raw !== "string") return undefined;
	const tag = raw.trim().toLowerCase();
	if (!tag || tag.length > MAX_TAG_LENGTH) return undefined;
	const exact = canonical(keys, tag);
	if (exact) return exact;
	const traditionalChinese = traditionalChineseLocale(keys, tag.split("-"));
	if (traditionalChinese) return traditionalChinese;
	const primary = tag.split("-")[0];
	return primary ? canonical(keys, MACROLANGUAGE_ALIASES[primary] ?? primary) : undefined;
};
