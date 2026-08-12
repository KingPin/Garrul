#!/usr/bin/env tsx
/**
 * Generate (or check) the operator-facing config templates from
 * scripts/config-registry.ts.
 *
 *   npm run config:build   # writes the generated files/regions
 *   npm run config:check   # exits 1 if any committed file is stale
 *
 * Fully generated:
 *   secrets.example.env    template for `wrangler secret bulk`
 *   .dev.vars.example      template for local `wrangler dev`
 *
 * Generated regions (between BEGIN/END markers, rest of file hand-written):
 *   wrangler.example.toml  the [secrets] required list, the secrets pointer,
 *                          and the [[d1_databases]] / [[kv_namespaces]] /
 *                          [[analytics_engine_datasets]] blocks
 *   scripts/setup.sh       the put_random_secret / put_secret prompt lists,
 *                          the mustEdit vars in the next-steps block, and the
 *                          create_d1 / create_kv call lists
 *   AGENTS-OPERATE.md      the section 5 config table
 *
 * The binding blocks come from the `Bindings` type in src/index.ts rather than
 * the registry: they are typed `KVNamespace` / `D1Database` /
 * `AnalyticsEngineDataset`, not `string`, so they are not registry entries —
 * the parity assertion in build-manifest.ts requires the registry to be exactly
 * the `string` fields. src/index.ts is already the machine-read source for the
 * manifest's kvNamespaces and d1Databases; these five lists join it.
 *
 * Checked but not generated:
 *   wrangler.example.toml  [vars] block — every registry var must appear
 *                          there, set or commented. That block carries
 *                          multi-paragraph operator prose that a one-line
 *                          `hint` can't reproduce, so it stays hand-written
 *                          and CI only enforces coverage.
 *
 * Run `npm run manifest:build` too when adding an entry — the release
 * contract is generated from the same registry by a separate script.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_REGISTRY,
	SECRETS,
	VARS,
	MUST_EDIT_VARS,
	REQUIRED_SECRET_NAMES,
	GENERATED_SECRET_NAMES,
	groupsOf,
	targetFor,
	type ConfigEntry,
} from "./config-registry";
import {
	parseBindings,
	readBindingsSource,
	type DerivedBindings,
} from "./bindings";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const GENERATED_BY = "npm run config:build";
const SOURCE = "scripts/config-registry.ts";
/** The other source of truth: KV bindings, which are not registry entries. */
const BINDINGS_SOURCE = "the Bindings type in src/index.ts";

/** Also hardcoded in setup.sh's set_kv_id / set_d1_id wrappers; change together. */
const KV_PLACEHOLDER = "PASTE_FROM_WRANGLER_KV_CREATE";
const D1_PLACEHOLDER = "PASTE_FROM_WRANGLER_D1_CREATE";

type Region = { begin: string; end: string };

const region = (id: string, comment: "#" | "html"): Region =>
	comment === "#"
		? { begin: `# BEGIN:${id}`, end: `# END:${id}` }
		: { begin: `<!-- BEGIN:${id} -->`, end: `<!-- END:${id} -->` };

/**
 * Swap the text between two markers. Throws rather than appending when a
 * marker is missing — a silently skipped region is exactly the kind of
 * drift this script exists to prevent.
 */
const replaceRegion = (
	source: string,
	{ begin, end }: Region,
	body: string,
	file: string,
): string => {
	const startIdx = source.indexOf(begin);
	const endIdx = source.indexOf(end);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
		throw new Error(
			`${file} is missing the ${begin} / ${end} markers — restore them, then re-run \`${GENERATED_BY}\``,
		);
	}
	return (
		source.slice(0, startIdx + begin.length) +
		`\n${body}\n` +
		source.slice(endIdx)
	);
};

/** Fold several regions into one file. setup.sh has four. */
const replaceRegions = (
	source: string,
	file: string,
	regions: [Region, string][],
): string =>
	regions.reduce(
		(acc, [target, body]) => replaceRegion(acc, target, body, file),
		source,
	);

