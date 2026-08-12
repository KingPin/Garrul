#!/usr/bin/env tsx
/**
 * Build (or check) release-manifest.json from the current source tree.
 *
 *   npm run manifest:build   # writes release-manifest.json
 *   npm run manifest:check   # exits 1 if the committed manifest differs
 *
 * Derives:
 *   - secrets / vars from scripts/config-registry.ts, cross-checked against
 *     the Bindings type in src/index.ts (see assertRegistryMatchesBindings)
 *   - KV / D1 / Analytics entries from that same Bindings type (parsed
 *     textually by scripts/bindings.ts — Bindings is a type, so it has no
 *     runtime form)
 *   - migrations list from src/db/migrations/*.sql
 *   - renderer.version from CURRENT_RENDERER_VERSION in src/lib/markdown.ts
 *   - version from package.json
 *
 * Free-text fields (description, breakingChanges, renderer.eagerRerender,
 * minPreviousVersion) are preserved from the existing manifest on each
 * regeneration. New bindings default to required=true so a release with a
 * new requirement fails CI loudly until the maintainer reviews.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadLocal,
	MANIFEST_FILENAME,
	validateManifest,
	type Manifest,
	type SecretEntry,
	type VarEntry,
	type KvEntry,
	type D1Entry,
	type AnalyticsEntry,
} from "./manifest";
import {
	CONFIG_REGISTRY,
	MUST_EDIT_VARS,
	SECRETS,
	VARS,
} from "../config-registry";
import { parseBindings, readBindingsSource } from "../bindings";
import { parseTomlVars } from "./toml-vars";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Fail the build when `Bindings` and the registry disagree.
 *
 * This replaces the old inverted `WRANGLER_VARS` allowlist, which treated
 * any unlisted `string` field as a secret. That default was silent and
 * wrong: the allowlist never grew as feature flags were added, so 20 plain
 * vars ended up in the manifest's `secrets[]`.
 *
 * Cross-checking instead of re-deriving keeps `Bindings` hand-written —
 * it carries the doc comments explaining each setting, which a generated
 * type would lose — while making an unregistered binding a loud CI error
 * rather than a misclassification.
 */
export const assertRegistryMatchesBindings = (bindingNames: string[]): void => {
	const inRegistry = new Set(CONFIG_REGISTRY.map((e) => e.name));
	const inBindings = new Set(bindingNames);

	const unregistered = bindingNames.filter((n) => !inRegistry.has(n));
	const orphaned = CONFIG_REGISTRY.map((e) => e.name).filter(
		(n) => !inBindings.has(n),
	);

	const problems: string[] = [];
	if (unregistered.length > 0) {
		problems.push(
			`declared in src/index.ts Bindings but missing from scripts/config-registry.ts: ${unregistered.join(", ")}`,
		);
	}
	if (orphaned.length > 0) {
		problems.push(
			`listed in scripts/config-registry.ts but missing from src/index.ts Bindings: ${orphaned.join(", ")}`,
		);
	}
	if (problems.length > 0) {
		throw new Error(
			`config registry is out of sync with the Bindings type:\n  - ${problems.join(
				"\n  - ",
			)}\nAdd the entry to both, then re-run \`npm run manifest:build\`.`,
		);
	}
};

/**
 * Every breaking change in *this repo's* manifest must say which release it
 * landed in, so `upgrade` can stop showing it once an operator is past that
 * version. The schema keeps `addedIn` optional — manifests published before
 * 2.7.1 don't have it and still have to parse — so this is where the
 * requirement is actually enforced, on the one manifest we can still edit.
 */
export const assertBreakingChangesVersioned = (
	breakingChanges: Manifest["breakingChanges"],
): void => {
	const unversioned = breakingChanges
		.filter((bc) => bc.addedIn === undefined)
		.map((bc) => bc.id);
	if (unversioned.length > 0) {
		throw new Error(
			`breakingChanges entries are missing \`addedIn\`: ${unversioned.join(", ")}\n` +
				"Add the release each one became breaking in (e.g. \"addedIn\": \"2.7.1\"), " +
				"then re-run `npm run manifest:build`.\n" +
				"Without it `npm run upgrade` shows the entry to every operator forever.",
		);
	}
};

const readRendererVersion = (): number => {
	const src = readFileSync(
		join(REPO_ROOT, "src", "lib", "markdown.ts"),
		"utf8",
	);
	const m = /CURRENT_RENDERER_VERSION\s*=\s*(\d+)/.exec(src);
	if (!m) throw new Error("CURRENT_RENDERER_VERSION not found in markdown.ts");
	return Number.parseInt(m[1] as string, 10);
};

const readVersion = (): string => {
	const pkg: unknown = JSON.parse(
		readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
	);
	if (
		typeof pkg !== "object" ||
		pkg === null ||
		typeof (pkg as { version?: unknown }).version !== "string"
	) {
		throw new Error("package.json has no version string");
	}
	return (pkg as { version: string }).version;
};

const listMigrations = (): string[] =>
	readdirSync(join(REPO_ROOT, "src", "db", "migrations"))
		.filter((f) => f.endsWith(".sql"))
		.sort();

const findEntry = <T extends { binding?: string; name?: string }>(
	arr: T[] | undefined,
	key: "binding" | "name",
	value: string,
): T | undefined => arr?.find((e) => e[key] === value);

/**
 * `required` and `addedIn` come from the registry, not from the previous
 * manifest. Before the registry existed these were hand-edited into
 * release-manifest.json after each regeneration — new secrets defaulted to
 * `required: true` and had to be flipped by hand. Now the registry entry
 * carries the intent and regeneration is idempotent. `description` is still
 * preserved from the committed manifest: nothing sets it today, but the
 * field is part of the published schema.
 */
