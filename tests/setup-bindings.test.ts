/**
 * Binding-id handling in scripts/setup.sh. Same harness as setup-vars.test.ts:
 * the functions are cut out by name and run in bash against a fixture
 * wrangler.toml, with `wrangler` replaced by a shell function that logs each
 * call and answers from a fake account.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const SETUP = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "setup.sh");
const FNS = [
	"select_account",
	"set_binding_id",
	"set_kv_id",
	"set_d1_id",
	"remote_id",
	"apply_id",
	"create_d1",
	"create_kv",
];
const EXTRACT = [...FNS.map((f) => `/^${f}() {/,/^}/p`), "/^ANY_VALUE=/p"].join(";");

const STALE_DB = "cfb5d85e-e9ee-461f-babd-109940cb089a";
const ACCOUNT_DB = "6411cfb5-08a3-498b-a583-ca8385a569f1";
const ACCOUNT_KV = "08aa8c9e40ec4a7e87e89e21fc04c57f";

const toml = (db: string, kv: string) => `name = "garrul"

[[kv_namespaces]]
binding = "SESSIONS"
id = "SESSIONSID"

[[kv_namespaces]]
binding = "RATE_LIMITS"
id = "${kv}"

[[d1_databases]]
binding = "DB"
database_name = "garrul-db"
database_id = "${db}"
`;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "garrul-bindings-"));
});

/** `listed` is the fake account's contents; `created` what a create returns. */
const run = (
	body: string,
	opts: { d1?: string; kv?: string; accounts?: string; input?: string } = {},
) => {
	const d1List = opts.d1
		? `[{"uuid":"${opts.d1}","name":"garrul-db"}]`
		: "[]";
	const kvList = opts.kv
		? `[{"id":"${opts.kv}","title":"RATE_LIMITS"}]`
		: "[]";
	const stub = `wrangler() {
	echo "wrangler $*" >> calls.log
	case "$1 $2" in
		"whoami --json") echo '✔ banner' ; echo '{"loggedIn":true,"accounts":${opts.accounts ?? "[]"}}' ;;
		"d1 list") echo '${d1List}' ;;
		"kv namespace") [ "$3" = list ] && echo '${kvList}' || printf 'id = "${ACCOUNT_KV}"\\n' ;;
		"d1 create") printf 'database_id = "${ACCOUNT_DB}"\\n' ;;
	esac
}`;
	return spawnSync(
		"bash",
		["-c", `set -euo pipefail\neval "$(sed -n '${EXTRACT}' "$SETUP")"\n${stub}\n${body}`],
		{
			cwd: dir,
			encoding: "utf8",
			input: opts.input ?? "",
			env: { ...process.env, SETUP, CLOUDFLARE_ACCOUNT_ID: "" },
		},
	);
};
const read = (f: string) => {
	try {
		return readFileSync(join(dir, f), "utf8");
	} catch {
		return "";
	}
};

describe("create_d1", () => {
	// The bug: a wrangler.toml copied from another account kept its ids, setup
	// created a fresh database and threw the new id away, and migrate failed
	// with 7404 against the stale one.
	it("replaces a stale id with the one the account actually has", () => {
		writeFileSync(join(dir, "wrangler.toml"), toml(STALE_DB, ACCOUNT_KV));
		const r = run("create_d1 DB garrul-db", { d1: ACCOUNT_DB });
		expect(r.status, r.stderr).toBe(0);
		expect(read("wrangler.toml")).toContain(`database_id = "${ACCOUNT_DB}"`);
		expect(read("wrangler.toml")).not.toContain(STALE_DB);
		expect(read("calls.log")).not.toContain("d1 create");
	});

	it("creates the database when the account has none, and records its id", () => {
		writeFileSync(join(dir, "wrangler.toml"), toml(STALE_DB, ACCOUNT_KV));
		const r = run("create_d1 DB garrul-db");
		expect(r.status, r.stderr).toBe(0);
		expect(read("calls.log")).toContain("d1 create garrul-db");
		expect(read("wrangler.toml")).toContain(`database_id = "${ACCOUNT_DB}"`);
	});

	it("leaves a correct id alone and creates nothing", () => {
		writeFileSync(join(dir, "wrangler.toml"), toml(ACCOUNT_DB, ACCOUNT_KV));
		const before = read("wrangler.toml");
		const r = run("create_d1 DB garrul-db", { d1: ACCOUNT_DB });
		expect(r.status, r.stderr).toBe(0);
		expect(read("wrangler.toml")).toBe(before);
		expect(read("calls.log")).not.toContain("d1 create");
	});
});

describe("create_kv", () => {
	it("rewrites only the block that binds the name", () => {
		writeFileSync(join(dir, "wrangler.toml"), toml(ACCOUNT_DB, "stale0000"));
		const r = run("create_kv RATE_LIMITS", { kv: ACCOUNT_KV });
		expect(r.status, r.stderr).toBe(0);
		const out = read("wrangler.toml");
		expect(out).toContain(`id = "${ACCOUNT_KV}"`);
		expect(out).not.toContain("stale0000");
		expect(out).toContain('id = "SESSIONSID"');
		expect(read("calls.log")).not.toContain("namespace create");
	});

	it("creates the namespace when the account has none", () => {
		writeFileSync(join(dir, "wrangler.toml"), toml(ACCOUNT_DB, "stale0000"));
		const r = run("create_kv RATE_LIMITS");
		expect(r.status, r.stderr).toBe(0);
		expect(read("calls.log")).toContain("kv namespace create RATE_LIMITS");
		expect(read("wrangler.toml")).toContain(`id = "${ACCOUNT_KV}"`);
	});
});

describe("select_account", () => {
	const TWO = '[{"id":"aaa","name":"Personal"},{"id":"bbb","name":"Work"}]';
	const ONE = '[{"id":"aaa","name":"Personal"}]';
	const show = 'select_account; echo "acct=${CLOUDFLARE_ACCOUNT_ID:-}"';

	beforeEach(() => writeFileSync(join(dir, "wrangler.toml"), 'name = "garrul"\n'));

	it("exports the only account without asking", () => {
		const r = run(show, { accounts: ONE });
		expect(r.stdout).toContain("acct=aaa");
		expect(r.stdout).not.toContain("Choose");
	});

	it("asks once when the login has several, and re-asks on junk", () => {
		const r = run(show, { accounts: TWO, input: "x\n9\n2\n" });
		expect(r.stdout).toContain("1) Personal");
		expect(r.stdout).toContain("acct=bbb");
	});

	it("does nothing when an account is already pinned", () => {
		writeFileSync(join(dir, "wrangler.toml"), 'account_id = "pinned"\n');
		const r = run(show, { accounts: TWO });
		expect(r.stdout).toContain("acct=\n");
		expect(read("calls.log")).toBe("");
	});

	it("carries on, with a warning, when whoami fails", () => {
		const r = run(`wrangler() { return 1; }\n${show}`);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toContain("could not read your Cloudflare login");
	});
});
