/**
 * The gate a translation PR lands against.
 *
 * A monolingual maintainer cannot review a translation for meaning, so the only
 * honest review policy is trust-on-green plus a cheap correction path. That puts
 * the whole burden on what a machine *can* check, which is this file. Every
 * assertion here is chosen for one property: it catches damage that is invisible
 * to someone who doesn't read the language.
 *
 * The policy split matters as much as the checks:
 *
 *   - **Extra keys hard-fail.** A key that isn't in English is a typo or a dead
 *     entry; either way nothing will ever render it.
 *   - **Missing keys do not fail — they report.** Per-key fallback to English is
 *     the mechanism that lets a partial translation ship at all. Hard-failing
 *     here would mean one new English string in an unrelated PR breaks every
 *     locale and forces the maintainer to invent translations.
 *   - **Placeholder mismatches hard-fail.** `{naem}` renders literally in
 *     production and looks like a Garrul bug, not a translation bug.
 *
 * Written before the first translation exists, deliberately: translation #1
 * should land against a live gate rather than have one retro-fitted around it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en as SERVER_EN } from "../src/i18n/en";
import { LOCALES, TABLES as SERVER_TABLES } from "../src/i18n";
import { WIDGET_TABLES } from "../src/i18n/widget";
import { EN as WIDGET_EN } from "../src/widget/strings";

type Value = string | Partial<Record<Intl.LDMLPluralRule, string>>;
type Table = Record<string, Value | undefined>;

const SRC = join(__dirname, "..", "src");

/**
 * The two translatable surfaces, checked by the same rules.
 *
 * `plural` names the variable each surface selects a plural category on. They
 * differ (`count` server-side, `n` in the widget) because the widget's table is
 * a separate module that predates none of this — the contract is per-surface,
 * and the check is what keeps each one honest.
 */
const SURFACES = [
	{ name: "server", english: SERVER_EN as Table, tables: SERVER_TABLES as Record<string, Table> },
	{ name: "widget", english: WIDGET_EN as Table, tables: WIDGET_TABLES as Record<string, Table> },
] as const;

/** Every locale carrying a table on a surface, English excluded — it is the source. */
const translationsOf = (tables: Record<string, Table>): [string, Table][] =>
	Object.entries(tables).filter(([locale]) => locale !== "en");

const placeholdersIn = (value: Value): Set<string> => {
	const templates = typeof value === "string" ? [value] : Object.values(value);
	const found = new Set<string>();
	for (const template of templates) {
		for (const [, name] of (template ?? "").matchAll(/\{(\w+)\}/g)) {
			if (name) found.add(name);
		}
	}
	return found;
};

/**
 * Plural categories a comment count can actually reach in this locale.
 *
 * Not `resolvedOptions().pluralCategories`, which is the full CLDR set: French
 * lists `many` for values in the millions, and demanding a French translator
 * fill in a form for a million replies is how a gate teaches people to work
 * around it. Sampling the integers a thread realistically renders keeps the
 * requirement to the forms that would otherwise render as nothing.
 */
const reachableCategories = (locale: string): Set<Intl.LDMLPluralRule> => {
	const rules = new Intl.PluralRules(locale);
	const reachable = new Set<Intl.LDMLPluralRule>();
	for (let n = 0; n <= 1000; n++) reachable.add(rules.select(n));
	return reachable;
};

/**
 * The three hard-fail rules, as functions rather than inline assertions.
 *
 * No locale ships yet, so running them only over the real tables would assert
 * nothing at all — thirteen green checks over an empty set, arriving in a commit
 * whose entire purpose is to be a gate. Pulling them out lets the suite prove
 * each one rejects a broken fixture, so the gate is known to work before the
 * first translation is written against it.
 */
const extraKeys = (table: Table, englishKeys: Set<string>): string[] =>
	Object.keys(table).filter((key) => !englishKeys.has(key));

const unknownPlaceholders = (table: Table, english: Table): string[] =>
	Object.entries(table).flatMap(([key, value]) => {
		const source = english[key];
		if (value === undefined || source === undefined) return []; // extra-keys check owns this
		const allowed = placeholdersIn(source);
		return [...placeholdersIn(value)]
			.filter((name) => !allowed.has(name))
			.map((name) => `${key}:{${name}}`);
	});

