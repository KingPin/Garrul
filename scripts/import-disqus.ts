#!/usr/bin/env tsx
/**
 * Import a Disqus comment-export XML file into the local or remote D1.
 *
 *   npm run import-disqus -- ./disqus-export.xml             # local D1
 *   npm run import-disqus -- ./disqus-export.xml.gz          # gzipped, too
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
 *
 * The D1 shim, flag parsing and error hygiene are shared with the other
 * importer CLIs — see scripts/import-cli.ts.
 */
import { readFileSync } from "node:fs";

import { decodeImportInput } from "../src/lib/import/core";
import { runDisqusImport } from "../src/lib/import/disqus";
import {
	failImport,
	parseImportArgs,
	reportPlan,
	requireSecret,
	wranglerD1,
} from "./import-cli";

const TAG = "import-disqus";

const args = parseImportArgs(
	process.argv.slice(2),
	`usage: npm run ${TAG} -- <path-to-disqus.xml> [--remote] [--dry-run]`,
);

(async () => {
	if (!args.isRemote) {
		console.warn(`[${TAG}] running against LOCAL D1 (Miniflare).`);
	}
	// Read bytes, not utf8: decodeImportInput sniffs the gzip magic, so
	// `./export.xml.gz` works without inflating it first. Reading a gzipped
	// file as utf8 would corrupt it before the sniff ever ran.
	const xml = await decodeImportInput(readFileSync(args.path));
	const secret = requireSecret(TAG, `npm run ${TAG} -- <file.xml>`);

	const plan = await runDisqusImport(wranglerD1(args.isRemote), xml, secret, {
		dry_run: args.dryRun,
		include_deleted: args.includeDeleted,
		include_spam: args.includeSpam,
		slug_override: args.slugOverride,
	});

	reportPlan(TAG, args.dryRun, plan);
})().catch((err) => failImport(TAG, err));
