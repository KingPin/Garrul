/**
 * scripts/node-cli.ts: the shell-free launchers the operator scripts use so
 * `npm run migrate` / `npm run upgrade` work on Windows, where wrangler and
 * npm are only .cmd shims that Node will not spawn without a shell.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { npmCommand, wranglerCommand, wranglerEntry } from "../scripts/node-cli";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("wranglerCommand", () => {
	it("runs the installed wrangler's JS entry with this Node, args untouched", () => {
		const sql = `SELECT 'a b' AS "x"; -- & | ^ %PATH%`;
		const [cmd, args] = wranglerCommand(["d1", "execute", "DB", "--command", sql]);
		expect(cmd).toBe(process.execPath);
		expect(args[0]).toBe(wranglerEntry());
		expect(args.slice(1)).toEqual(["d1", "execute", "DB", "--command", sql]);
	});

	it("resolves to a file that exists", () => {
		expect(basename(wranglerEntry())).toBe("wrangler.js");
		expect(existsSync(wranglerEntry())).toBe(true);
	});
});

describe("npmCommand", () => {
	it("reuses npm's own CLI under `npm run`", () => {
		vi.stubEnv("npm_execpath", "/opt/npm/bin/npm-cli.js");
		expect(npmCommand(["ci"])).toEqual([process.execPath, ["/opt/npm/bin/npm-cli.js", "ci"]]);
	});

	it("falls back to npm on PATH outside npm or under another package manager", () => {
		vi.stubEnv("npm_execpath", "");
		expect(npmCommand(["ci"])).toEqual(["npm", ["ci"]]);
		vi.stubEnv("npm_execpath", "/opt/pnpm/bin/pnpm.cjs");
		expect(npmCommand(["run", "migrate"])).toEqual(["npm", ["run", "migrate"]]);
	});
});