const pluralGaps = (table: Table, english: Table, locale: string): string[] => {
	const required = reachableCategories(locale);
	return Object.entries(table).flatMap(([key, value]) => {
		if (typeof english[key] !== "object") return [];
		if (typeof value !== "object" || value === undefined) return [`${key}: not a plural object`];
		return [...required].filter((form) => value[form] === undefined).map((f) => `${key}:${f}`);
	});
};

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".bundled.ts")
			? [path]
			: [];
	});

/**
 * The locale tables — definitions of keys, never uses of them.
 *
 * Excluding them is the whole reason the dead-key check below can report
 * anything. Every key appears as `"key":` in the table that declares it, so a
 * corpus containing the tables matches each key against its own definition and
 * finds all 128 of them "used" no matter what src/ does. Derived from `LOCALES`
 * so a newly registered locale file drops out of the corpus on arrival rather
 * than quietly re-breaking the check.
 */
const isTableFile = (path: string): boolean => {
	const rel = relative(SRC, path);
	return (
		rel === join("widget", "strings.ts") ||
		Object.keys(LOCALES).some(
			(locale) =>
				rel === join("i18n", `${locale}.ts`) || rel === join("i18n", "widget", `${locale}.ts`),
		)
	);
};

/** Everything in `src/` that could actually render a key. */
const CALL_SITES = sourceFiles(SRC)
	.filter((path) => !isTableFile(path))
	.map((path) => readFileSync(path, "utf8"))
	.join("\n");

/**
 * Keys nothing in the corpus mentions.
 *
 * A substring match on the quoted key rather than a `("key")` call pattern,
 * because a good number of real call sites never put the key next to the paren:
 * `s(shown ? "w.lowscore.hide" : "w.lowscore.show")`, and the validator results
 * shaped `{ key: "err.body.too_long" }` that reach `t()` as `t(check.key)`.
 * Requiring the tighter shape would report those as dead and teach the next
 * person to delete a live string. With the definitions gone from the corpus,
 * any remaining match is a use.
 */
const unusedKeys = (keys: Iterable<string>, corpus: string): string[] =>
	[...keys].filter((key) => !corpus.includes(`"${key}"`));