// --------------------------------------------------------- secrets.example.env

/**
 * EVERY line is commented out, required ones included. This is not a
 * stylistic choice.
 *
 * `wrangler secret bulk` accepts dotenv as well as JSON, and its validator
 * (`validateFileSecrets`) rejects only non-string values. `""` is a string,
 * so an unedited `TURNSTILE_SECRET=` would parse to an empty string and
 * *overwrite the real secret with nothing*. With every line commented, an
 * unedited file parses to `{}` and wrangler refuses it outright — a loud,
 * safe failure instead of a silent blanking.
 *
 * The two generated secrets are excluded entirely: setup.sh pipes
 * `openssl rand` straight into `wrangler secret put`, so they never touch
 * disk. Listing them here would invite operators to undo that.
 */
const buildSecretsEnv = (): string => {
	const out: string[] = [
		"# Garrul secrets — template for `wrangler secret bulk`.",
		"#",
		`# Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand.`,
		"#",
		"# Usage:",
		"#   cp secrets.example.env secrets.env",
		"#   # uncomment and fill in the ones you need, then:",
		"#   npx wrangler secret bulk secrets.env",
		"#   rm secrets.env",
		"#",
		"# secrets.env is gitignored, but it holds plaintext credentials on disk —",
		"# delete it once the upload succeeds.",
		"#",
		"# LEAVE UNUSED LINES COMMENTED. `wrangler secret bulk` treats an empty",
		"# value as a real, empty secret: an uncommented `RESEND_API_KEY=` would",
		"# overwrite your live key with an empty string rather than skip it.",
		"#",
		`# Not listed here: ${GENERATED_SECRET_NAMES.join(" and ")}. \`scripts/setup.sh\``,
		"# pipes `openssl rand -base64 32` straight into wrangler for those, so they",
		"# are never written to disk. Generate them the same way if you set them by",
		"# hand: `openssl rand -base64 32 | npx wrangler secret put JWT_SECRET`.",
	];

	const listed = SECRETS.filter((e) => !e.generate);
	for (const [group, entries] of groupsOf(listed)) {
		out.push("", `# --- ${group} ---`);
		for (const e of entries) {
			out.push(`# ${e.hint}${e.required ? " (REQUIRED)" : ""}`);
			out.push(`# ${e.name}=`);
		}
	}
	return `${out.join("\n")}\n`;
};

// ----------------------------------------------------------- .dev.vars.example

/**
 * Unlike secrets.example.env, values here are uncommented: `.dev.vars` is
 * read wholesale by `wrangler dev` and blanking a local placeholder costs
 * nothing.
 */
const buildDevVars = (): string => {
	const out: string[] = [
		"# Copy this file to .dev.vars for local `wrangler dev`.",
		"# .dev.vars is gitignored. NEVER commit real secrets.",
		"#",
		`# Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand.`,
		"#",
		"# Blank values are fine locally — a feature is simply off when its",
		"# credentials are unset. Fill in only what you're exercising.",
	];

	const emit = (e: ConfigEntry) => {
		// `devHint` wins where the production answer is wrong locally —
		// "from dash.cloudflare.com" would send a contributor after real
		// Turnstile keys when the placeholder below is a test key on purpose.
		for (const line of (e.devHint ?? e.hint).split("\n")) {
			out.push(`# ${line}`);
		}
		out.push(`${e.name}="${e.devPlaceholder ?? ""}"`);
	};

	// Vars come first, and only the ones carrying an explicit devPlaceholder.
	// A `var`'s home is wrangler.toml; it appears here only where the shipped
	// production default makes a local clone non-functional. `.dev.vars` wins
	// over `[vars]` in `wrangler dev` (result is seeded from `[vars]`, then
	// overwritten per key), which is what makes the override work at all.
	const devVars = VARS.filter((e) => e.devPlaceholder != null);
	if (devVars.length > 0) {
		out.push(
			"",
			"# --- Local dev overrides ---",
			"# These are wrangler.toml vars, overridden here for local dev only:",
			"# .dev.vars takes precedence over [vars] under `wrangler dev`.",
		);
		for (const e of devVars) emit(e);
	}

	for (const [group, entries] of groupsOf(SECRETS)) {
		out.push("", `# --- ${group} ---`);
		for (const e of entries) emit(e);
	}
	return `${out.join("\n")}\n`;
};

