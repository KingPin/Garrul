/**
 * finish / verify_health, cut out of setup.sh by name (see setup-vars.test.ts)
 * and run with stub `npm`, `curl` and `sleep` on PATH.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const FNS = ["get_var", "var_is_placeholder", "verify_health", "finish"];
const EXTRACT = FNS.map((f) => `/^${f}() {/,/^}/p`).join(";");

let dir: string;
const stub = (name: string, body: string) => {
	writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(dir, name), 0o755);
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-finish-"));
	writeFileSync(join(dir, "package.json"), '{"scripts":{"owner-link":"x"}}');
	writeFileSync(join(dir, "wrangler.toml"), '[vars]\nPUBLIC_BASE_URL = "https://c.blog.test"\n');
	stub("sleep", "exit 0");
});

const run = (body: string, path = `${dir}:${process.env.PATH}`) =>
	spawnSync(
		"bash",
		["-c", `set -euo pipefail\nPENDING=0\nFAILED=0\nWORKER_HOST=c.blog.test\neval "$(sed -n '${EXTRACT}' "$SETUP")"\n${body}`],
		{ cwd: dir, encoding: "utf8", env: { PATH: path, SETUP, HOME: dir } },
	);

describe("setup completion status", () => {
	it("reports live and exits 0 when health and the owner link both succeed", () => {
		stub("curl", "echo ok");
		stub("npm", "echo https://c.blog.test/admin/owner#t=abc");
		const r = run("verify_health >/dev/null\nfinish");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("=== Garrul is live ===");
		expect(r.stdout).toContain("admin/owner#t=abc");
	});

	it("reports incomplete and exits 1 when the health check fails", () => {
		stub("curl", "exit 22");
		stub("npm", "echo https://c.blog.test/admin/owner#t=abc");
		const r = run("verify_health 2>/dev/null\nfinish");
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("=== Setup incomplete ===");
		expect(r.stdout).not.toContain("Garrul is live ===");
	});

	it("reports incomplete, keeps the owner-link error and exits 1 when owner-link fails", () => {
		stub("curl", "echo ok");
		stub("npm", "echo 'owner-link: wrangler d1 execute failed (1): no account' >&2; exit 1");
		const r = run("verify_health >/dev/null\nfinish");
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("=== Setup incomplete ===");
		expect(r.stdout).not.toContain("=== Garrul is live ===");
		expect(r.stderr).toContain("wrangler d1 execute failed (1): no account");
	});

	it("treats a missing curl as a warning, not a failure", () => {
		stub("npm", "echo https://c.blog.test/admin/owner#t=abc");
		// A PATH with the stubs and bash tools but no curl.
		const bin = join(dir, "bin");
		spawnSync("sh", ["-c", `mkdir -p ${bin}; for t in sed grep awk cat rm mktemp bash; do ln -sf "$(command -v $t)" ${bin}/$t; done`]);
		const r = run("verify_health\nfinish", `${dir}:${bin}`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("deployed; health not checked");
		expect(r.stdout).toContain("=== Garrul is live ===");
	});
});
