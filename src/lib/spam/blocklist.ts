/**
 * Operator-maintained muted-words list.
 *
 * The grammar is deliberately not regex. Operators write literal terms, one per
 * line, with `*` as the only metacharacter. That restriction is the safety
 * property: this matcher runs on the unauthenticated comment-POST path, and a
 * grammar that cannot express nested quantifiers cannot express a catastrophic
 * backtracking pattern. Validating operator-supplied regex would instead mean
 * owning a ReDoS heuristic forever — and the obvious cheap mitigations don't
 * work, since `(a+)+$` is six characters and compiles cleanly, so neither a
 * length cap nor a compile-test catches it.
 *
 * Grammar:
 *
 *   viagra          matches the whole word only — not "viagraceous"
 *   *casino*        matches anywhere, including inside a longer word
 *   t.me/*          prefix match; the dot is literal, not "any character"
 *   # a comment     ignored, as are blank lines
 *
 * A hit routes the comment to `pending`, exactly like the link-count and
 * first-comment heuristics. Nothing here rejects a post outright.
 *
 * ## Why the wildcard path is hand-rolled
 *
 * The obvious implementation compiles each term to a RegExp with `[\s\S]*` for
 * `*`. It is also wrong, and measurably so: a restricted grammar stops the
 * operator writing a bad pattern, but it does not stop *us* generating one.
 * Greedy `.*` between literals backtracks polynomially, and on a 2000-character
 * body a three-wildcard term took 12 seconds — an unauthenticated request
 * turning into minutes of Worker CPU, which is the exact failure the grammar
 * restriction existed to prevent.
 *
 * So wildcards are matched by an `indexOf` walk instead (see `matchSegments`),
 * which never backtracks. Regex appears nowhere in the matching path.
 */

/**
 * Per-term limits, applied at parse time. Terms breaching any of them are
 * dropped rather than repaired, and the admin save path surfaces the same
 * limits as validation errors so an operator sees the rejection instead of
 * silently losing a rule.
 */
export const MAX_TERMS = 200;
export const MAX_TERM_CHARS = 100;
export const MAX_WILDCARDS = 4;

/**
 * Ceiling on the text any single term is matched against.
 *
 * `matchSegments` is worst-case quadratic — an unanchored term like `*a*z`
 * against a body of repeated "a" makes every position a candidate start and
 * fails the end boundary at each one. It cannot go exponential, and reaching
 * the quadratic case needs a degenerate term the operator wrote themselves,
 * but the bound should not be left to the caller. Comment bodies are already
 * capped at MAX_BODY_CHARS (10k) by the renderer; this covers the other fields
 * and any future caller.
 *
 * Measured ceiling at this cap: ~2ms for one such term, ~130ms for a list of
 * 200 copies of it. That is the price of a maximally hostile blocklist the
 * operator authored against their own instance, so it is a bound worth knowing
 * rather than a bound worth engineering away.
 */
const MAX_MATCH_CHARS = 10_000;

/**
 * Zero-width and formatting characters stripped before matching.
 *
 * These are the cheapest possible evasion: a U+200B inserted mid-word renders
 * identically to the bare word in every browser and defeats a naive substring
 * match. Stripping them costs nothing and closes the whole class.
 *
 * Written as escapes on purpose — the literal characters are invisible in an
 * editor and a stray one in this class would be undebuggable.
 *
 *   U+00AD          soft hyphen
 *   U+200B–U+200F   zero-width space/joiners, LTR/RTL marks
 *   U+2060–U+2064   word joiner and invisible operators
 *   U+FEFF          zero-width no-break space (BOM)
 */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/**
 * True when a character counts as "inside a word" for boundary matching.
 *
 * Deliberately Unicode-aware rather than JS's `\b`, whose word class is
 * `[A-Za-z0-9_]`. With `\b`, a Cyrillic or Greek term would have a boundary
 * asserted at every letter, so an anchored term would match inside any
 * non-Latin word — the exact false positive the boundary rule exists to
 * prevent. Tested one character at a time, so there is no quantifier and
 * nothing to backtrack.
 */
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/**
 * Fold a string into the form terms are matched against.
 *
 * NFKC collapses compatibility forms, so fullwidth `ｖｉａｇｒａ` and the various
 * mathematical-alphanumeric lookalikes normalize onto plain ASCII. Lowercasing
 * makes matching case-insensitive. Invisibles are stripped last, after
 * normalization has had its chance to reposition them.
 *
 * Leetspeak (`v1agra`) is deliberately *not* folded. Mapping 1→i, 0→o and the
 * rest would catch a handful more spam at the cost of false positives an
 * operator cannot predict from the term they typed, and the same evasion beats
 * a hand-written regex too — so it is not an argument for a richer grammar.
 */
