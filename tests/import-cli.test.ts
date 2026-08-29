/**
 * scripts/import-cli.ts — the SQL assembly behind `npm run import-<source>`.
 *
 * This code had no tests while it was three inline copies, which is the
 * wrong way round: it is the only place in the project that builds SQL by
 * string substitution rather than by binding, over values parsed out of an
 * untrusted export. It does that because `wrangler d1 execute` takes only
 * `--command` and `--file` — there is no parameter-binding flag, so the SQL
 * text is the entire interface to D1 from a CLI.
 *
 * What is pinned here is therefore the boundary: a value either reaches D1
 * as exactly itself, or the run stops. Approximately-right SQL is the one
 * outcome that must not be reachable, because it is the one that writes
 * wrong rows and reports success.
 *
 * Not covered: `wranglerD1`, which shells out to a real wrangler, and
 * `parseImportArgs` / `requireSecret`, which call process.exit.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BindError, inline, parseRows, resolve } from "../scripts/import-cli";

describe("inline", () => {
	it("renders null and undefined as SQL NULL", () => {
		expect(inline(null, 1)).toBe("NULL");
		expect(inline(undefined, 1)).toBe("NULL");
	});

	it("renders a finite number bare", () => {
		expect(inline(0, 1)).toBe("0");
		expect(inline(-1.5, 1)).toBe("-1.5");
		expect(inline(1767225600000, 1)).toBe("1767225600000");
	});

	// String(NaN) is `NaN` and String(Infinity) is `Infinity` — bare
	// identifiers to SQLite, not values, so the statement either errors or
	// resolves to something else entirely.
	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses the non-finite number %p",
		(n) => {
			expect(() => inline(n, 3)).toThrow(BindError);
			expect(() => inline(n, 3)).toThrow(/bind 3: non-finite/);
		},
	);

	it("quotes a plain string", () => {
		expect(inline("hello", 1)).toBe("'hello'");
	});

	// The whole escape: SQLite doubles a quote and recognizes no backslash
	// escapes, so a backslash is data and `''` closes the hole completely.
	it("escapes a quote by doubling it", () => {
		expect(inline("it's", 1)).toBe("'it''s'");
		expect(inline("''", 1)).toBe("''''''");
	});

	it("leaves a backslash alone, because SQLite has no backslash escape", () => {
		expect(inline("a\\'b", 1)).toBe("'a\\''b'");
	});

	// The classic injection attempt, and the reason the doubling above has to
	// be exactly right: the quote closes, the payload becomes a second
	// statement. Doubled, it is one literal containing a semicolon — which
	// wrangler's quote-aware splitter will not break on either.
	it("neutralises a statement-terminating payload", () => {
		const out = inline("x'; DROP TABLE comments; --", 1);
		expect(out).toBe("'x''; DROP TABLE comments; --'");
		// One opening quote, one closing quote, everything between doubled.
		expect(out.startsWith("'")).toBe(true);
		expect(out.endsWith("'")).toBe(true);
		expect((out.slice(1, -1).match(/'/g) ?? []).length % 2).toBe(0);
	});

	// argv is NUL-terminated, so a NUL truncates the SQL on its way to
	// wrangler — silently, and at a position the value's author picks.
	// Truncation is worse than refusal: the prefix is still valid SQL.
	it("refuses a NUL byte rather than letting it truncate the statement", () => {
		expect(() => inline("a\u0000b", 7)).toThrow(BindError);
		expect(() => inline("a\u0000b", 7)).toThrow(/bind 7: NUL byte/);
	});

	// These used to reach String() and produce `true`, `[object Object]` and
	// worse — all of them syntactically fine, none of them the value.
	it.each([
		[true, "boolean"],
		[{ a: 1 }, "object"],
		[[1, 2], "object"],
		[() => {}, "function"],
		[1n, "bigint"],
	])("refuses %p rather than stringifying it", (v, kind) => {
		expect(() => inline(v, 2)).toThrow(BindError);
		expect(() => inline(v, 2)).toThrow(new RegExp(`unsupported type ${kind}`));
	});

	it("names the bind position in every error, and never the value", () => {
		const secret = "unmistakable-secret-value";
		let msg = "";
		try {
			inline({ body: secret }, 4);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain("bind 4");
		expect(msg).not.toContain(secret);
	});
});

describe("resolve", () => {
	it("substitutes placeholders left to right", () => {
		expect(resolve("SELECT ?, ?, ?", ["a", 1, null])).toBe(
			"SELECT 'a', 1, NULL",
		);
	});

	// `String.replace` does not rescan its own output. If it did, a `?` inside
	// a comment body would consume the next bind and every value after it
	// would land in the wrong column.
	it("does not let a ? inside a value consume the next bind", () => {
		expect(resolve("INSERT VALUES (?, ?)", ["really?", "next"])).toBe(
			"INSERT VALUES ('really?', 'next')",
		);
	});

	// Both directions are bugs, and the surplus-placeholder one used to be
	// invisible: it read `undefined`, became NULL, and wrote a row with a
	// hole in it instead of failing.
	it("refuses more placeholders than binds", () => {
		expect(() => resolve("SELECT ?, ?", ["only"])).toThrow(
			/2 placeholder\(s\), 1 bound value\(s\)/,
		);
	});

	it("refuses more binds than placeholders", () => {
		expect(() => resolve("SELECT ?", ["a", "b"])).toThrow(
			/1 placeholder\(s\), 2 bound value\(s\)/,
		);
	});

	// The mismatch message quotes the SQL, which is ours, but it is clamped
	// so an inlined value from an earlier resolve can't ride along at length.
	it("clamps the SQL it quotes in a mismatch message", () => {
		const sql = `SELECT ${"x".repeat(400)} ?`;
		let msg = "";
		try {
			resolve(sql, []);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg.length).toBeLessThan(260);
	});

	it("handles a statement with no placeholders and no binds", () => {
		expect(resolve("SELECT 1", [])).toBe("SELECT 1");
	});
});

describe("parseRows", () => {
	const banner = "🚣 1 command executed successfully.\n";

	it("unwraps the rows out of the envelope", () => {
		const out = `${banner}[\n  { "results": [{ "id": "x" }], "success": true }\n]`;
		expect(parseRows(out)).toEqual([{ id: "x" }]);
	});

	// The bug this function exists to prevent: returning the envelope *as*
	// the rows. An empty result set is one truthy object, so every existence
	// probe reports "already imported" and the run inserts nothing while
	// printing DONE with all-zero counters.
	it("reads an empty result set as no rows, not as one truthy row", () => {
		const out = `${banner}[\n  { "results": [], "success": true, "meta": { "duration": 0 } }\n]`;
		expect(parseRows(out)).toEqual([]);
	});

	it("skips the banner and anchors on the envelope", () => {
		const noisy = `some [bracketed] prose\n${banner}[{"results":[{"n":1}]}]`;
		expect(parseRows(noisy)).toEqual([{ n: 1 }]);
	});

	it("concatenates the rows of a multi-statement envelope", () => {
		const out = `${banner}[{"results":[{"a":1}]},{"results":[{"b":2}]}]`;
		expect(parseRows(out)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("treats an element with no results as contributing nothing", () => {
		const out = `${banner}[{"success":true},{"results":[{"a":1}]}]`;
		expect(parseRows(out)).toEqual([{ a: 1 }]);
	});

	// "No rows" means "go ahead and insert" to every caller, so guessing it
	// on a parse failure is how a silently-broken import looks. A loud
	// failure is recoverable; a no-op that claims success is not.
	it("throws rather than guessing [] when there is no envelope", () => {
		expect(() => parseRows("🚣 done, nothing else")).toThrow(
			/could not find a JSON result envelope/,
		);
	});

	it("throws when the envelope is not valid JSON", () => {
		expect(() => parseRows(`${banner}[{"results":`)).toThrow(
			/could not parse wrangler output as JSON/,
		);
	});

	it("throws when the envelope is not an array", () => {
		expect(() => parseRows(`${banner}[1,2]\n`)).not.toThrow();
		expect(() => parseRows(`${banner}\n[{"results":{"a":1}}]`)).toThrow(
			/non-array `results`/,
		);
	});
});

/**
 * `parseImportArgs` parses `--slug=` for every source, but each CLI has to
 * forward it into `runImport` itself. The isso CLI shipped without that line
 * while the other three had it, so `npm run import-isso -- --slug=x` parsed
 * the flag, reported no error, and ignored it — a silent no-op, the failure
 * mode this file exists to keep out of the import path.
 *
 * Read off the source text rather than by running the CLIs: each is a
 * top-level IIFE that reads a file, shells out to wrangler and calls
 * process.exit, so there is nothing importable to assert against. Coarse,
 * but it catches exactly the drift that happened.
 */
describe("every import CLI forwards --slug", () => {
	const SOURCES = ["disqus", "remark42", "comentario", "isso"];

	it.each(SOURCES)("import-%s forwards slug_override", (source) => {
		const src = readFileSync(join(__dirname, `../scripts/import-${source}.ts`), "utf8");
		expect(src).toContain("slug_override: args.slugOverride");
	});

	it("import-isso names --slug in its usage string", () => {
		const src = readFileSync(join(__dirname, "../scripts/import-isso.ts"), "utf8");
		const usage = /usage: npm run \$\{TAG\} -- (.*)`/.exec(src)?.[1] ?? "";
		expect(usage).toContain("[--slug=<slug>]");
	});
});