// ------------------------------------------------------- wrangler.example.toml

/**
 * Emitted COMMENTED OUT. This is the whole point of the block, so it needs
 * saying twice.
 *
 * Declaring a `[secrets]` table changes how `wrangler dev` reads `.dev.vars`
 * for the entire file, not just the listed names. From `getVarsForDev` in
 * wrangler-dist/cli.js:
 *
 *     if (secrets) {
 *       const requiredSecrets = secrets.required ?? [];
 *       for (const [key, value] of Object.entries(loadedSecrets)) {
 *         if (key in result || requiredSecrets.includes(key)) { ... }
 *
 * `result` is seeded from `[vars]`, so any `.dev.vars` key that is neither a
 * declared var nor in `required` is dropped — silently, with no warning and
 * no mention in the bindings banner. Without a `[secrets]` table the `else`
 * branch binds the file wholesale.
 *
 * Verified against wrangler 4.115.0 with a two-key `.dev.vars`: with
 * `required = ["REQ_ONE"]` the banner lists only `REQ_ONE`; with the table
 * removed it lists both. Uncommented here, the four names below would cost
 * local dev the other 19 secrets — every OAuth pair, RESEND_API_KEY,
 * AKISMET_*, TELEGRAM_*, CF_API_TOKEN, GITHUB_TOKEN — which is exactly the
 * set `.dev.vars.example` tells contributors to fill in.
 *
 * Listing all 23 instead is not the fix: `deploy` hard-fails on any unset
 * name in `required`, so a GitHub-only install could no longer ship.
 */
const buildSecretsRequired = (): string =>
	[
		`# Generated by \`${GENERATED_BY}\` — do not edit by hand.`,
		"#",
		"# Commented out on purpose — uncomment ONLY in a deploy-only config.",
		"#",
		"# What it buys you: a deploy that would leave one of these unset fails",
		"# instead of shipping a Worker that 500s on its first request.",
		"#",
		"# What it costs you: declaring [secrets] makes `wrangler dev` bind ONLY",
		"# the names listed below (plus [vars]) out of .dev.vars — every other",
		"# secret in that file is dropped silently, with no warning. If you run",
		"# `wrangler dev` against this file, leave these two lines commented or",
		"# local OAuth, Resend, Akismet and Telegram will read as unconfigured.",
		"#",
		"# Adding the optional per-provider credentials to the list does not help:",
		"# wrangler then fails the deploy on every install that deliberately",
		"# doesn't set them.",
		"# [secrets]",
		`# required = [${REQUIRED_SECRET_NAMES.map((n) => `"${n}"`).join(", ")}]`,
	].join("\n");

/**
 * The "start here" banner at the top of wrangler.example.toml.
 *
 * 261 lines land in front of an operator on first contact, of which a handful
 * actually need a decision; the rest is well-commented optional flags. Until
 * now the must-edit list appeared only at the *end* of setup.sh's run and
 * mid-INSTALL.md, so anyone who opened the file directly — which is what
 * "copy this to wrangler.toml and fill in the IDs" tells them to do — had to
 * find them by reading all 261 lines.
 *
 * Generated from MUST_EDIT_VARS rather than hand-written for the reason
 * `mustEdit` exists at all (issue #46): a hand-maintained list of placeholders
 * goes stale the first time someone adds one, and stays green in CI while it
 * does.
 */
