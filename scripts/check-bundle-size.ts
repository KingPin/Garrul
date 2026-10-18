#!/usr/bin/env tsx
/**
 * Fails if dist/embed.js is larger than the configured gzipped ceiling.
 *
 * We want the embed.js bundle to stay small enough that a host page is
 * never punished for adding comments. 30KB gzipped is the published cap.
 * Run `npm run size` for the current figure rather than trusting a
 * number in a comment — this one drifted for several releases.
 *
 * The cap is a backstop, not a target. It was raised from 20KB in #79,
 * on the reasoning that the queued widget backlog would otherwise force
 * feature-vs-bytes decisions mid-PR. The number that actually keeps the
 * bundle honest is the per-PR delta (scripts/bundle-delta.ts), not this
 * ceiling — headroom is for absorbing features, not for spending.
 *
 * Run after `npm run build:embed`. CI invokes it via `npm run size`.
 */
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUNDLE = join(ROOT, "dist/embed.js");

const LIMIT_GZ_BYTES = 30 * 1024;

// Read directly and report on failure — a stat-then-read pair is a TOCTOU
// race (CodeQL js/file-system-race), and the read's own error covers it.
let raw: Buffer;
try {
	raw = readFileSync(BUNDLE);
} catch {
	console.error(
		`[size] ${BUNDLE} does not exist — run \`npm run build:embed\` first.`,
	);
	process.exit(1);
}
const gz = gzipSync(raw, { level: 9 });

const kb = (n: number) => (n / 1024).toFixed(2);

const pct = ((gz.length / LIMIT_GZ_BYTES) * 100).toFixed(1);

console.log(`[size] embed.js          ${kb(raw.length)} KB`);
console.log(`[size] embed.js (gzip)   ${kb(gz.length)} KB`);
console.log(`[size] ceiling (gzip)    ${kb(LIMIT_GZ_BYTES)} KB`);
console.log(`[size] consumed          ${pct}% of ceiling`);

if (gz.length > LIMIT_GZ_BYTES) {
	console.error(
		`[size] FAIL — bundle exceeds ceiling by ${kb(gz.length - LIMIT_GZ_BYTES)} KB.`,
	);
	process.exit(1);
}
console.log("[size] OK");

// Static Assets copy (see scripts/build-embed.ts). Wrangler serves
// public/embed.js without invoking the Worker when `[assets]` is configured,
// so it must be the same bytes the Hono fallback route serves, or an install
// with and without the block would run different widgets.
const PUBLIC_DIR = join(ROOT, "public");
let publicCopy: Buffer;
try {
	publicCopy = readFileSync(join(PUBLIC_DIR, "embed.js"));
} catch {
	console.error("[size] public/embed.js missing — run `npm run build:embed`.");
	process.exit(1);
}
if (!publicCopy.equals(raw)) {
	console.error("[size] public/embed.js differs from dist/embed.js — rebuild.");
	process.exit(1);
}
const headers = readFileSync(join(PUBLIC_DIR, "_headers"), "utf8");
for (const line of ["/embed.js", "Cache-Control: public, max-age=3600, s-maxage=86400", "X-Content-Type-Options: nosniff"]) {
	if (!headers.includes(line)) {
		console.error(`[size] public/_headers is missing "${line}".`);
		process.exit(1);
	}
}
console.log("[size] public/embed.js matches dist/embed.js; _headers ok");
