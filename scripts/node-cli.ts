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
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** A spawnable command: pass straight to execFileSync / spawnSync / spawn. */
export type Command = [cmd: string, args: string[]];

/** Absolute path of the installed wrangler's JS entry point. */
export const wranglerEntry = (pkgPath: string = require.resolve("wrangler/package.json")): string => {
	// readFileSync, not require(): require caches, so an in-process `npm ci` would not be seen.
	const { bin } = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
	const rel = typeof bin === "string" ? bin : bin.wrangler;
	if (!rel) throw new Error("installed wrangler package declares no `wrangler` bin");
	return join(dirname(pkgPath), rel);
};

/** `wrangler <args>` without a shell. */
export const wranglerCommand = (args: string[]): Command => [process.execPath, [wranglerEntry(), ...args]];

/**
 * `npm <args>` without a shell. Under `npm run …`, npm exports its own
 * `npm-cli.js` as `npm_execpath`; run that with this Node. Under `npx` the
 * execpath is `npx-cli.js`, and `npm-cli.js` sits next to it. On Windows,
 * direct launches work only with npm beside `node.exe`; all other layouts go
 * through `npm run`. Elsewhere a bare `npm` on PATH works.
 *
 * `host` exists so tests can run any platform on Linux.
 */
export const npmCommand = (
	args: string[],
	host: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): Command => {
	const platform = host.platform ?? process.platform;
	const exists = host.exists ?? existsSync;
	const cli = process.env.npm_execpath;
	if (cli && /npm-cli\.c?js$/.test(cli)) return [process.execPath, [cli, ...args]];
	if (cli && /npx-cli\.js$/.test(cli)) {
		const sibling = join(dirname(cli), "npm-cli.js");
		if (exists(sibling)) return [process.execPath, [sibling, ...args]];
	}
	if (platform !== "win32") return ["npm", args];
	const beside = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (exists(beside)) return [process.execPath, [beside, ...args]];
	throw new Error("Run this through `npm run upgrade` so npm sets `npm_execpath`.");
};
