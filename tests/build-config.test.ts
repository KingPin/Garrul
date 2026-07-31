import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSecretsEnv,
	buildDevVars,
	buildSecretsRequired,
	buildSecretsPointer,
	buildSetupPrompts,
	buildSetupGenerated,
	buildSetupNextSteps,
	buildConfigTable,
	checkVarCoverage,
	checkMustEditVars,
} from "../scripts/build-config";
import {
	SECRETS,
	VARS,
	MUST_EDIT_VARS,
	REQUIRED_SECRET_NAMES,
	GENERATED_SECRET_NAMES,
	type ConfigEntry,
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

	// `hint` answers "where do I get the real credential", which is the wrong
	// instruction for an entry whose devPlaceholder is a purpose-built test
	// value. Turnstile is the case that motivated devHint: the file ships
	// Cloudflare's "always passes" keys, so pointing local dev at the dashboard
	// invites someone to paste production keys over them.
	it("prefers devHint over hint where one is set", () => {
		const devVars = buildDevVars();
		for (const e of SECRETS) {
			if (!e.devHint) continue;
			for (const line of e.devHint.split("\n")) {
				expect(devVars, e.name).toContain(`# ${line}`);
			}
			expect(devVars, e.name).not.toContain(`# ${e.hint}\n${e.name}=`);
		}
	});

	it("keeps the Turnstile testing-key guidance", () => {
		const devVars = buildDevVars();
		expect(devVars).toContain(
			"https://developers.cloudflare.com/turnstile/troubleshooting/testing/",
		);
		expect(devVars).not.toMatch(
			/dash\.cloudflare\.com.*\nTURNSTILE_SITE_KEY=/,
		);
	});
});