const buildMustEditBanner = (vars = MUST_EDIT_VARS): string => {
	const width = Math.max(...vars.map((e) => e.name.length));
	return [
		`# Generated by \`${GENERATED_BY}\` from ${SOURCE} — do not edit by hand.`,
		"#",
		"# ── START HERE ────────────────────────────────────────────────────────",
		"#",
		"# Most of this file is optional flags with sane defaults. These are the",
		`# ${vars.length} values that ship as placeholders and must be replaced before you`,
		"# deploy — everything else can wait:",
		"#",
		...vars.map((e) => `#   ${e.name.padEnd(width)}  — ${e.hint}`),
		"#",
		"# Plus the [[routes]] block below, if you want a custom subdomain rather",
		"# than *.workers.dev.",
		"#",
		"# `npm run setup` walks you through the rest (D1, KV, secrets) and",
		"# reprints this list when it finishes.",
		"#",
		"# ──────────────────────────────────────────────────────────────────────",
	].join("\n");
};

const buildSecretsPointer = (): string => {
	const optional = SECRETS.filter((e) => !e.required && !e.generate);
	return [
		`# Generated by \`${GENERATED_BY}\` — do not edit by hand.`,
		"#",
		"# Secrets are NOT set in this file. Two ways to set them:",
		"#",
		"#   1. In bulk (recommended):",
		"#        cp secrets.example.env secrets.env   # then edit",
		"#        npx wrangler secret bulk secrets.env && rm secrets.env",
		"#   2. One at a time: `npx wrangler secret put <NAME>`",
		"#      (`./scripts/setup.sh` prompts for these on a first install.)",
		"#",
		"# For local dev, use .dev.vars (gitignored) — see .dev.vars.example.",
		"#",
		`# Always required: ${SECRETS.filter((e) => e.required)
			.map((e) => e.name)
			.join(", ")}`,
		`# Generated for you by setup.sh: ${GENERATED_SECRET_NAMES.join(", ")}`,
		"# Optional (per feature):",
		...optional.map((e) => `#   ${e.name} — ${e.hint}`),
	].join("\n");
};

// ------------------------------------------------------------ setup.sh prompts

/** Single-quote-free, `$`-free bash double-quoted string. */
const shQuote = (s: string): string =>
	`"${s.replace(/([\\"$`])/g, "\\$1")}"`;

/**
 * The `put_*` calls in setup.sh's interactive branch. Generating them is the
 * point: setup.sh used to prompt for 16 of the 23 secrets, so CF_API_TOKEN,
 * SPAM_FORM_TS_SECRET, AKISMET_*, TELEGRAM_* and GITHUB_TOKEN were reachable
 * only by an operator who read wrangler.example.toml closely.
 *
 * A group of exactly two collapses to one `put_secret_pair` prompt — asking
 * separately about a client ID and its secret is asking the same question
 * twice. Everything else gets its own prompt.
 */
/** `secrets` is a seam for testing the pairing rules; production passes none. */
const buildSetupPrompts = (indent = "\t", secrets = SECRETS): string => {
	const lines: string[] = [
		`${indent}# Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand.`,
	];
	for (const [group, entries] of groupsOf(secrets.filter((e) => !e.generate))) {
		const consumed = new Set<string>();
		for (const e of entries) {
			if (consumed.has(e.name)) continue;
			if (!e.pairWith) {
				lines.push(`${indent}put_secret ${e.name} ${shQuote(e.hint)}`);
				continue;
			}
			const partner = entries.find((p) => p.name === e.pairWith);
			if (!partner) {
				throw new Error(
					`${e.name}.pairWith names "${e.pairWith}", which is not a secret in group "${group}".`,
				);
			}
			consumed.add(partner.name);
			lines.push(
				`${indent}put_secret_pair ${shQuote(group)} ${shQuote(e.hint)} ${e.name} ${partner.name}`,
			);
		}
	}
	return lines.join("\n");
};

/** The always-run half: streamed from `openssl rand`, never written to disk. */
const buildSetupGenerated = (indent = ""): string =>
	[
		`${indent}# Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand.`,
		...SECRETS.filter((e) => e.generate).map(
			(e) => `${indent}put_random_secret ${e.name} ${shQuote(e.hint)}`,
		),
	].join("\n");

