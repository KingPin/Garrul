/**
 * Shared plumbing for the `npm run import-<source>` CLIs.
 *
 * Every importer CLI is the same program with a different adapter bolted
 * on: parse the same flags, drive D1 through `wrangler d1 execute`, read
 * IP_HASH_SECRET from the environment, print the plan. Only the file it
 * reads and the `run<Source>Import` it calls differ.
 *
 * This lived inline in each CLI until there were three of them. The
 * duplication was not merely untidy — the copies had already drifted in a
 * way that mattered: one printed the raw error object on failure (quoting
 * the input it choked on, which for an untrusted export means display
 * names and hashed IPs) while the other printed only the message. The
 * hardened version is the one below, and now there is one of it.
 *
 * The SQL-assembly half is the part worth reading carefully; see the
 * comment on `inline`.
 */
import { execFileSync } from "node:child_process";

import { ImportTooLargeError } from "../src/lib/import/core";

// The binding, not `database_name` — see the docblock in src/db/migrate.ts.
const DB_BINDING = "DB";

// --------------------------------- flags -----------------------------------

export type ImportCliArgs = {
	/** First non-flag argument: the export file to read. */
	path: string;
	isRemote: boolean;
	dryRun: boolean;
	includeDeleted: boolean;
	includeSpam: boolean;
	slugOverride: string | null;
	/** `--name=value` for anything a single source adds on top. */
	option: (name: string) => string | null;
};

/**
 * Parse the flag set every importer CLI shares.
 *
 * Exits 2 with `usage` when no path is given, which is the one argument
 * error worth stopping on — a missing adapter-specific flag is the
 * adapter's business.
 */
export const parseImportArgs = (
	argv: string[],
	usage: string,
): ImportCliArgs => {
	const positional = argv.filter((a) => !a.startsWith("--"));
	const path = positional[0];
	if (!path) {
		console.error(usage);
		process.exit(2);
	}
	return {
		path,
		isRemote: argv.includes("--remote"),
		dryRun: argv.includes("--dry-run"),
		includeDeleted: argv.includes("--include-deleted"),
		includeSpam: argv.includes("--include-spam"),
		slugOverride: readOption(argv, "slug"),
		option: (name) => readOption(argv, name),
	};
};

const readOption = (argv: string[], name: string): string | null => {
	const prefix = `--${name}=`;
	const hit = argv.find((a) => a.startsWith(prefix));
	return hit ? hit.slice(prefix.length) : null;
};

// -------------------------------- secret -----------------------------------

/**
 * Read IP_HASH_SECRET, or exit 2 explaining why there is no fallback.
 *
 * It keys the HMAC that derives each imported ghost's `provider_id`, so a
 * literal committed to a public repo is a published key: anyone could
 * recompute the provider_id for a known commenter, and every instance that
 * imported without setting the variable would share one derivation. It also
 * has to be the *same* secret the Worker uses, or the same person imported
 * twice — or imported and then commenting live — resolves to two ghosts.
 */
export const requireSecret = (tag: string, example: string): string => {
	const secret = process.env.IP_HASH_SECRET;
	if (!secret) {
		console.error(
			`[${tag}] IP_HASH_SECRET is not set.\n` +
				"  It must match the secret your Worker uses, or imported commenters\n" +
				"  will not resolve to the same identities. Read it from .dev.vars for a\n" +
				"  local import, or your password manager for --remote:\n" +
				`    IP_HASH_SECRET=... ${example}`,
		);
		process.exit(2);
	}
	return secret;
};

// ------------------------------ SQL assembly -------------------------------

/** A value that can't be inlined exactly. Aborts rather than approximating. */
export class BindError extends Error {}

// SQLite string literals escape a quote by doubling it, and recognize no
// backslash escapes, so `''` is the complete escape for a literal.
const sqlEsc = (s: string): string => s.replace(/'/g, "''");

/**
 * Render one bound value as a SQL literal.
 *
 * Why this exists at all: `wrangler d1 execute` accepts only `--command`
 * and `--file`. There is no parameter-binding flag, so a CLI-driven shim
 * has no way to hand D1 a statement and its values separately — the SQL
 * text is the entire interface. Every statement is therefore assembled by
 * substitution, over values parsed out of an untrusted export.
 *
 * What makes that survivable, and what does not:
 *   * `''` is a complete escape for a SQLite literal (see `sqlEsc`).
 *   * wrangler splits multi-statement input with a quote-aware scanner
 *     (`splitSqlIntoStatements` consumes to the closing quote), so a
 *     semicolon inside a correctly-escaped literal — routine in comment
 *     bodies — does not start a new statement.
 *   * Neither of those helps if the *value* never reaches a literal
 *     intact. So this refuses anything it cannot inline exactly, rather
 *     than emitting approximately-right SQL.
 */
export const inline = (v: unknown, index: number): string => {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") {
		// String(NaN) is `NaN` and String(Infinity) is `Infinity`, both bare
		// identifiers to SQLite rather than values. No adapter emits one today
		// — each falls back to a real timestamp on an unparseable date — so
		// this holds the invariant for future callers rather than fixing a
		// live bug.
		if (!Number.isFinite(v)) {
			throw new BindError(`bind ${index}: non-finite number ${String(v)}`);
		}
		return String(v);
	}
	if (typeof v === "string") {
		// argv is NUL-terminated, so a NUL in the value truncates the SQL
		// mid-statement on its way to wrangler — silently, and at a position
		// the attacker picks. Nothing in a legitimate export carries one;
		// refuse rather than truncate.
		if (v.includes("\u0000")) {
			throw new BindError(`bind ${index}: NUL byte in string value`);
		}
		return `'${sqlEsc(v)}'`;
	}
	// Booleans, bigints, objects and functions all used to reach String(),
	// which produced `true`, `[object Object]` and worse. The importer binds
	// only strings, numbers and null; anything else is a bug in the caller.
	throw new BindError(`bind ${index}: unsupported type ${typeof v}`);
};

