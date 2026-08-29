#!/usr/bin/env tsx
/**
 * Import a Remark42 native export into the local or remote D1.
 *
 *   npm run import-remark42 -- ./userbackup-site-20260101.gz      # local D1
 *   npm run import-remark42 -- ./export.jsonl                     # plain, too
 *   npm run import-remark42 -- ./userbackup-site.gz --remote      # production D1
 *
 * Flags:
 *   --remote            Use the deployed D1 binding instead of Miniflare.
 *   --dry-run           Parse + plan only. No INSERTs run.
 *   --include-deleted   Bring Remark42-deleted comments across (default: skip).
 *   --include-spam      Bring source-spam comments across (default: skip).
 *                       Inert for this source — Remark42 has no spam verdict, so
 *                       the adapter never emits `status='spam'`. Kept so every
 *                       importer CLI takes the same flags.
 *   --slug=<slug>       Pin every imported thread to one slug (rare —
 *                       useful when migrating a single page).
 *
 * Idempotent: re-running on the same backup inserts zero new rows (every
 * comment carries `import_source='remark42'` + Remark42's own comment id
 * under `import_id`, and migration 0009 puts a partial UNIQUE index on that
 * pair).
 *
 * Why this is a local CLI, not a Worker endpoint:
 *   Big exports easily exceed the Workers free-tier 100k D1 writes/day
 *   quota in a single import. Running locally via wrangler d1 execute
 *   counts those writes against your D1 budget, but does NOT spend any
 *   Worker requests. The admin upload endpoint (operator page) wraps this
 *   same library, and bounds a run only by capping the upload at
 *   MAX_IMPORT_BYTES on the decompressed side — which is a cap on input,
 *   not on writes. A backup under that cap can still be a lot of rows.
 *
 * The D1 shim, flag parsing and error hygiene are shared with the other
 * importer CLIs — see scripts/import-cli.ts.
 */
import { readFileSync } from "node:fs";

import { decodeImportInput } from "../src/lib/import/core";
import { runRemark42Import } from "../src/lib/import/remark42";
import {
	failImport,
	parseImportArgs,
	reportPlan,
	requireSecret,
	wranglerD1,
} from "./import-cli";

const TAG = "import-remark42";

const args = parseImportArgs(
	process.argv.slice(2),
	`usage: npm run ${TAG} -- <path-to-remark42-backup> [--remote] [--dry-run]`,
);

(async () => {
	if (!args.isRemote) {
		console.warn(`[${TAG}] running against LOCAL D1 (Miniflare).`);
	}
	// Read bytes, not utf8, and let decodeImportInput sniff the gzip magic.
	// This is load-bearing here in a way it is not for every source: a
	// Remark42 backup is normally gzipped binary — `backup` writes
	// `userbackup-<site>-<ts>.gz` nightly and the API's `mode=file` hands
	// back the same thing — while `mode=stream` returns plain JSONL. Sniffing
	// the bytes lets one script accept both transports with no per-transport
	// code, and reading a `.gz` as utf8 would corrupt it before the sniff
	// ever ran.
	const backup = await decodeImportInput(readFileSync(args.path));
	const secret = requireSecret(TAG, `npm run ${TAG} -- <backup.gz>`);

	const plan = await runRemark42Import(
		wranglerD1(args.isRemote),
		backup,
		secret,
		{
			dry_run: args.dryRun,
			include_deleted: args.includeDeleted,
			include_spam: args.includeSpam,
			slug_override: args.slugOverride,
		},
	);

	reportPlan(TAG, args.dryRun, plan);
})().catch((err) => failImport(TAG, err));