describe("i18n parity", () => {
	for (const { name, english, tables } of SURFACES) {
		describe(`${name} strings`, () => {
			const englishKeys = new Set(Object.keys(english));
			const translations = translationsOf(tables);

			it("registers every translated locale in LOCALES", () => {
				// A table nothing can select is dead weight, and an unregistered
				// locale silently never renders — negotiation whitelists LOCALES.
				for (const [locale] of translations) {
					expect(Object.hasOwn(LOCALES, locale), `${locale} is missing from LOCALES`).toBe(
						true,
					);
				}
			});

			it("has no key that English doesn't have", () => {
				for (const [locale, table] of translations) {
					expect(extraKeys(table, englishKeys), `${locale} has keys English does not`).toEqual(
						[],
					);
				}
			});

			it("keeps every placeholder a subset of the English value's", () => {
				// The check that catches what the maintainer cannot see. A renamed
				// or invented placeholder renders as literal braces to readers.
				for (const [locale, table] of translations) {
					expect(
						unknownPlaceholders(table, english),
						`${locale} uses placeholders English does not`,
					).toEqual([]);
				}
			});

			it("fills every plural form a count can actually select", () => {
				for (const [locale, table] of translations) {
					expect(pluralGaps(table, english, locale), `${locale} has plural gaps`).toEqual([]);
				}
			});

			it("reports coverage without failing on incomplete translations", () => {
				// Report-only on purpose: partial translations are the normal state
				// between PRs and degrade to English per key.
				for (const [locale, table] of translations) {
					const filled = Object.keys(table).filter((key) => englishKeys.has(key)).length;
					if (filled < englishKeys.size) {
						console.info(
							`[i18n] ${name}/${locale}: ${filled}/${englishKeys.size} keys — the rest render English`,
						);
					}
				}
				expect(true).toBe(true);
			});

			it("has no key nothing in src/ renders", () => {
				// The bug this whole effort started from: 14 `ui.*` keys written
				// "for the widget" that the widget never imported, sitting next to
				// its hardcoded twins. Dead keys cost every translator real time.
				expect(unusedKeys(englishKeys, CALL_SITES), "keys defined but never rendered").toEqual(
					[],
				);
			});
		});
	}

	it("gives every registered locale both a widget and a server table", () => {
		// Half-registration is the plausible mistake: a locale file exists and is
		// listed in LOCALES, but one of the two registries never imported it, so
		// the operator picks a language and half the product stays English.
		for (const locale of Object.keys(LOCALES)) {
			if (locale === "en") continue; // English is the source, not an override
			expect(WIDGET_TABLES[locale], `${locale} has no widget table`).toBeDefined();
			expect(SERVER_TABLES[locale], `${locale} has no server table`).toBeDefined();
		}
	});

	describe("the gate itself", () => {
		// Every check above currently runs over zero translations. These fixtures
		// are what makes this commit a gate rather than a promise of one.
		const english: Table = {
			greet: "Hi {name}",
			replies: { one: "{n} reply", other: "{n} replies" },
		};

		it("rejects a key English doesn't have", () => {
			expect(extraKeys({ greet: "Hallo {name}", greeting: "Hallo" }, new Set(["greet"]))).toEqual(
				["greeting"],
			);
		});

		it("rejects a renamed placeholder", () => {
			// The typo that renders "Hallo {naem}" to every German reader.
			expect(unknownPlaceholders({ greet: "Hallo {naem}" }, english)).toEqual(["greet:{naem}"]);
		});

		it("accepts a translation that drops a placeholder it doesn't need", () => {
			// Subset, not equality: a language that can phrase the sentence without
			// the variable is translating well, not breaking the contract.
			expect(unknownPlaceholders({ greet: "Hallo" }, english)).toEqual([]);
		});

		it("rejects a plural key filled in as a bare string", () => {
			expect(pluralGaps({ replies: "{n} Antworten" }, english, "de")).toEqual([
				"replies: not a plural object",
			]);
		});

		it("rejects a plural object missing a reachable form", () => {
			expect(pluralGaps({ replies: { other: "{n} Antworten" } }, english, "de")).toEqual([
				"replies:one",
			]);
		});

		it("does not demand a form no comment count can reach", () => {
			// French's `many` starts in the millions. Demanding it is how a gate
			// teaches translators to route around it.
			expect(
				pluralGaps({ replies: { one: "{n} réponse", other: "{n} réponses" } }, english, "fr"),
			).toEqual([]);
		});

		it("demands the forms a Slavic locale actually selects", () => {
			// Russian never selects `other` for an integer, so an {one, other}
			// table renders nothing for most counts — the silent breakage the
			// fallback chain in makeS() exists to survive and this check exists
			// to prevent shipping in the first place.
			expect(
				pluralGaps({ replies: { one: "{n} ответ", other: "{n} ответов" } }, english, "ru"),
			).toContain("replies:few");
		});

		it("reports a key no call site names, and only that key", () => {
			// The shape of the bug this check had on its first pass: it searched a
			// corpus that included the tables, so every key matched its own
			// `"key":` definition and nothing was reportable. Against a corpus of
			// call sites only, a dead key has nowhere left to hide.
			const corpus = 'const label = t("greet");\nconst other = s(n === 1 ? "replies" : "greet");';
			expect(unusedKeys(["greet", "replies", "farewell"], corpus)).toEqual(["farewell"]);
		});

		it("holds every locale table out of the call-site corpus", () => {
			// Guards the exclusion itself. If one table file ever rejoins the
			// corpus the check above passes forever without reading src/ again,
			// which is indistinguishable from working.
			const excluded = sourceFiles(SRC).filter(isTableFile).map((path) => relative(SRC, path));
			expect(excluded).toContain(join("i18n", "en.ts"));
			expect(excluded).toContain(join("widget", "strings.ts"));
			for (const locale of Object.keys(LOCALES)) {
				if (locale === "en") continue;
				expect(excluded, `${locale}'s server table is still in the corpus`).toContain(
					join("i18n", `${locale}.ts`),
				);
			}
		});
	});

	it("keeps the widget's English table inside its byte budget", () => {
		// Every non-English mount pays for this table on the wire, and the bundle
		// carries it for everyone. A future PR dumping prose into widget copy
		// should fail loudly here rather than quietly tax every reader.
		const bytes = JSON.stringify(WIDGET_EN).length;
		expect(bytes, `widget EN table is ${bytes} bytes`).toBeLessThanOrEqual(6144);
	});
});
