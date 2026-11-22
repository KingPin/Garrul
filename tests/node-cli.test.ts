/**
 * scripts/node-cli.ts: the shell-free launchers the operator scripts use so
 * `npm run migrate` / `npm run upgrade` work on Windows, where wrangler and
 * npm are only .cmd shims that Node will not spawn without a shell.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

describe("wranglerEntry", () => {
	it("re-reads package.json on every call, so an in-process npm ci is seen", () => {
		const dir = mkdtempSync(join(tmpdir(), "garrul-wrangler-"));
		try {
			const pkg = join(dir, "package.json");
			writeFileSync(pkg, JSON.stringify({ bin: { wrangler: "bin/old.js" } }));
			expect(wranglerEntry(pkg)).toBe(join(dir, "bin/old.js"));
			writeFileSync(pkg, JSON.stringify({ bin: { wrangler: "bin/new.js" } }));
			expect(wranglerEntry(pkg)).toBe(join(dir, "bin/new.js"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("npmCommand", () => {
	it("reuses npm's own CLI under `npm run`", () => {
		vi.stubEnv("npm_execpath", "/opt/npm/bin/npm-cli.js");
		expect(npmCommand(["ci"])).toEqual([process.execPath, ["/opt/npm/bin/npm-cli.js", "ci"]]);
	});

	const sibling = join("/opt/npm/bin", "npm-cli.js");
	const beside = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	const has = (...files: string[]) => ({ exists: (p: string) => files.includes(p) });

	it("falls back to bare npm on non-Windows without a usable execpath", () => {
		vi.stubEnv("npm_execpath", "");
		expect(npmCommand(["ci"], { platform: "linux" })).toEqual(["npm", ["ci"]]);
		vi.stubEnv("npm_execpath", "/opt/pnpm/bin/pnpm.cjs");
		expect(npmCommand(["run", "migrate"], { platform: "linux" })).toEqual(["npm", ["run", "migrate"]]);
	});

	it("maps npx-cli.js to its sibling npm-cli.js when that file exists", () => {
		vi.stubEnv("npm_execpath", "/opt/npm/bin/npx-cli.js");
		const want = [process.execPath, [sibling, "ci"]];
		expect(npmCommand(["ci"], { platform: "linux", ...has(sibling) })).toEqual(want);
		expect(npmCommand(["ci"], { platform: "win32", ...has(sibling) })).toEqual(want);
	});

	it("on Windows finds npm beside node.exe", () => {
		vi.stubEnv("npm_execpath", "/opt/pnpm/bin/pnpm.cjs");
		expect(npmCommand(["ci"], { platform: "win32", ...has(beside) })).toEqual([process.execPath, [beside, "ci"]]);
		vi.stubEnv("npm_execpath", "");
		expect(npmCommand(["ci"], { platform: "win32", ...has(beside) })).toEqual([process.execPath, [beside, "ci"]]);
	});

	it("passes a path with spaces as one argv element", () => {
		const spaced = "/opt/my npm/bin/npx-cli.js";
		const sib = join("/opt/my npm/bin", "npm-cli.js");
		vi.stubEnv("npm_execpath", spaced);
		const [, argv] = npmCommand(["ci"], { platform: "win32", ...has(sib) });
		expect(argv).toEqual([sib, "ci"]);
	});

	it("on Windows with no npm found, tells the operator to use npm run upgrade", () => {
		vi.stubEnv("npm_execpath", "");
		expect(() => npmCommand(["ci"], { platform: "win32", exists: () => false })).toThrow(
			"Run this through `npm run upgrade` so npm sets `npm_execpath`.",
		);
	});
});
