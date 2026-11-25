#!/usr/bin/env tsx
/**
 * Fails if dist/embed.js or dist/embed-highlight.js is larger than its
 * gzipped ceiling, if the Static Assets copy under public/ differs, or if the
 * path's own public/_headers block lacks the cache and nosniff headers.
 *
 * We want the embed.js bundle to stay small enough that a host page is
 * never punished for adding comments. 30KB gzipped is the published cap.
 * The highlighter is fetched lazily, only for comments with fenced code, so
 * it gets its own 40KB ceiling. Run `npm run size` for the current figure
 * rather than trusting a number in a comment — this one drifted for several
 * releases.
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
const PUBLIC_DIR = join(ROOT, "public");

const BUNDLES = [
	{ name: "embed.js", limitKb: 30 },
	{ name: "embed-highlight.js", limitKb: 40 },
];

const kb = (n: number) => (n / 1024).toFixed(2);

// Read directly and report on failure — a stat-then-read pair is a TOCTOU
// race (CodeQL js/file-system-race), and the read's own error covers it.
function readOrExit(path: string, what: string): Buffer {
	try {
		return readFileSync(path);
	} catch {
		console.error(`[size] ${what} missing — run \`npm run build:embed\` first.`);
		process.exit(1);
	}
}

const headers = readOrExit(join(PUBLIC_DIR, "_headers"), "public/_headers").toString("utf8");
// A blank-line-separated block whose first line is the path. Checking the whole
// file would let one complete block satisfy every path.
const headerBlock = (path: string): string[] =>
	headers
		.split(/\n\s*\n/)
		.map((b) => b.split("\n").map((l) => l.trim()))
		.find((lines) => lines[0] === path) ?? [];

for (const { name, limitKb } of BUNDLES) {
	const limit = limitKb * 1024;
	const raw = readOrExit(join(ROOT, "dist", name), `dist/${name}`);
	const gz = gzipSync(raw, { level: 9 });
	const pct = ((gz.length / limit) * 100).toFixed(1);

	console.log(`[size] ${name.padEnd(18)} ${kb(raw.length)} KB`);
	console.log(`[size] ${`${name} (gzip)`.padEnd(18)} ${kb(gz.length)} KB`);
	console.log(`[size] ceiling (gzip)    ${kb(limit)} KB`);
	console.log(`[size] consumed          ${pct}% of ceiling`);

	if (gz.length > limit) {
		console.error(`[size] FAIL — ${name} exceeds ceiling by ${kb(gz.length - limit)} KB.`);
		process.exit(1);
	}
	console.log("[size] OK");

	// Static Assets copy (see scripts/build-embed.ts). Wrangler serves
	// public/<name> without invoking the Worker when `[assets]` is configured,
	// so it must be the same bytes the Hono fallback route serves, or an install
	// with and without the block would run different widgets.
	const publicCopy = readOrExit(join(PUBLIC_DIR, name), `public/${name}`);
	if (!publicCopy.equals(raw)) {
		console.error(`[size] public/${name} differs from dist/${name} — rebuild.`);
		process.exit(1);
	}
	const block = headerBlock(`/${name}`);
	for (const line of ["Cache-Control: public, max-age=3600, s-maxage=86400", "X-Content-Type-Options: nosniff"]) {
		if (!block.includes(line)) {
			console.error(`[size] public/_headers block for /${name} is missing "${line}".`);
			process.exit(1);
		}
	}
	console.log(`[size] public/${name} matches dist/${name}; _headers ok`);
}
