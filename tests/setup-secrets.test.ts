/**
 * put_random_secret in scripts/setup.sh must never overwrite a secret that is
 * already set, and must stop when it cannot tell. Same harness as
 * setup-bindings.test.ts: functions are cut out by name and run in bash with
 * `wrangler` and `openssl` replaced by logging shell functions.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const EXTRACT = ["secret_exists", "put_random_secret", "put_secret"]
	.map((f) => `/^${f}() {/,/^}/p`)
	.join(";");

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-secrets-"));
});

/** `list` is what `wrangler secret list` does: stdout JSON, or a failure with stderr text. */
const run = (list: { json?: string; fail?: string }) => {
	const listCmd = list.fail
		? `echo '${list.fail}'; return 1`
		: `echo '${list.json ?? "[]"}'`;
	const stub = `wrangler() {
	echo "wrangler $*" >> calls.log
	case "$1 $2" in
		"secret list") ${listCmd} ;;
		"secret put") cat >/dev/null ;;
	esac
}
openssl() { echo generated; }`;
	return spawnSync(
		"bash",
		[
			"-c",
			`set -euo pipefail\neval "$(sed -n '${EXTRACT}' "$SETUP")"\n${stub}\nput_random_secret JWT_SECRET hint`,
		],
		{ cwd: dir, encoding: "utf8", input: "y\n", env: { ...process.env, SETUP } },
	);
};
const puts = () => {
	try {
		return readFileSync(join(dir, "calls.log"), "utf8")
			.split("\n")
			.filter((l) => l.startsWith("wrangler secret put"));
	} catch {
		return [];
	}
};

describe("put_random_secret", () => {
	it("keeps a secret that is already set", () => {
		const r = run({ json: '[{"name":"JWT_SECRET","type":"secret_text"}]' });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already set");
		expect(puts()).toEqual([]);
	});

	it("generates a secret that is missing", () => {
		const r = run({ json: '[{"name":"OTHER","type":"secret_text"}]' });
		expect(r.status).toBe(0);
		expect(puts()).toEqual(["wrangler secret put JWT_SECRET"]);
	});

	it("treats a Worker that is not deployed yet as having no secrets", () => {
		const r = run({ fail: '✘ [ERROR] Worker "garrul" not found.' });
		expect(r.status).toBe(0);
		expect(puts()).toEqual(["wrangler secret put JWT_SECRET"]);
	});

	it("stops, without writing, when the lookup fails", () => {
		const r = run({ fail: "fetch failed: network unreachable" });
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("could not check");
		expect(puts()).toEqual([]);
	});

	it("stops, without writing, when the list does not parse", () => {
		const r = run({ json: "not json" });
		expect(r.status).not.toBe(0);
		expect(puts()).toEqual([]);
	});
});
