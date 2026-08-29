#!/usr/bin/env tsx
/**
 * Import an isso JSON intermediate into the local or remote D1.
 *
 * isso (`isso-comments/isso`) ships no export command — `comments.db` is
 * the data store itself. Getting comments out is a two-step process:
 *
 *   npm run dump-isso -- /path/comments.db --out isso-dump.json   # on the
 *                                                                  # machine
 *                                                                  # that
 *                                                                  # has the
 *                                                                  # DB
 *   npm run import-isso -- isso-dump.json                        # here
 *
 * The dumper is a node-only reader over `node:sqlite`; this CLI only ever
 * sees its JSON output, so it can run anywhere.
 *
 *   npm run import-isso -- ./isso-dump.json                # local D1
 *   npm run import-isso -- ./isso-dump.json.gz              # gzipped, too
 *   npm run import-isso -- ./isso-dump.json --remote         # production D1
 *
 * Flags:
 *   --remote            Use the deployed D1 binding instead of Miniflare.
 *   --dry-run           Parse + plan only. No INSERTs run.
 *   --include-deleted   Bring isso's mode=4 tombstones across (default:
 *                       skip). isso only keeps a tombstone while it still
 *                       has live children, so every one in a real export is
 *                       load-bearing — pass this to reproduce isso's exact
 *                       thread shape rather than promoting its replies to
 *                       roots.
 *   --site=<origin>     isso stores a path (`threads.uri`), not a URL, so
 *                       `posts.url` needs a host isso does not have. When
 *                       given, each thread's link is resolved against this
 *                       origin; without it, imported posts have no
 *                       permalink until an operator sets one.
 *   --slug=<slug>       Put every imported comment on this one page slug,
 *                       ignoring the slug each thread's `uri` derives to.
 *                       Same flag, same meaning, as the other importers.
 *
 * Idempotent: re-running on the same dump inserts zero new rows (every
 * comment carries `import_source='isso'` + the source's own comment id
 * under `import_id`, and migration 0009 puts a partial UNIQUE index on
 * that pair).
 *
 * Why this is a local CLI, not a Worker endpoint:
 *   Big exports easily exceed the Workers free-tier 100k D1 writes/day
 *   quota in a single import. Running locally via wrangler d1 execute
 *   counts those writes against your D1 budget, but does NOT spend any
 *   Worker requests. The admin upload endpoint (operator page) wraps this
 *   same library, and bounds a run only by capping the upload at
 *   MAX_IMPORT_BYTES on the decompressed side — which is a cap on input,
 *   not on writes.
 *
 * The D1 shim, flag parsing and error hygiene are shared with the other
 * importer CLIs — see scripts/import-cli.ts.
 */
import { readFileSync } from "node:fs";

import { decodeImportInput } from "../src/lib/import/core";
import { runIssoImport } from "../src/lib/import/isso";
import {
	failImport,
	parseImportArgs,
	reportPlan,
	requireSecret,
	wranglerD1,
} from "./import-cli";

const TAG = "import-isso";

const args = parseImportArgs(
	process.argv.slice(2),
	`usage: npm run ${TAG} -- <isso-dump.json> [--remote] [--dry-run] [--include-deleted] [--site=<origin>] [--slug=<slug>]`,
);

(async () => {
	if (!args.isRemote) {
		console.warn(`[${TAG}] running against LOCAL D1 (Miniflare).`);
	}
	// Read bytes, not utf8, and let decodeImportInput sniff the gzip magic —
	// same reason as the other importer CLIs: a gzipped dump read as utf8
	// would be corrupt before the sniff ever ran.
	const doc = await decodeImportInput(readFileSync(args.path));
	const secret = requireSecret(TAG, `npm run ${TAG} -- <isso-dump.json>`);

	const plan = await runIssoImport(wranglerD1(args.isRemote), doc, secret, {
		dry_run: args.dryRun,
		include_deleted: args.includeDeleted,
		slug_override: args.slugOverride,
		site: args.option("site"),
	});

	reportPlan(TAG, args.dryRun, plan);
})().catch((err) => failImport(TAG, err));
