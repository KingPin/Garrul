import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSecretsEnv,
	buildDevVars,
	buildSecretsRequired,
	buildSecretsPointer,
	buildConfigTable,
	checkVarCoverage,
} from "../scripts/build-config";
import {
	SECRETS,
	VARS,
	REQUIRED_SECRET_NAMES,
	GENERATED_SECRET_NAMES,
} from "../scripts/config-registry";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("secrets.example.env safety", () => {
	// The reason the template is dotenv rather than JSON. `wrangler secret
	// bulk` accepts an empty string as a real value, so an uncommented
	// `TURNSTILE_SECRET=` would overwrite a live secret with "". With every
	// line commented, an unedited copy parses to {} and wrangler refuses the
	// file outright — verified against wrangler 4.115.0.
	it("emits no uncommented assignment", () => {
		const offenders = buildSecretsEnv()
			.split("\n")
			.filter((line) => /^[^#]*=/.test(line));
		expect(offenders).toEqual([]);
	});

	it("keeps the committed template in that state", () => {
		const offenders = read("secrets.example.env")
			.split("\n")
			.filter((line) => /^[^#]*=/.test(line));
		expect(offenders).toEqual([]);
	});

	// setup.sh pipes `openssl rand` straight into `wrangler secret put` for
	// these, so they never touch disk. Listing them would invite an operator
	// to undo that.
	it("omits the secrets setup.sh generates in-stream", () => {
		const env = buildSecretsEnv();
		for (const name of GENERATED_SECRET_NAMES) {
			expect(env).not.toMatch(new RegExp(`^#\\s*${name}=`, "m"));
		}
		expect(GENERATED_SECRET_NAMES.length).toBeGreaterThan(0);
	});

	it("lists every other secret exactly once", () => {
		const env = buildSecretsEnv();
		for (const e of SECRETS) {
			if (e.generate) continue;
			const hits = env.match(new RegExp(`^# ${e.name}=$`, "gm")) ?? [];
			expect(hits, e.name).toHaveLength(1);
		}
	});

	it("never lists a var", () => {
		const env = buildSecretsEnv();
		for (const e of VARS) {
			expect(env, e.name).not.toMatch(new RegExp(`\\b${e.name}=`));
		}
	});
});

describe(".dev.vars.example", () => {
	// Inverse of the rule above: `.dev.vars` is read wholesale by
	// `wrangler dev`, so blanking a local placeholder costs nothing and
	// uncommented lines save the operator a step.
	it("assigns every secret, including the generated pair", () => {
		const devVars = buildDevVars();
		for (const e of SECRETS) {
			expect(devVars, e.name).toMatch(new RegExp(`^${e.name}="`, "m"));
		}
	});

	it("never assigns a var", () => {
		const devVars = buildDevVars();
		for (const e of VARS) {
			expect(devVars, e.name).not.toMatch(new RegExp(`^${e.name}=`, "m"));
		}
	});
});

describe("wrangler.example.toml regions", () => {
	it("declares only the always-required secrets", () => {
		const block = buildSecretsRequired();
		expect(block).toContain("[secrets]");
		const list = /required = \[(.*)\]/.exec(block)?.[1] ?? "";
		const names = list.split(", ").map((s) => s.replaceAll('"', ""));
		expect(names).toEqual(REQUIRED_SECRET_NAMES);
		// Optional per-provider credentials would warn on every install that
		// deliberately doesn't use them.
		expect(names).not.toContain("GH_CLIENT_ID");
	});

	it("points at both the bulk and one-at-a-time paths", () => {
		const pointer = buildSecretsPointer();
		expect(pointer).toContain("wrangler secret bulk secrets.env");
		expect(pointer).toContain("wrangler secret put <NAME>");
	});

	it("is the state the committed file is in", () => {
		const toml = read("wrangler.example.toml");
		expect(toml).toContain(buildSecretsRequired());
		expect(toml).toContain(buildSecretsPointer());
	});
});

describe("AGENTS-OPERATE §5 table", () => {
	it("has one row per registry entry", () => {
		const table = buildConfigTable();
		for (const e of [...SECRETS, ...VARS]) {
			expect(table, e.name).toContain(`| \`${e.name}\` | ${e.kind} |`);
		}
	});

	it("is the state the committed file is in", () => {
		expect(read("AGENTS-OPERATE.md")).toContain(buildConfigTable());
	});
});

describe("wrangler.example.toml [vars] coverage", () => {
	// That block stays hand-written — it carries multi-paragraph operator
	// prose a one-line hint can't reproduce — so coverage is all we enforce.
	it("mentions every registry var", () => {
		expect(checkVarCoverage(read("wrangler.example.toml"))).toEqual([]);
	});

	it("flags a var the template forgot", () => {
		const problems = checkVarCoverage("[vars]\nENV = \"production\"\n");
		expect(problems.length).toBe(VARS.length - 1);
		expect(problems.join("\n")).toContain("VOTING_ENABLED");
		expect(problems.join("\n")).not.toContain("ENV never mentions");
	});

	it("accepts a commented-out var", () => {
		const lines = VARS.map((e) => `# ${e.name} = "x"`).join("\n");
		expect(checkVarCoverage(`[vars]\n${lines}\n`)).toEqual([]);
	});
});
