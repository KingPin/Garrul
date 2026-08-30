#!/usr/bin/env tsx
/**
 * Import a Cusdis JSON intermediate into the local or remote D1.
 *
 * Cusdis (`djyde/cusdis`) is deprecated upstream and ships no export —
 * `db.sqlite` is the data store itself. Getting comments out is a two-step
 * process:
 *
 *   npm run dump-cusdis -- /path/db.sqlite --out cusdis-dump.json  # on the
 *                                                                  # machine
 *                                                                  # that
 *                                                                  # has the
 *                                                                  # DB
 *   npm run import-cusdis -- cusdis-dump.json                      # here
 *
 * The dumper is a node-only reader over `node:sqlite`; this CLI only ever
 * sees its JSON output, so it can run anywhere.
 *
 *   npm run import-cusdis -- ./cusdis-dump.json                # local D1
 *   npm run import-cusdis -- ./cusdis-dump.json.gz              # gzipped, too
 *   npm run import-cusdis -- ./cusdis-dump.json --remote         # production D1
 *
 * Flags:
 *   --remote            Use the deployed D1 binding instead of Miniflare.
 *   --dry-run           Parse + plan only. No INSERTs run.
 *   --include-deleted   Bring Cusdis' soft-deleted comments across
 *                       (default: skip). Cusdis keeps the author and body
 *                       on a deleted row and does not cascade to replies,
 *                       so this restores the exact thread shape instead of
 *                       promoting a deleted parent's replies to roots.
 *   --project=<id>      One Cusdis database holds every project (site) the
 *                       operator created, and Garrul slugs are single-site.
 *                       A dump with more than one project is refused until
 *                       this names one — by project **id** (titles are not
 *                       unique). The refusal lists the ids and titles. A
 *                       project deleted in Cusdis is not counted and not
 *                       imported unless this names it.
 *   --site=<origin>     A page's `url` is client-declared and often empty.
 *                       When given, a page without one has its slug
 *                       resolved against this origin for `posts.url`;
 *                       without it, such posts have no permalink until an
 *                       operator sets one.
 *   --slug=<slug>       Put every imported comment on this one page slug,
 *                       ignoring the slug each page derives to. Same flag,
 *                       same meaning, as the other importers.
 *
 * Idempotent: re-running on the same dump inserts zero new rows (every
 * comment carries `import_source='cusdis'` + Cusdis' own comment UUID
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
import { runCusdisImport } from "../src/lib/import/cusdis";
import {
	failImport,
	parseImportArgs,
	reportPlan,
	requireSecret,
	wranglerD1,
} from "./import-cli";

const TAG = "import-cusdis";

const args = parseImportArgs(
	process.argv.slice(2),
	`usage: npm run ${TAG} -- <cusdis-dump.json> [--remote] [--dry-run] [--include-deleted] [--project=<id>] [--site=<origin>] [--slug=<slug>]`,
);

(async () => {
	if (!args.isRemote) {
		console.warn(`[${TAG}] running against LOCAL D1 (Miniflare).`);
	}
	// Read bytes, not utf8, and let decodeImportInput sniff the gzip magic —
	// same reason as the other importer CLIs: a gzipped dump read as utf8
	// would be corrupt before the sniff ever ran.
	const doc = await decodeImportInput(readFileSync(args.path));
	const secret = requireSecret(TAG, `npm run ${TAG} -- <cusdis-dump.json>`);

	const plan = await runCusdisImport(wranglerD1(args.isRemote), doc, secret, {
		dry_run: args.dryRun,
		include_deleted: args.includeDeleted,
		slug_override: args.slugOverride,
		project: args.option("project"),
		site: args.option("site"),
	});

	reportPlan(TAG, args.dryRun, plan);
})().catch((err) => failImport(TAG, err));
