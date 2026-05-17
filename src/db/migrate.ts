#!/usr/bin/env tsx
/**
 * Migration runner. Applies any src/db/migrations/*.sql not present in
 * the _migrations table, in lexicographic order. Idempotent.
 *
 * Invoked via `npm run migrate`. Reads --remote/--local from argv;
 * defaults to --local. Database name is read from wrangler.toml.
 *
 * Usage:
 *   npm run migrate              # local (Miniflare)
 *   npm run migrate -- --remote  # production D1
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");
const DB_NAME = "garrul-db";

const remoteFlag = process.argv.includes("--remote") ? "--remote" : "--local";

const wrangler = (args: string[]): string =>
	execFileSync("wrangler", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

const d1Exec = (sql: string): string =>
	wrangler(["d1", "execute", DB_NAME, remoteFlag, "--json", "--command", sql]);

const d1File = (file: string): string =>
	wrangler(["d1", "execute", DB_NAME, remoteFlag, "--json", "--file", file]);

const ensureMigrationsTable = () => {
	d1Exec(
		"CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)",
	);
};

const appliedSet = (): Set<string> => {
	const out = d1Exec("SELECT name FROM _migrations");
	try {
		const parsed = JSON.parse(out);
		const rows: { name: string }[] = parsed[0]?.results ?? [];
		return new Set(rows.map((r) => r.name));
	} catch {
		return new Set();
	}
};

const recordApplied = (name: string) => {
	// name is a filename we read from our own migrations dir; still parameterize
	// to keep this future-proof if anyone ever passes user input.
	d1Exec(
		`INSERT INTO _migrations (name, applied_at) VALUES ('${name.replace(/'/g, "''")}', ${Date.now()})`,
	);
};

const main = () => {
	console.log(`[migrate] target: ${remoteFlag}`);
	ensureMigrationsTable();
	const applied = appliedSet();
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && /^[a-zA-Z0-9_-]+\.sql$/.test(f))
		.sort();
	let count = 0;
	for (const file of files) {
		if (applied.has(file)) {
			console.log(`[migrate] skip ${file} (already applied)`);
			continue;
		}
		console.log(`[migrate] apply ${file}`);
		d1File(join(MIGRATIONS_DIR, file));
		recordApplied(file);
		count++;
	}
	console.log(
		`[migrate] done (${count} applied, ${files.length - count} skipped)`,
	);
};

try {
	main();
} catch (err) {
	console.error("[migrate] failed:", err);
	process.exit(1);
}
