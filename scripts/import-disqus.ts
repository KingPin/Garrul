#!/usr/bin/env tsx
/**
 * Import a Disqus comment-export XML file into the local or remote D1.
 *
 *   npm run import-disqus -- ./disqus-export.xml             # local D1
 *   npm run import-disqus -- ./disqus-export.xml --remote    # production D1
 *
 * Flags:
 *   --remote            Use the deployed D1 binding instead of Miniflare.
 *   --dry-run           Parse + plan only. No INSERTs run.
 *   --include-deleted   Bring Disqus-deleted comments across (default: skip).
 *   --include-spam      Bring Disqus-spam comments across (default: skip).
 *   --slug=<slug>       Pin every imported thread to one slug (rare —
 *                       useful when migrating a single page).
 *
 * Idempotent: re-running on the same XML inserts zero new rows (every
 * comment carries `import_source='disqus'` + a Disqus dsq_id under
 * `import_id`, and migration 0009 puts a partial UNIQUE index on that
 * pair).
 *
 * Why this is a local CLI, not a Worker endpoint:
 *   Big Disqus exports easily exceed the Workers free-tier 100k D1
 *   writes/day quota in a single import. Running locally via wrangler
 *   d1 execute counts those writes against your D1 budget, but does
 *   NOT spend any Worker requests. The admin upload endpoint
 *   (operator page) wraps this same library but caps the per-call
 *   write volume.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { runDisqusImport } from "../src/lib/import/disqus";

// The binding, not `database_name` — see the docblock in src/db/migrate.ts.
const DB_BINDING = "DB";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const xmlPath = positional[0];
if (!xmlPath) {
	console.error("usage: npm run import-disqus -- <path-to-disqus.xml> [--remote] [--dry-run]");
	process.exit(2);
}
const isRemote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const includeDeleted = args.includes("--include-deleted");
const includeSpam = args.includes("--include-spam");
const slugFlag = args.find((a) => a.startsWith("--slug="));
const slugOverride = slugFlag ? slugFlag.slice("--slug=".length) : null;

const remoteFlag = isRemote ? "--remote" : "--local";

// The importer needs to talk to D1. tsx running locally can't bind D1
// directly — we drive it through `wrangler d1 execute` per statement.
// That's only viable for thousands-not-millions of rows. The admin
// endpoint uses the same library inside the Worker where DB is bound
// natively, which is the production path.
//
// Why this interpolates instead of binding: `wrangler d1 execute` accepts
// only `--command` and `--file`. There is no parameter-binding flag, so a
// CLI-driven shim has no way to hand D1 a statement and its values
// separately — the SQL text is the entire interface. Every statement here
// is therefore assembled by substitution, over values parsed out of an
// untrusted Disqus export.
//
// What makes that survivable, and what does not:
//   * SQLite string literals escape a quote by doubling it, and recognize
//     no backslash escapes, so `''` is the complete escape for a literal.
//   * wrangler splits multi-statement input with a quote-aware scanner
//     (`splitSqlIntoStatements` consumes to the closing quote), so a
//     semicolon inside a correctly-escaped literal — routine in comment
//     bodies — does not start a new statement.
//   * Neither of those helps if the *value* never reaches a literal
//     intact. `resolve` below therefore refuses anything it cannot inline
//     exactly, rather than emitting approximately-right SQL.
const sqlEsc = (s: string): string => s.replace(/'/g, "''");

const runWrangler = (sql: string): string =>
	execFileSync(
		"wrangler",
		["d1", "execute", DB_BINDING, remoteFlag, "--command", sql],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);

const d1: D1Database = {
	prepare(rawSql: string) {
		const sql = rawSql;
		const binds: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				binds.push(...args);
				return this;
			},
			async first<T = unknown>(): Promise<T | null> {
				const resolved = resolve(sql, binds);
				const out = runWrangler(resolved);
				const rows = parseRows(out);
				return (rows[0] as T) ?? null;
			},
			async all<T = unknown>(): Promise<{ results: T[] }> {
				const resolved = resolve(sql, binds);
				const out = runWrangler(resolved);
				return { results: parseRows(out) as T[] };
			},
			async run() {
				const resolved = resolve(sql, binds);
				runWrangler(resolved);
				return { meta: { changes: 1 } };
			},
		} as unknown as D1PreparedStatement;
	},
} as unknown as D1Database;

// A value that can't be inlined exactly. Aborts the import rather than
// letting a wrong-but-valid statement reach D1.
class BindError extends Error {}

const inline = (v: unknown, index: number): string => {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") {
		// String(NaN) is `NaN` and String(Infinity) is `Infinity`, both bare
		// identifiers to SQLite rather than values. Not reachable from the XML
		// today — parseDisqusXml falls back to Date.now() on an unparseable
		// <createdAt> — so this holds the invariant for future callers rather
		// than fixing a live bug.
		if (!Number.isFinite(v)) {
			throw new BindError(`bind ${index}: non-finite number ${String(v)}`);
		}
		return String(v);
	}
	if (typeof v === "string") {
		// argv is NUL-terminated, so a NUL in the value truncates the SQL
		// mid-statement on its way to wrangler — silently, and at a position
		// the attacker picks. Nothing in a Disqus export legitimately carries
		// one; refuse rather than truncate.
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

const resolve = (sql: string, binds: unknown[]): string => {
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
 * The previous version regex-matched the first `[ { … } ]` in that output and
 * returned it *as the rows* — so an empty result set came back as one truthy
 * envelope object. Every `SELECT … WHERE …` existence probe in the importer
 * therefore reported "this row already exists", and the CLI import inserted
 * nothing at all while printing DONE with all-zero counters. Unwrap properly.
 *
 * Throws rather than returning [] when the output can't be read: for this
 * caller "no rows" means "go ahead and insert", so guessing it on a parse
 * failure is how a silently-broken import looks. A loud failure is recoverable;
 * a no-op that claims success is not.
 */
type D1Envelope = { results?: unknown };

const parseRows = (output: string): Record<string, unknown>[] => {
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

(async () => {
	if (!isRemote) {
		console.warn(`[import-disqus] running against LOCAL D1 (Miniflare).`);
	}
	const xml = readFileSync(xmlPath, "utf8");
	// No fallback. This keys the HMAC that derives each imported ghost's
	// `provider_id` from its Disqus name and email, so a literal committed to a
	// public repo is a published key: anyone could recompute the provider_id for
	// a known commenter, and every instance that ever imported without setting
	// the variable shares the same derivation. It also has to be the *same*
	// secret the Worker uses, or the same person imported twice — or imported
	// and then commenting live — resolves to two different ghosts.
	const secret = process.env.IP_HASH_SECRET;
	if (!secret) {
		console.error(
			"[import-disqus] IP_HASH_SECRET is not set.\n" +
				"  It must match the secret your Worker uses, or imported commenters\n" +
				"  will not resolve to the same identities. Read it from .dev.vars for a\n" +
				"  local import, or your password manager for --remote:\n" +
				"    IP_HASH_SECRET=... npm run import-disqus -- <file.xml>",
		);
		process.exit(2);
	}

	const plan = await runDisqusImport(d1, xml, secret, {
		dry_run: dryRun,
		include_deleted: includeDeleted,
		include_spam: includeSpam,
		slug_override: slugOverride,
	});

	console.log(
		`[import-disqus] ${dryRun ? "DRY RUN" : "DONE"}`,
		JSON.stringify(plan, null, 2),
	);
})().catch((err) => {
	console.error("[import-disqus] failed:", err);
	process.exit(1);
});