export const normalizeForMatch = (s: string): string =>
	s.normalize("NFKC").toLowerCase().replace(INVISIBLE_RE, "");

/**
 * A compiled term, stored in the shape the matcher consumes.
 *
 * The literal runs are split into first/middle/last at compile time rather than
 * indexed out of one array at match time. That is partly types — "never empty"
 * and "the last run may not exist" are invariants worth stating once instead of
 * re-proving at every use — and partly the hot path: `placeRest` runs once per
 * candidate start, so anything hoisted out of it is hoisted out of a loop that
 * can run thousands of times per comment.
 */
export interface BlocklistTerm {
	/** The term as the operator wrote it, for the audit/debug trail. */
	readonly source: string;
	/** First normalized literal run. Always present — see `compileTerm`. */
	readonly first: string;
	/** Literal runs between the first and the last, in order. Usually empty. */
	readonly middle: readonly string[];
	/** Final literal run, or null when the term is a single run. */
	readonly last: string | null;
	/** A leading `*` — the match need not begin on a word boundary. */
	readonly openStart: boolean;
	/** A trailing `*` — the match need not end on a word boundary. */
	readonly openEnd: boolean;
}

/**
 * Compile one operator-written term.
 *
 * Returns null when the term is empty, a comment, or breaches a per-term limit.
 */
const compileTerm = (raw: string): BlocklistTerm | null => {
	const source = raw.trim();
	if (source === "" || source.startsWith("#")) return null;
	if (source.length > MAX_TERM_CHARS) return null;

	const normalized = normalizeForMatch(source);
	if (normalized === "") return null;

	const parts = normalized.split("*");
	if (parts.length - 1 > MAX_WILDCARDS) return null;

	// A leading/trailing `*` means "don't anchor this end". Anchoring is the
	// default because an unanchored literal is the Scunthorpe problem: a term
	// like `ass` would otherwise flag "class" and "assessment".
	const openStart = parts[0] === "";
	const openEnd = parts[parts.length - 1] === "";

	const [first, ...rest] = parts.filter((p) => p !== "");
	// All wildcard and no literal ("*", "**") would match every comment.
	if (first === undefined) return null;

	return {
		source,
		first,
		middle: rest.slice(0, -1),
		last: rest.length > 0 ? (rest[rest.length - 1] ?? null) : null,
		openStart,
		openEnd,
	};
};

/**
 * Parse a raw blocklist setting into compiled terms.
 *
 * Invalid terms are skipped, not fatal: the setting can arrive from an env var
 * where there is nobody to report an error to, and one bad line must not
 * disable the other 199 rules.
 */
export const parseBlocklist = (raw: string): BlocklistTerm[] => {
	if (!raw) return [];
	const out: BlocklistTerm[] = [];
	for (const line of raw.split("\n")) {
		if (out.length >= MAX_TERMS) break;
		const term = compileTerm(line);
		if (term) out.push(term);
	}
	return out;
};

// `charAt` rather than `[]` on purpose: out of range it returns "", which the
// word-character class does not match, so the ends of the string read as
// boundaries without a separate range check.
const boundaryBefore = (hay: string, i: number): boolean =>
	!WORD_CHAR_RE.test(hay.charAt(i - 1));

const boundaryAfter = (hay: string, i: number): boolean =>
	!WORD_CHAR_RE.test(hay.charAt(i));