describe("wrangler.example.toml regions", () => {
	it("names only the always-required secrets", () => {
		const block = buildSecretsRequired();
		const list = /required = \[(.*)\]/.exec(block)?.[1] ?? "";
		const names = list.split(", ").map((s) => s.replaceAll('"', ""));
		expect(names).toEqual(REQUIRED_SECRET_NAMES);
		// Listing the optional per-provider credentials would hard-fail the
		// deploy of every install that deliberately doesn't set them.
		expect(names).not.toContain("GH_CLIENT_ID");
	});

	// The block must ship inert. Declaring a `[secrets]` table makes
	// `wrangler dev` bind only `required` + [vars] out of .dev.vars and drop
	// the rest with no warning (getVarsForDev, wrangler 4.115.0), which would
	// cost local dev all 19 optional secrets. Uncommenting is an opt-in for
	// deploy-only configs, so nothing generated may leave TOML at column 0.
	it("emits the table commented out", () => {
		const active = buildSecretsRequired()
			.split("\n")
			.filter((line) => !line.startsWith("#"));
		expect(active).toEqual([]);
	});

	it("keeps the committed template in that state", () => {
		const toml = read("wrangler.example.toml");
		expect(toml).not.toMatch(/^\[secrets\]$/m);
		expect(toml).not.toMatch(/^required = \[/m);
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

describe("setup.sh prompt lists", () => {
	// The gap that motivated generating these: setup.sh hand-listed 16 of the
	// 23 secrets, so CF_API_TOKEN, SPAM_FORM_TS_SECRET, AKISMET_*, TELEGRAM_*
	// and GITHUB_TOKEN were never prompted for on a fresh install.
	it("covers every secret across both regions", () => {
		const both = `${buildSetupGenerated()}\n${buildSetupPrompts()}`;
		for (const e of SECRETS) {
			expect(both, e.name).toMatch(new RegExp(`\\b${e.name}\\b`));
		}
	});

	it("streams the generated secrets and prompts for nothing else", () => {
		const generated = buildSetupGenerated();
		expect(
			generated.match(/^put_random_secret /gm) ?? [],
		).toHaveLength(GENERATED_SECRET_NAMES.length);
		expect(generated).not.toMatch(/put_secret\b/);
	});

	it("never asks for a generated secret in the interactive branch", () => {
		const prompts = buildSetupPrompts();
		for (const name of GENERATED_SECRET_NAMES) {
			expect(prompts, name).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
	});

	it("collapses a declared pair into a single prompt", () => {
		const prompts = buildSetupPrompts();
		expect(prompts).toContain('put_secret_pair "GitHub OAuth" ');
		expect(prompts).toMatch(/GH_CLIENT_ID GH_CLIENT_SECRET$/m);
		expect(prompts).toMatch(/^\tput_secret AKISMET_API_KEY /m);
	});

	// Group size used to stand in for `pairWith`, which got Telegram wrong:
	// the two are independently useful (bot token alone enables outbound
	// notifications; the webhook secret is only for inbound commands), so
	// answering yes forced both `wrangler secret put` prompts with no way to
	// skip one, and only the first hint was ever shown.
	it("does not pair a two-entry group that declares no pairing", () => {
		const prompts = buildSetupPrompts();
		expect(prompts).not.toContain('put_secret_pair "Telegram operator bot"');
		expect(prompts).toMatch(/^\tput_secret TELEGRAM_BOT_TOKEN /m);
		expect(prompts).toMatch(/^\tput_secret TELEGRAM_WEBHOOK_SECRET /m);
	});

	it("shows each unpaired secret its own hint", () => {
		const prompts = buildSetupPrompts();
		for (const e of SECRETS) {
			if (e.generate || e.pairWith) continue;
			const paired = SECRETS.some((p) => p.pairWith === e.name);
			if (paired) continue;
			expect(prompts, e.name).toContain(`put_secret ${e.name} `);
		}
	});

	it("rejects a pairWith that names no secret in the group", () => {
		// A typo here would silently drop the partner's prompt, so it has to be
		// a build-time failure rather than a quietly shorter setup.sh.
		const broken: ConfigEntry[] = [
			{
				name: "A_ID",
				kind: "secret",
				required: false,
				group: "Example",
				hint: "h",
				description: "d",
				pairWith: "A_SECRET_TYPO",
				addedIn: "1.0.0",
			},
			{
				name: "A_SECRET",
				kind: "secret",
				required: false,
				group: "Example",
				hint: "h",
				description: "d",
				addedIn: "1.0.0",
			},
		];
		expect(() => buildSetupPrompts("\t", broken)).toThrow(
			/not a secret in group/,
		);
	});

	it("escapes quotes in hints so the script still parses", () => {
		// AKISMET_API_KEY's hint contains a literal `"akismet"`.
		expect(buildSetupPrompts()).toContain('\\"akismet\\"');
	});

	it("is the state the committed script is in", () => {
		const setup = read("scripts/setup.sh");
		expect(setup).toContain(buildSetupPrompts());
		expect(setup).toContain(buildSetupGenerated());
	});
});

describe("setup.sh next-steps block", () => {
	// This list was hardcoded ("ALLOWED_ORIGINS, ADMIN_EMAILS, route pattern")
	// with no flag to generate it from, so a newly added placeholder var would
	// go unmentioned with config:check green — the drift #42 set out to close.
	it("names every mustEdit var with its hint, in registry order", () => {
		const steps = buildSetupNextSteps();
		const width = Math.max(...MUST_EDIT_VARS.map((e) => e.name.length));
		const order = MUST_EDIT_VARS.map((e) =>
			steps.indexOf(`${e.name.padEnd(width)} — ${e.hint}`),
		);
		for (const [i, at] of order.entries()) {
			expect(at, MUST_EDIT_VARS[i]?.name).toBeGreaterThan(-1);
		}
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("mentions no var that isn't flagged mustEdit", () => {
		const steps = buildSetupNextSteps();
		for (const e of VARS) {
			if (e.mustEdit) continue;
			expect(steps, e.name).not.toMatch(new RegExp(`\\b${e.name}\\b`));
		}
	});

	// The region sits at column 0 in a `set -euo pipefail` script, so anything
	// other than a comment or an echo is executed on every install.
	it("emits nothing executable but echo", () => {
		const offenders = buildSetupNextSteps()
			.split("\n")
			.filter((line) => !/^(#|echo ")/.test(line));
		expect(offenders).toEqual([]);
	});

	it("is the state the committed script is in", () => {
		expect(read("scripts/setup.sh")).toContain(buildSetupNextSteps());
	});

	it("keeps the step numbering contiguous", () => {
		const setup = read("scripts/setup.sh");
		for (const n of [1, 2, 3, 4]) {
			expect(setup, `step ${n}`).toMatch(new RegExp(`^echo "${n}\\. `, "m"));
		}
	});

	// A `mustEdit` var that ships commented out leaves the operator's copied
	// wrangler.toml without the setting at all — no ALLOWED_ORIGINS means every
	// embed and every state-changing POST is rejected, with nothing in the file
	// to suggest why.
	it("requires an uncommented assignment in the template", () => {
		expect(checkMustEditVars(read("wrangler.example.toml"))).toEqual([]);
	});

	it("flags a mustEdit var the template only mentions in a comment", () => {
		const lines = MUST_EDIT_VARS.map((e) => `${e.name} = "x"`).join("\n");
		expect(checkMustEditVars(`[vars]\n${lines}\n`)).toEqual([]);
		const commented = lines
			.split("\n")
			.map((l, i) => (i === 0 ? `# ${l}` : l))
			.join("\n");
		const problems = checkMustEditVars(`[vars]\n${commented}\n`);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(MUST_EDIT_VARS[0]?.name as string);
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
