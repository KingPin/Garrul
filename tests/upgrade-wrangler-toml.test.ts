/**
 * parseWranglerToml — the hand-rolled wrangler.toml reader used by
 * `npm run upgrade` to see what the operator has configured. No TOML
 * dependency: the script has to run before `node_modules` may have been
 * refreshed, so the parse is regex/line based and needs pinning down.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWranglerToml } from "../scripts/upgrade/wrangler";

const dirs: string[] = [];

const withToml = (contents: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "garrul-toml-"));
	dirs.push(dir);
	writeFileSync(join(dir, "wrangler.toml"), contents);
	return dir;
};

afterEach(() => {
	while (dirs.length > 0) {
		rmSync(dirs.pop() as string, { recursive: true, force: true });
	}
});

describe("parseWranglerToml varNames", () => {
	it("reads keys from the [vars] table", () => {
		const dir = withToml(
			[
				'name = "garrul"',
				"",
				"[vars]",
				'ENV = "production"',
				'ALLOWED_ORIGINS = "https://example.com"',
				"COMMENTS_PER_PAGE = 25",
				"",
				"[[kv_namespaces]]",
				'binding = "SESSIONS"',
				'id = "abc"',
			].join("\n"),
		);
		expect(parseWranglerToml(dir).varNames).toEqual([
			"ENV",
			"ALLOWED_ORIGINS",
			"COMMENTS_PER_PAGE",
		]);
	});

	it("reads a [vars] table that runs to end of file", () => {
		// Regression: an earlier implementation ended the block with a `\Z`
		// lookahead. JS has no `\Z` anchor — it matches a literal "Z", so a
		// trailing [vars] section was truncated at the first capital Z in a
		// value. VOTING_ENABLED here sits after one.
		const dir = withToml(
			[
				"[[kv_namespaces]]",
				'binding = "SESSIONS"',
				"",
				"[vars]",
				'PUBLIC_BASE_URL = "https://ZURICH.example.com"',
				'VOTING_ENABLED = "true"',
			].join("\n"),
		);
		expect(parseWranglerToml(dir).varNames).toEqual([
			"PUBLIC_BASE_URL",
			"VOTING_ENABLED",
		]);
	});

	it("ignores commented-out keys — those are not set", () => {
		const dir = withToml(
			['[vars]', 'ENV = "production"', '# AUTO_CLOSE_DAYS = 30'].join("\n"),
		);
		expect(parseWranglerToml(dir).varNames).toEqual(["ENV"]);
	});

	it("does not pick up keys from other sections", () => {
		const dir = withToml(
			[
				"[vars]",
				'ENV = "production"',
				"",
				"[observability]",
				"enabled = true",
				"",
				"[[d1_databases]]",
				'binding = "DB"',
				'database_name = "garrul-db"',
			].join("\n"),
		);
		const toml = parseWranglerToml(dir);
		expect(toml.varNames).toEqual(["ENV"]);
		expect(toml.d1Bindings).toEqual(["DB"]);
	});

	it("returns an empty list when there is no [vars] table", () => {
		const dir = withToml('name = "garrul"\n\n[[kv_namespaces]]\nbinding = "X"');
		expect(parseWranglerToml(dir).varNames).toEqual([]);
	});

	it("throws when wrangler.toml is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "garrul-toml-"));
		dirs.push(dir);
		expect(() => parseWranglerToml(dir)).toThrow(/not found/);
	});
});