/**
 * Place the remaining literal runs after a confirmed match of `first` at
 * `start`.
 *
 * Middle runs take their earliest occurrence, which is optimal: an earlier
 * placement can only leave more room for what follows. The final run is the
 * exception when the term is end-anchored, because its earliest occurrence may
 * land mid-word — so it advances through later occurrences until one ends on a
 * boundary.
 */
const placeRest = (hay: string, term: BlocklistTerm, start: number): boolean => {
	const { first, middle, last, openEnd } = term;
	let cursor = start + first.length;
	if (last === null) return openEnd || boundaryAfter(hay, cursor);

	for (const seg of middle) {
		const at = hay.indexOf(seg, cursor);
		if (at < 0) return false;
		cursor = at + seg.length;
	}

	if (openEnd) return hay.indexOf(last, cursor) >= 0;
	for (let from = cursor; ; ) {
		const at = hay.indexOf(last, from);
		if (at < 0) return false;
		if (boundaryAfter(hay, at + last.length)) return true;
		from = at + 1;
	}
};

/**
 * Non-backtracking segment match. See the module header for why this is not a
 * generated RegExp.
 */
const matchSegments = (hay: string, term: BlocklistTerm): boolean => {
	const { first, middle, last, openStart } = term;

	// Fast reject: the runs must at least appear in order somewhere, with
	// boundaries ignored. One linear pass, and it eliminates for free the case
	// that would otherwise make the candidate loop below quadratic — a term
	// whose tail never occurs at all (`a*z` against a body of "a").
	let probe = hay.indexOf(first);
	if (probe < 0) return false;
	probe += first.length;
	for (const seg of middle) {
		const at = hay.indexOf(seg, probe);
		if (at < 0) return false;
		probe = at + seg.length;
	}
	if (last !== null && hay.indexOf(last, probe) < 0) return false;

	for (let searchFrom = 0; ; ) {
		const start = hay.indexOf(first, searchFrom);
		if (start < 0) return false;
		if ((openStart || boundaryBefore(hay, start)) && placeRest(hay, term, start)) {
			return true;
		}
		searchFrom = start + 1;
	}
};

/**
 * Single-entry memo of the last parsed list.
 *
 * The blocklist is instance-wide and changes at operator speed, so every
 * comment POST on a given isolate compiles the identical set. Module state is
 * safe here for the same reason it is for the in-flight settings derivation:
 * nothing request-scoped is stored, only a pure function of the raw setting,
 * and the key is the raw string itself — so a stale entry is unreachable rather
 * than merely unlikely.
 */
let memoKey: string | null = null;
let memoValue: BlocklistTerm[] = [];

export const compileBlocklist = (raw: string): BlocklistTerm[] => {
	if (raw === memoKey) return memoValue;
	memoValue = parseBlocklist(raw);
	memoKey = raw;
	return memoValue;
};

export interface BlocklistInput {
	body_md: string;
	author_name: string;
	/** The host page's URL, matched so a spam campaign's target can be muted. */
	post_url?: string | null;
}

export interface BlocklistHit {
	/** The operator's term, for the heuristics debug blob. */
	term: string;
	/** Which field matched — body, name or url. */
	field: "body" | "name" | "url";
}

/**
 * First matching term across the checked fields, or null.
 *
 * Returns on the first hit rather than collecting every match: the outcome is
 * binary (`pending`), so further matching is wasted work on the hot path, and
 * recording every term a comment tripped would put more of the operator's
 * blocklist into the stored verdict than the decision needs.
 */
export const checkBlocklist = (
	terms: readonly BlocklistTerm[],
	input: BlocklistInput,
): BlocklistHit | null => {
	if (terms.length === 0) return null;
	const fields: { field: BlocklistHit["field"]; value: string }[] = [
		{ field: "body", value: input.body_md },
		{ field: "name", value: input.author_name },
		{ field: "url", value: input.post_url ?? "" },
	];
	for (const { field, value } of fields) {
		if (!value) continue;
		const haystack = normalizeForMatch(value).slice(0, MAX_MATCH_CHARS);
		for (const term of terms) {
			if (matchSegments(haystack, term)) return { term: term.source, field };
		}
	}
	return null;
};
