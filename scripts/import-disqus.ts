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

import { runDisqusImport } from "../src/lib/disqus-import";

const DB_NAME = "garrul-db";

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
const sqlEsc = (s: string): string => s.replace(/'/g, "''");

const runWrangler = (sql: string): string =>
	execFileSync(
		"wrangler",
		["d1", "execute", DB_NAME, remoteFlag, "--command", sql],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);

const d1: D1Database = {
	prepare(rawSql: string) {
		let sql = rawSql;
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

const resolve = (sql: string, binds: unknown[]): string => {
	let i = 0;
	return sql.replace(/\?/g, () => {
		const v = binds[i++];
		if (v === null || v === undefined) return "NULL";
		if (typeof v === "number") return String(v);
		return `'${sqlEsc(String(v))}'`;
	});
};

const parseRows = (output: string): Record<string, unknown>[] => {
	// wrangler d1 execute --command prints a small JSON envelope when
	// the query returns rows. We only need the rows arm — anything else
	// (errors / empty result sets) becomes [].
	const m = output.match(/\[(\s*\{[\s\S]*?\}\s*)\]/);
	if (!m) return [];
	try {
		return JSON.parse(m[0]) as Record<string, unknown>[];
	} catch {
		return [];
	}
};

(async () => {
	if (!isRemote) {
		console.warn(`[import-disqus] running against LOCAL D1 (Miniflare).`);
	}
	const xml = readFileSync(xmlPath, "utf8");
	const secret = process.env.IP_HASH_SECRET ?? "disqus-import-secret-fallback";

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
