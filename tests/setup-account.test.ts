/**
 * select_account / persist_account_id, cut out of setup.sh by name (see
 * setup-vars.test.ts) and run against a stub `wrangler` on PATH.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const EXTRACT = ["persist_account_id", "select_account"].map((f) => `/^${f}() {/,/^}/p`).join(";");
const WHOAMI = JSON.stringify({
	accounts: [
		{ id: "aaa111", name: "First" },
		{ id: "bbb222", name: "Second" },
	],
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-acct-"));
	writeFileSync(join(dir, "wrangler"), `#!/bin/sh\ncat <<'EOF'\n${WHOAMI}\nEOF\n`);
	chmodSync(join(dir, "wrangler"), 0o755);
});

const toml = () => readFileSync(join(dir, "wrangler.toml"), "utf8");
const run = (input: string, env: Record<string, string> = {}) => {
	const r = spawnSync(
		"bash",
		["-c", `set -euo pipefail\neval "$(sed -n '${EXTRACT}' "$SETUP")"\nselect_account\necho "id=\${CLOUDFLARE_ACCOUNT_ID:-}"`],
		{
			cwd: dir,
			input,
			encoding: "utf8",
			env: { PATH: `${dir}:${process.env.PATH}`, SETUP, HOME: dir, ...env },
		},
	);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout;
};

describe("select_account persistence", () => {
	it("saves the chosen account at the top level, before the first table", () => {
		writeFileSync(join(dir, "wrangler.toml"), 'name = "garrul"\n\n[vars]\nENV = "production"\n');
		expect(run("2\n")).toContain("id=bbb222");
		expect(toml()).toBe('name = "garrul"\n\naccount_id = "bbb222"\n\n[vars]\nENV = "production"\n');
	});

	it("keeps an account_id that is already configured", () => {
		const t = 'name = "garrul"\naccount_id = "zzz999"\n[vars]\n';
		writeFileSync(join(dir, "wrangler.toml"), t);
		expect(run("")).toContain("id=\n");
		expect(toml()).toBe(t);
	});

	it("does not touch the file when the caller pinned the account in the environment", () => {
		const t = 'name = "garrul"\n[vars]\n';
		writeFileSync(join(dir, "wrangler.toml"), t);
		run("", { CLOUDFLARE_ACCOUNT_ID: "envacct" });
		expect(toml()).toBe(t);
	});
});