// -------------------------------------------------------- setup.sh next steps

/**
 * Step 1 of setup.sh's closing "Next steps" list: the vars whose shipped value
 * is a placeholder.
 *
 * This line used to be a hardcoded `echo "1. Edit wrangler.toml:
 * ALLOWED_ORIGINS, ADMIN_EMAILS, route pattern."`. Every var is
 * `required: false`, so there was no flag to generate it from and no way for
 * `config:check` to notice a newly added placeholder going unmentioned — the
 * drift class the registry exists to close. `mustEdit` is that flag.
 *
 * The `[[routes]]` line is literal because a route pattern is TOML structure,
 * not a registry var. It still belongs here: `confirm_route` runs at the top of
 * setup.sh and the operator may have answered "continue without one".
 */
const buildSetupNextSteps = (indent = "", vars = MUST_EDIT_VARS): string => {
	const width = Math.max(...vars.map((e) => e.name.length));
	return [
		`${indent}# Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand.`,
		`${indent}echo ${shQuote("1. Edit wrangler.toml before deploying — these ship as placeholders:")}`,
		...vars.map(
			(e) =>
				`${indent}echo ${shQuote(`     ${e.name.padEnd(width)} — ${e.hint}`)}`,
		),
		`${indent}echo ${shQuote("   Plus the [[routes]] pattern, if you skipped it above.")}`,
	].join("\n");
};

// ------------------------------------------------------------------- bindings

/**
 * Header shared by every binding region — all of them derive from `Bindings`
 * rather than the registry.
 */
const bindingsHeader = (indent = "", filledBySetup = true): string[] => [
	`${indent}# Generated by \`${GENERATED_BY}\` from ${BINDINGS_SOURCE}. Do not edit by hand.`,
	...(filledBySetup
		? [`${indent}# Ids are filled in by ./scripts/setup.sh, matched on binding name.`]
		: []),
];

/**
 * The `[[kv_namespaces]]` blocks. Live TOML at column 0 — unlike the
 * `secrets-required` region above, which is commented out on purpose.
 *
 * Block order is cosmetic now that setup.sh matches on `binding`, so this
 * follows `Bindings` field order purely so the two generated lists read the
 * same way.
 */
const buildKvNamespaceBlocks = (kv: string[]): string =>
	[
		...bindingsHeader(),
		...kv.flatMap((binding) => [
			"",
			"[[kv_namespaces]]",
			`binding = "${binding}"`,
			`id = "${KV_PLACEHOLDER}"`,
		]),
	].join("\n");

/**
 * The `[[d1_databases]]` blocks. `databaseName` comes from the same parse, so
 * a renamed or second `D1Database` field reaches the template and setup.sh's
 * `create_d1` call together — it used to reach neither, since `garrul-db` was
 * spelled by hand in both.
 */
const buildD1Blocks = (d1: DerivedBindings["d1"]): string =>
	[
		...bindingsHeader(),
		...d1.flatMap(({ binding, databaseName }) => [
			"",
			"[[d1_databases]]",
			`binding = "${binding}"`,
			`database_name = "${databaseName}"`,
			`database_id = "${D1_PLACEHOLDER}"`,
		]),
	].join("\n");

/**
 * The `[[analytics_engine_datasets]]` blocks. No setup.sh counterpart — a
 * dataset is created implicitly on first write, so there is nothing to create
 * and no id to paste. Generated anyway so adding an `AnalyticsEngineDataset`
 * field cannot leave the template silently short a binding.
 */
const buildAnalyticsBlocks = (
	analytics: DerivedBindings["analytics"],
): string =>
	[
		...bindingsHeader("", false),
		...analytics.flatMap(({ binding, dataset }) => [
			"",
			"[[analytics_engine_datasets]]",
			`binding = "${binding}"`,
			`dataset = "${dataset}"`,
		]),
	].join("\n");