/** Substitute bound values into a `?`-placeholder statement. */
export const resolve = (sql: string, binds: unknown[]): string => {
	let i = 0;
	// `replace` does not rescan its own output, so a `?` inside an inlined
	// value can't consume the next bind.
	const out = sql.replace(/\?/g, () => inline(binds[i++], i));
	// A placeholder/bind mismatch used to be invisible: a surplus placeholder
	// read `undefined` and quietly became NULL, so a mis-shaped INSERT wrote a
	// row with a hole in it instead of failing. Both directions are bugs.
	if (i !== binds.length) {
		throw new BindError(
			`placeholder/bind mismatch: ${i} placeholder(s), ${binds.length} bound value(s) in: ${sql.slice(0, 120)}`,
		);
	}
	return out;
};

/**
 * The rows from one `wrangler d1 execute --command` run.
 *
 * wrangler prints a banner and then a JSON envelope, one element per
 * statement, each `{ results, success, meta }`:
 *
 *     🚣 1 command executed successfully.
 *     [ { "results": [], "success": true, "meta": { "duration": 0 } } ]
 *
 * Unwrap properly rather than treating the envelope itself as the rows: for
 * this caller an envelope object is truthy, so every `SELECT … WHERE …`
 * existence probe would report "this row already exists" and the import
 * would insert nothing while printing DONE with all-zero counters.
 *
 * Throws rather than returning [] when the output can't be read: for this
 * caller "no rows" means "go ahead and insert", so guessing it on a parse
 * failure is how a silently-broken import looks. A loud failure is
 * recoverable; a no-op that claims success is not.
 */
type D1Envelope = { results?: unknown };

export const parseRows = (output: string): Record<string, unknown>[] => {
	// The banner precedes the JSON, so anchor on the first `[` that starts a
	// line — wrangler pretty-prints, and a nested `]` inside a row value would
	// end a non-greedy match early.
	const start = output.search(/^\[/m);
	if (start === -1) {
		// No envelope at all. wrangler exited 0, so this is an output-format
		// change, not a query error (execFileSync throws on non-zero).
		throw new Error(
			`could not find a JSON result envelope in wrangler output:\n${output.slice(0, 400)}`,
		);
	}
	let envelope: unknown;
	try {
		envelope = JSON.parse(output.slice(start));
	} catch (err) {
		throw new Error(`could not parse wrangler output as JSON: ${String(err)}`);
	}
	if (!Array.isArray(envelope)) {
		throw new Error("wrangler result envelope was not an array");
	}
	// One statement in, so one element out; be tolerant of more.
	return envelope.flatMap((e) => {
		const results = (e as D1Envelope)?.results;
		if (results === undefined) return [];
		if (!Array.isArray(results)) {
			throw new Error("wrangler result envelope had a non-array `results`");
		}
		return results as Record<string, unknown>[];
	});
};

// --------------------------------- D1 shim ---------------------------------

/**
 * A `D1Database` that talks to wrangler, one statement per subprocess.
 *
 * tsx running locally can't bind D1 directly. That is only viable for
 * thousands-not-millions of rows; the admin endpoint uses the same importer
 * library inside the Worker where DB is bound natively, which is the
 * production path.
 */
export const wranglerD1 = (isRemote: boolean): D1Database => {
	const remoteFlag = isRemote ? "--remote" : "--local";
	const run = (sql: string): string =>
		execFileSync(
			"wrangler",
			["d1", "execute", DB_BINDING, remoteFlag, "--command", sql],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);

	return {
		prepare(sql: string) {
			const binds: unknown[] = [];
			return {
				bind(...args: unknown[]) {
					binds.push(...args);
					return this;
				},
				async first<T = unknown>(): Promise<T | null> {
					return (parseRows(run(resolve(sql, binds)))[0] as T) ?? null;
				},
				async all<T = unknown>(): Promise<{ results: T[] }> {
					return { results: parseRows(run(resolve(sql, binds))) as T[] };
				},
				async run() {
					run(resolve(sql, binds));
					return { meta: { changes: 1 } };
				},
			} as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
};

// -------------------------------- reporting --------------------------------

export const reportPlan = (tag: string, dryRun: boolean, plan: unknown): void => {
	console.log(`[${tag}] ${dryRun ? "DRY RUN" : "DONE"}`, JSON.stringify(plan, null, 2));
};

/**
 * Print a failure and exit 1.
 *
 * Prints the message, never the error object and never a slice of the file.
 * An export carries display names, email addresses and sometimes the
 * source's own hashed IPs, and an unlucky `err` — a JSON.parse failure, say
 * — quotes the input it choked on. Every throw on this path is written to
 * name a record POSITION rather than a record, so the message alone is both
 * content-free and enough to find the bad row by hand.
 */
export const failImport = (tag: string, err: unknown): never => {
	if (err instanceof ImportTooLargeError) {
		// Its own branch because gzip is the normal transport for most
		// sources: an export that inflates past the cap is the expected way a
		// legitimate large instance fails, and "too large" is a different
		// instruction to the operator than "malformed".
		console.error(`[${tag}] export is too large to import: ${err.message}`);
		process.exit(1);
	}
	console.error(
		`[${tag}] failed: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exit(1);
};
