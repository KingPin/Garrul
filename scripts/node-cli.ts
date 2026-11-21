/**
 * Shell-free launchers for the Node CLIs the operator scripts drive.
 *
 * On Windows, `wrangler`, `npx` and `npm` exist only as `.cmd` shims, and
 * Node refuses to spawn a `.cmd` without `shell: true` (ENOENT for a bare
 * name, EINVAL since the CVE-2024-27980 fix for an explicit path). A shell
 * is not an option: these scripts pass SQL as an argument, and cmd.exe's
 * quoting rules would turn that into an injection surface. So each CLI is
 * run as `node <its JS entry point>` instead — identical on every OS, no
 * PATH lookup, and always the wrangler version pinned in package-lock.json.
 *
 * Node-only. Never import this from the Worker bundle.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** A spawnable command: pass straight to execFileSync / spawnSync / spawn. */
export type Command = [cmd: string, args: string[]];

/** Absolute path of the installed wrangler's JS entry point. */
export const wranglerEntry = (): string => {
	const pkgPath = require.resolve("wrangler/package.json");
	const { bin } = require(pkgPath) as { bin: string | Record<string, string> };
	const rel = typeof bin === "string" ? bin : bin.wrangler;
	if (!rel) throw new Error("installed wrangler package declares no `wrangler` bin");
	return join(dirname(pkgPath), rel);
};

/** `wrangler <args>` without a shell. */
export const wranglerCommand = (args: string[]): Command => [process.execPath, [wranglerEntry(), ...args]];

/**
 * `npm <args>` without a shell. Under `npm run …`, npm exports its own
 * `npm-cli.js` as `npm_execpath`; run that with this Node. Anything else
 * (launched directly, or by another package manager whose execpath would
 * not understand `npm ci`) falls back to `npm` on PATH, which works
 * everywhere except Windows.
 */
export const npmCommand = (args: string[]): Command => {
	const cli = process.env.npm_execpath;
	if (cli && /npm-cli\.c?js$/.test(cli)) return [process.execPath, [cli, ...args]];
	return ["npm", args];
};