/**
 * setup.sh's `create_kv` calls. Hand-maintained, these were the other half of
 * the ordering hazard in issue #46: the list had to stay in sync with a
 * `Bindings` type nothing checked it against, and adding a fifth namespace
 * meant remembering three files. Order no longer carries meaning — `set_kv_id`
 * matches on binding name — so this only has to be complete.
 */
const buildSetupKvCreates = (indent = "", kv: string[]): string =>
	[
		...bindingsHeader(indent, false),
		...kv.map((binding) => `${indent}create_kv ${binding}`),
	].join("\n");

/**
 * setup.sh's `create_d1` calls. `create_d1` took no arguments and spelled
 * `garrul-db` inline; it now takes the binding and the database name, so the
 * database this creates and the block the id lands in both come from
 * `Bindings`.
 */
const buildSetupD1Creates = (
	indent = "",
	d1: DerivedBindings["d1"],
): string =>
	[
		...bindingsHeader(indent, false),
		...d1.map(
			({ binding, databaseName }) =>
				`${indent}create_d1 ${binding} ${databaseName}`,
		),
	].join("\n");

// ------------------------------------------------------- AGENTS-OPERATE.md §5

const tableRow = (e: ConfigEntry): string =>
	`| \`${e.name}\` | ${e.kind} | ${e.description} | ${
		e.example ? `\`${e.example}\`` : "—"
	} | ${targetFor(e)} |`;

const buildConfigTable = (): string =>
	[
		`<!-- Generated by \`${GENERATED_BY}\` from ${SOURCE}. Do not edit by hand. -->`,
		"",
		"| Name | Type | Purpose | Example | Where to set |",
		"|---|---|---|---|---|",
		...CONFIG_REGISTRY.map(tableRow),
	].join("\n");

// -------------------------------------------------------------- vars coverage

/**
 * wrangler.example.toml's [vars] block is hand-written prose, so this only
 * enforces that no registry var is missing from it — a new flag that nobody
 * can discover is the failure mode worth catching.
 */
/**
 * The body of the `[vars]` table, up to the next table header.
 *
 * Both checks below run against this rather than the whole file. Unscoped,
 * `^NAME\s*=` was satisfied by an assignment anywhere in the template —
 * including under a per-environment `[env.*.vars]` override, which does not
 * apply to the base config an operator deploys, or under some future table
 * that happens to reuse a var name as a key.
 */
