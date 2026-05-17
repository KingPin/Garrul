#!/usr/bin/env tsx
/**
 * Fails if dist/embed.js is larger than the configured gzipped ceiling.
 *
 * We want the embed.js bundle to stay small enough that a host page is
 * never punished for adding comments. 20KB gzipped is the published cap;
 * the bundle is currently ~3KB gzipped, so we have plenty of headroom.
 *
 * Run after `npm run build:embed`. CI invokes it via `npm run size`.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BUNDLE = join(ROOT, "dist/embed.js");

const LIMIT_GZ_BYTES = 20 * 1024;

try {
	statSync(BUNDLE);
} catch {
	console.error(
		`[size] ${BUNDLE} does not exist — run \`npm run build:embed\` first.`,
	);
	process.exit(1);
}

const raw = readFileSync(BUNDLE);
const gz = gzipSync(raw, { level: 9 });

const kb = (n: number) => (n / 1024).toFixed(2);

console.log(`[size] embed.js          ${kb(raw.length)} KB`);
console.log(`[size] embed.js (gzip)   ${kb(gz.length)} KB`);
console.log(`[size] ceiling (gzip)    ${kb(LIMIT_GZ_BYTES)} KB`);

if (gz.length > LIMIT_GZ_BYTES) {
	console.error(
		`[size] FAIL — bundle exceeds ceiling by ${kb(gz.length - LIMIT_GZ_BYTES)} KB.`,
	);
	process.exit(1);
}
console.log("[size] OK");
