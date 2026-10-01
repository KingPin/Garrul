/**
 * setup.sh runs top to bottom, so it can't be sourced. These tests cut the
 * [vars] helpers out by name (every function in the file closes with `}` at
 * column 0) and run them in bash against a fixture wrangler.toml.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const FNS = ["get_var", "set_var", "var_is_placeholder", "var_problem", "prompt_var"];
const EXTRACT = FNS.map((f) => `/^${f}() {/,/^}/p`).join(";");

const EXAMPLE = `[vars]
ALLOWED_ORIGINS = "https://yourblog.example.com"
PUBLIC_BASE_URL = "https://comments.example.com"
OAUTH_CALLBACK_BASE = "https://comments.example.com"
`;

const TOML = `name = "garrul"
[vars]
ENV = "production"
# ALLOWED_ORIGINS = "https://commented.example"
ALLOWED_ORIGINS = "https://yourblog.example.com"
PUBLIC_BASE_URL = 'https://c.blog.test'
OAUTH_CALLBACK_BASE = "https://comments.example.com"
QUOTE_IN_DOUBLE = "it's a test"
QUOTE_IN_SINGLE = 'say "hi"'

[env.staging.vars]
ALLOWED_ORIGINS = "https://staging.example.com"
`;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-setup-"));
	writeFileSync(join(dir, "wrangler.toml"), TOML);
	writeFileSync(join(dir, "wrangler.example.toml"), EXAMPLE);
});

const sh = (body: string, input = "") =>
	spawnSync(
		"bash",
		["-c", `set -euo pipefail\neval "$(sed -n '${EXTRACT}' "$SETUP")"\n${body}`],
		{ cwd: dir, input, encoding: "utf8", env: { ...process.env, SETUP } },
	);
const toml = () => readFileSync(join(dir, "wrangler.toml"), "utf8");

describe("setup.sh [vars] helpers", () => {
	it("extracts every helper", () => {
		const r = sh(FNS.map((f) => `declare -F ${f}`).join("\n"));
		expect(r.status, r.stderr).toBe(0);
	});

	it("reads either quote style from the top-level [vars] only", () => {
		const r = sh(
			"get_var ALLOWED_ORIGINS wrangler.toml; get_var PUBLIC_BASE_URL wrangler.toml; get_var MISSING wrangler.toml",
		);
		expect(r.stdout).toBe("https://yourblog.example.com\nhttps://c.blog.test\n");
	});

	it("doesn't cut a value short at the other quote character it's not wrapped in", () => {
		const r = sh(
			"get_var QUOTE_IN_DOUBLE wrangler.toml; get_var QUOTE_IN_SINGLE wrangler.toml",
		);
		expect(r.stdout).toBe('it\'s a test\nsay "hi"\n');
	});

	it("rewrites one line and leaves the rest byte-identical", () => {
		const r = sh('set_var ALLOWED_ORIGINS "https://blog.test"');
		expect(r.status, r.stderr).toBe(0);
		expect(toml()).toBe(
			TOML.replace(
				'ALLOWED_ORIGINS = "https://yourblog.example.com"',
				'ALLOWED_ORIGINS = "https://blog.test"',
			),
		);
	});

	it("warns and leaves the file alone when the line is missing", () => {
		const r = sh('set_var CANONICAL_URL "https://x.test"');
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no uncommented CANONICAL_URL");
		expect(toml()).toBe(TOML);
	});

	it("keeps a real value on Enter", () => {
		const r = sh('prompt_var PUBLIC_BASE_URL "hint"', "\n");
		expect(r.stdout).toContain("PUBLIC_BASE_URL unchanged");
		expect(toml()).toBe(TOML);
	});

	it("defaults OAUTH_CALLBACK_BASE to PUBLIC_BASE_URL", () => {
		sh('prompt_var OAUTH_CALLBACK_BASE "hint"', "\n");
		expect(toml()).toContain('OAUTH_CALLBACK_BASE = "https://c.blog.test"');
	});

	it("leaves a placeholder on an empty answer and flags it", () => {
		const r = sh('VARS_PENDING=0; prompt_var ALLOWED_ORIGINS "hint"; echo "pending=$VARS_PENDING"', "\n");
		expect(r.stdout).toContain("pending=1");
		expect(toml()).toBe(TOML);
	});

	it("re-asks on a value a TOML basic string can't hold as-is", () => {
		sh('prompt_var ALLOWED_ORIGINS "hint"', 'a"b\nhttps://ok.test\n');
		expect(toml()).toContain('ALLOWED_ORIGINS = "https://ok.test"');
	});
});

describe("var validation", () => {
	// ALLOWED_ORIGINS is an exact-string match against the Origin header, so a
	// bare host was accepted by setup and then never matched anything.
	it("re-asks on an origin without a scheme, then takes a good one", () => {
		const r = sh('prompt_var ALLOWED_ORIGINS "hint"', "test.example.com\nhttps://test.example.com\n");
		expect(r.stdout).toContain('"test.example.com" is not an origin');
		expect(toml()).toContain('ALLOWED_ORIGINS = "https://test.example.com"');
	});

	it.each([
		["https://a.test/", "trailing slash"],
		["https://a.test/blog", "path"],
		["https://a.test, b.test", "second entry bare"],
	])("rejects origin %s (%s)", (val) => {
		const r = sh(`var_problem ALLOWED_ORIGINS "${val}"`);
		expect(r.stdout).toContain("is not an origin");
	});

	it("accepts a comma list with spaces and an http localhost origin", () => {
		const r = sh('var_problem ALLOWED_ORIGINS "https://a.test, http://localhost:4321"');
		expect(r.stdout).toBe("");
	});

	it("rejects a base URL with no scheme", () => {
		expect(sh('var_problem PUBLIC_BASE_URL "comments.example.com"').stdout).toContain("is not a URL");
		expect(sh('var_problem PUBLIC_BASE_URL "https://c.example.com"').stdout).toBe("");
	});

	it("rejects an admin entry that is not an email", () => {
		expect(sh('var_problem ADMIN_EMAILS "a@b.test, nope"').stdout).toContain('"nope" is not an email');
		expect(sh('var_problem ADMIN_EMAILS "a@b.test, c@d.test"').stdout).toBe("");
	});
});

describe("setup.sh end-to-end steps", () => {
	it("runs provision, secrets, hostname, origin, turnstile, then migrate, deploy and verify", () => {
		const s = readFileSync(SETUP, "utf8");
		const main = s.slice(s.indexOf("main_full() {"));
		const at = [
			"\tprovision_resources\n",
			"\tgenerate_secrets\n",
			"\tsetup_hostname\n",
			"\task_origin\n",
			"\tsetup_turnstile\n",
			"\trun_migrate\n",
			"\tdeploy_worker\n",
			"\tverify_health\n",
			"\tfinish\n",
		].map((needle) => main.indexOf(needle));
		for (const i of at) expect(i).toBeGreaterThan(-1);
		expect(at).toEqual([...at].sort((a, b) => a - b));
	});
});
