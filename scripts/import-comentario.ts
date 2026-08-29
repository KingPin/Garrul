#!/usr/bin/env tsx
/**
 * Import a Comentario (v3) or legacy Commento (v1) export into the local
 * or remote D1.
 *
 *   npm run import-comentario -- ./comentario.export.json          # local D1
 *   npm run import-comentario -- ./comentario.export.json.gz       # gzipped, too
 *   npm run import-comentario -- ./export.json --remote            # production D1
 *
 * Both products write a single JSON document whose `version` field says
 * which of the two shapes it is. One adapter reads both — Commento is
 * Comentario's ancestor, an operator leaving one is leaving the same
 * product, and the source tag is shared so a v1 file and a later v3 file
 * from the same instance deduplicate against each other.
 *
 * Flags:
 *   --remote            Use the deployed D1 binding instead of Miniflare.
 *   --dry-run           Parse + plan only. No INSERTs run.
 *   --include-deleted   Bring source-deleted comments across (default: skip).
 *   --include-spam      Bring moderator-rejected comments across (default:
 *                       skip). Neither product has a spam classifier; what
 *                       the adapter marks `spam` is a comment a human
 *                       moderator rejected (v3) or flagged (v1).
 *   --slug=<slug>       Pin every imported thread to one slug (rare —
 *                       useful when migrating a single page).
 *   --domain=<id>       Narrow a multi-domain export to one site. A
 *                       `domainId` UUID for v3, a bare host for v1. Without
 *                       it, an export carrying more than one is refused
 *                       rather than flattened — see below.
 *
 * On --domain: both products are multi-site, and neither export namespaces
 * its page paths by site. Two domains' `/about` would collide onto one
 * Garrul slug with no way to tell afterwards which comments came from
 * which, so the adapter stops instead. Run it once per domain. A v3 export
 * carries no hostnames at all — pages reference a `domainId` UUID and the
 * only place a real host appears is a comment permalink — so the value to
 * pass for v3 is the UUID the error message prints.
 *
 * Idempotent: re-running on the same export inserts zero new rows (every
 * comment carries `import_source='comentario'` + the source's own comment
 * id under `import_id`, and migration 0009 puts a partial UNIQUE index on
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

import { runComentarioImport } from "../src/lib/import/comentario";
import { decodeImportInput } from "../src/lib/import/core";
import {
	failImport,
	parseImportArgs,
	reportPlan,
	requireSecret,
	wranglerD1,
} from "./import-cli";

const TAG = "import-comentario";

const args = parseImportArgs(
	process.argv.slice(2),
	`usage: npm run ${TAG} -- <path-to-export.json> [--remote] [--dry-run] [--domain=<id>]`,
);

(async () => {
	if (!args.isRemote) {
		console.warn(`[${TAG}] running against LOCAL D1 (Miniflare).`);
	}
	// Read bytes, not utf8, and let decodeImportInput sniff the gzip magic.
	// Comentario's admin UI offers the export gzipped, and a `.gz` read as
	// utf8 would be corrupt before the sniff ever ran.
	const doc = await decodeImportInput(readFileSync(args.path));
	const secret = requireSecret(TAG, `npm run ${TAG} -- <export.json>`);

	const plan = await runComentarioImport(wranglerD1(args.isRemote), doc, secret, {
		dry_run: args.dryRun,
		include_deleted: args.includeDeleted,
		include_spam: args.includeSpam,
		slug_override: args.slugOverride,
		domain: args.option("domain"),
	});

	reportPlan(TAG, args.dryRun, plan);
})().catch((err) => failImport(TAG, err));
