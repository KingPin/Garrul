#!/usr/bin/env tsx
/**
 * Build (or check) release-manifest.json from the current source tree.
 *
 *   npm run manifest:build   # writes release-manifest.json
 *   npm run manifest:check   # exits 1 if the committed manifest differs
 *
 * Derives:
 *   - secrets / KV / D1 / Analytics entries from the Bindings type in
 *     src/index.ts (parsed textually — Bindings is a type, no runtime form)
 *   - migrations list from src/db/migrations/*.sql
 *   - renderer.version from CURRENT_RENDERER_VERSION in src/lib/markdown.ts
 *   - version from package.json
 *
 * Free-text fields (description, breakingChanges, renderer.eagerRerender,
 * minPreviousVersion) are preserved from the existing manifest on each
 * regeneration. New bindings/secrets default to required=true so a release
 * with a new requirement fails CI loudly until the maintainer reviews.
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
	type KvEntry,
	type D1Entry,
	type AnalyticsEntry,
} from "./manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

type DerivedBindings = {
	d1: { binding: string; databaseName: string }[];
	kv: string[];
	analytics: { binding: string; dataset: string }[];
	secrets: string[];
};

const ANALYTICS_DATASET = "garrul_events";

// Public, non-secret strings declared in wrangler.toml [vars]. Anything string-
// typed in Bindings NOT in this set is treated as a secret.
const WRANGLER_VARS = new Set([
	"ENV",
	"ALLOWED_ORIGINS",
	"ADMIN_EMAILS",
	"EDIT_WINDOW_MINUTES",
	"EMAIL_PROVIDER",
	"EMAIL_FROM",
	"PUBLIC_BASE_URL",
	"CANONICAL_URL",
	"BRANDING_HIDDEN",
	"OAUTH_CALLBACK_BASE",
]);

const parseBindings = (): DerivedBindings => {
	const src = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
	const start = src.indexOf("export type Bindings");
	if (start < 0) {
		throw new Error("could not locate `export type Bindings` in src/index.ts");
	}
	const open = src.indexOf("{", start);
	const close = src.indexOf("};", open);
	if (open < 0 || close < 0) {
		throw new Error("could not find Bindings block braces");
	}
	const body = src.slice(open + 1, close);
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("//"));

	const out: DerivedBindings = { d1: [], kv: [], analytics: [], secrets: [] };

	for (const line of lines) {
		const match = /^([A-Z_][A-Z0-9_]*)\??:\s*([^;]+);?$/.exec(line);
		if (!match) continue;
		const name = match[1] as string;
		const type = (match[2] as string).trim();

		if (type === "D1Database") {
			out.d1.push({
				binding: name,
				databaseName: name === "DB" ? "garrul-db" : name.toLowerCase(),
			});
		} else if (type === "KVNamespace") {
			out.kv.push(name);
		} else if (type === "AnalyticsEngineDataset") {
			out.analytics.push({ binding: name, dataset: ANALYTICS_DATASET });
		} else if (type === "string") {
			if (!WRANGLER_VARS.has(name)) out.secrets.push(name);
		}
	}

	return out;
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

const buildSecrets = (
	existing: Manifest | null,
	names: string[],
	version: string,
): SecretEntry[] =>
	names.map((name) => {
		const prev = findEntry(existing?.secrets, "name", name);
		const entry: SecretEntry = {
			name,
			required: prev?.required ?? true,
		};
		if (prev?.description !== undefined) entry.description = prev.description;
		entry.addedIn = prev?.addedIn ?? version;
		return entry;
	});

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

	const bindings = parseBindings();
	const version = readVersion();

	const candidate: Manifest = {
		version,
		minPreviousVersion: existing?.minPreviousVersion ?? version,
		renderer: {
			version: readRendererVersion(),
			eagerRerender: existing?.renderer.eagerRerender ?? false,
		},
		secrets: buildSecrets(existing, bindings.secrets, version),
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