const buildSecrets = (existing: Manifest | null): SecretEntry[] =>
	SECRETS.map((e) => {
		const prev = findEntry(existing?.secrets, "name", e.name);
		const entry: SecretEntry = { name: e.name, required: e.required };
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = e.addedIn;
		return entry;
	});

/**
 * The value each `mustEdit` var ships as in wrangler.example.toml, read from
 * that file rather than restated in the registry.
 *
 * One source, so the two cannot disagree: the registry says *which* vars ship
 * a placeholder, the template says *what* it is, and this is where they meet.
 * A `mustEdit` var whose key isn't a plain string in the template is an error
 * rather than a silent skip — that is the case where the check quietly stops
 * covering a var, which is the failure mode `mustEdit` was added to prevent
 * (issue #46).
 */
const readPlaceholders = (): Record<string, string> => {
	const vars = parseTomlVars(
		readFileSync(join(REPO_ROOT, "wrangler.example.toml"), "utf8"),
	);
	const out: Record<string, string> = {};
	for (const e of MUST_EDIT_VARS) {
		const value = vars[e.name];
		if (typeof value !== "string") {
			throw new Error(
				`${e.name} is marked mustEdit in scripts/config-registry.ts but has no ` +
					"string value under [vars] in wrangler.example.toml.\n" +
					"Add the placeholder there, or drop `mustEdit` from the registry entry.",
			);
		}
		out[e.name] = value;
	}
	return out;
};

const buildVars = (existing: Manifest | null): VarEntry[] => {
	const placeholders = readPlaceholders();
	return VARS.map((e) => {
		const prev = findEntry(existing?.vars, "name", e.name);
		const entry: VarEntry = { name: e.name, required: e.required };
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = e.addedIn;
		const placeholder = placeholders[e.name];
		if (placeholder !== undefined) entry.placeholder = placeholder;
		return entry;
	});
};

const buildKv = (
	existing: Manifest | null,
	names: string[],
	version: string,
): KvEntry[] =>
	names.map((binding) => {
		const prev = findEntry(existing?.kvNamespaces, "binding", binding);
		const entry: KvEntry = {
			binding,
			required: prev?.required ?? true,
		};
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = prev?.addedIn ?? version;
		return entry;
	});

const buildD1 = (
	existing: Manifest | null,
	dbs: { binding: string; databaseName: string }[],
	version: string,
): D1Entry[] =>
	dbs.map(({ binding, databaseName }) => {
		const prev = findEntry(existing?.d1Databases, "binding", binding);
		const entry: D1Entry = {
			binding,
			databaseName: prev?.databaseName ?? databaseName,
			required: prev?.required ?? true,
		};
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = prev?.addedIn ?? version;
		return entry;
	});

const buildAnalytics = (
	existing: Manifest | null,
	datasets: { binding: string; dataset: string }[],
	version: string,
): AnalyticsEntry[] =>
	datasets.map(({ binding, dataset }) => {
		const prev = findEntry(existing?.analyticsDatasets, "binding", binding);
		const entry: AnalyticsEntry = {
			binding,
			dataset: prev?.dataset ?? dataset,
			required: prev?.required ?? false,
		};
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = prev?.addedIn ?? version;
		return entry;
	});

export const buildManifest = (): Manifest => {
	const existing = (() => {
		try {
			return loadLocal(REPO_ROOT);
		} catch {
			return null;
		}
	})();

	const bindings = parseBindings(readBindingsSource(REPO_ROOT));
	assertRegistryMatchesBindings(bindings.strings);
	assertBreakingChangesVersioned(existing?.breakingChanges ?? []);
	const version = readVersion();

	const candidate: Manifest = {
		version,
		minPreviousVersion: existing?.minPreviousVersion ?? version,
		renderer: {
			version: readRendererVersion(),
			eagerRerender: existing?.renderer.eagerRerender ?? false,
		},
		secrets: buildSecrets(existing),
		vars: buildVars(existing),
		kvNamespaces: buildKv(existing, bindings.kv, version),
		d1Databases: buildD1(existing, bindings.d1, version),
		analyticsDatasets: buildAnalytics(existing, bindings.analytics, version),
		migrations: listMigrations(),
		breakingChanges: existing?.breakingChanges ?? [],
	};

	return validateManifest(candidate);
};

const serialize = (m: Manifest): string => `${JSON.stringify(m, null, 2)}\n`;

const main = () => {
	const check = process.argv.includes("--check");
	const candidate = buildManifest();
	const candidateText = serialize(candidate);
	const path = join(REPO_ROOT, MANIFEST_FILENAME);

	if (check) {
		if (!existsSync(path)) {
			console.error(
				`[manifest:check] ${MANIFEST_FILENAME} missing — run \`npm run manifest:build\` and commit the file`,
			);
			process.exit(1);
		}
		const committed = readFileSync(path, "utf8");
		if (committed !== candidateText) {
			console.error(
				`[manifest:check] ${MANIFEST_FILENAME} is stale — regenerate with \`npm run manifest:build\``,
			);
			process.exit(1);
		}
		console.log(`[manifest:check] OK (${MANIFEST_FILENAME} up to date)`);
		return;
	}

	writeFileSync(path, candidateText);
	console.log(`[manifest:build] wrote ${MANIFEST_FILENAME}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		main();
	} catch (err) {
		console.error("[manifest] failed:", err);
		process.exit(1);
	}
}