const varsBlock = (toml: string): string => {
	const header = /^\[vars\]$/m.exec(toml);
	if (!header) {
		throw new Error("wrangler.example.toml has no [vars] table");
	}
	const body = toml.slice(header.index + header[0].length);
	const next = body.search(/^\[/m);
	return next < 0 ? body : body.slice(0, next);
};

const checkVarCoverage = (toml: string): string[] => {
	const vars = varsBlock(toml);
	const problems: string[] = [];
	for (const e of VARS) {
		// Matches both `NAME = "x"` and the commented `# NAME = "x"` form.
		if (!new RegExp(`^#?\\s*${e.name}\\s*=`, "m").test(vars)) {
			problems.push(
				`wrangler.example.toml [vars] never mentions ${e.name} — add it (commented is fine) so operators can find it`,
			);
		}
	}
	return problems;
};

/**
 * A `mustEdit` var must be assigned in the template, not left commented.
 * Commented out, the `wrangler.toml` an operator copies simply lacks the
 * setting — and these are the four where that fails closed and silently:
 * no `ALLOWED_ORIGINS` means every embed and every state-changing POST is
 * rejected, with nothing in the file to suggest why.
 */
const checkMustEditVars = (toml: string): string[] => {
	const vars = varsBlock(toml);
	const problems: string[] = [];
	for (const e of MUST_EDIT_VARS) {
		if (!new RegExp(`^${e.name}\\s*=`, "m").test(vars)) {
			problems.push(
				`wrangler.example.toml must assign ${e.name} uncommented — it is flagged mustEdit, so operators need a placeholder line to replace`,
			);
		}
	}
	return problems;
};

// --------------------------------------------------------------------- driver

type Output = { path: string; contents: string };

const buildOutputs = (): { outputs: Output[]; problems: string[] } => {
	const read = (rel: string): string =>
		readFileSync(join(REPO_ROOT, rel), "utf8");

	const toml = read("wrangler.example.toml");
	const { kv, d1, analytics } = parseBindings(readBindingsSource(REPO_ROOT));
	const outputs: Output[] = [
		{ path: "secrets.example.env", contents: buildSecretsEnv() },
		{ path: ".dev.vars.example", contents: buildDevVars() },
		{
			path: "wrangler.example.toml",
			contents: replaceRegions(toml, "wrangler.example.toml", [
				[region("must-edit-banner", "#"), buildMustEditBanner()],
				[region("secrets-required", "#"), buildSecretsRequired()],
				[region("secrets-pointer", "#"), buildSecretsPointer()],
				[region("d1-databases", "#"), buildD1Blocks(d1)],
				[region("kv-namespaces", "#"), buildKvNamespaceBlocks(kv)],
				[region("analytics-datasets", "#"), buildAnalyticsBlocks(analytics)],
			]),
		},
		{
			path: "scripts/setup.sh",
			contents: replaceRegions(read("scripts/setup.sh"), "scripts/setup.sh", [
				[region("interactive-secrets", "#"), buildSetupPrompts()],
				[region("generated-secrets", "#"), buildSetupGenerated()],
				[region("must-edit-vars", "#"), buildSetupNextSteps()],
				[region("d1-bindings", "#"), buildSetupD1Creates("", d1)],
				[region("kv-bindings", "#"), buildSetupKvCreates("", kv)],
			]),
		},
		{
			path: "AGENTS-OPERATE.md",
			contents: replaceRegion(
				read("AGENTS-OPERATE.md"),
				region("config-table", "html"),
				buildConfigTable(),
				"AGENTS-OPERATE.md",
			),
		},
	];

	return {
		outputs,
		problems: [...checkVarCoverage(toml), ...checkMustEditVars(toml)],
	};
};

const main = () => {
	const check = process.argv.includes("--check");
	const { outputs, problems } = buildOutputs();

	if (problems.length > 0) {
		for (const p of problems) console.error(`[config] ${p}`);
		process.exit(1);
	}

	let stale = 0;
	for (const { path, contents } of outputs) {
		const abs = join(REPO_ROOT, path);
		if (check) {
			if (!existsSync(abs) || readFileSync(abs, "utf8") !== contents) {
				console.error(`[config:check] ${path} is stale`);
				stale++;
			}
			continue;
		}
		writeFileSync(abs, contents);
	}

	if (check) {
		if (stale > 0) {
			console.error(
				`[config:check] ${stale} file(s) out of date — regenerate with \`${GENERATED_BY}\` and commit`,
			);
			process.exit(1);
		}
		console.log(
			`[config:check] OK (${outputs.length} files match ${SOURCE}; ${CONFIG_REGISTRY.length} entries)`,
		);
		return;
	}

	console.log(
		`[config:build] wrote ${outputs.map((o) => o.path).join(", ")} (${SECRETS.length} secrets, ${VARS.length} vars)`,
	);
};

export {
	buildSecretsEnv,
	buildDevVars,
	buildSecretsRequired,
	buildSecretsPointer,
	buildSetupPrompts,
	buildSetupGenerated,
	buildSetupNextSteps,
	buildKvNamespaceBlocks,
	buildSetupKvCreates,
	buildD1Blocks,
	buildSetupD1Creates,
	buildAnalyticsBlocks,
	buildConfigTable,
	checkVarCoverage,
	checkMustEditVars,
};

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (err) {
		console.error("[config] failed:", err);
		process.exit(1);
	}
}
