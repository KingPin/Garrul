/**
 * Release manifest schema, validator, and loaders.
 *
 * Each tagged release ships a release-manifest.json at the repo root
 * declaring required secrets, bindings, migrations, and the renderer
 * version. The upgrade script reads the local manifest (what's deployed)
 * and fetches the target manifest from raw.githubusercontent.com, then
 * diffs.
 *
 * The validator is hand-rolled (no dependency) — the schema is small and
 * the script needs to run before `node_modules` may have been refreshed.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type SemVer = string; // "0.0.1" or "v0.0.1"

export type SecretEntry = {
	name: string;
	required: boolean;
	description?: string;
	addedIn?: SemVer;
};

export type KvEntry = {
	binding: string;
	required: boolean;
	description?: string;
	addedIn?: SemVer;
};

export type D1Entry = {
	binding: string;
	databaseName: string;
	required: boolean;
	description?: string;
	addedIn?: SemVer;
};

export type AnalyticsEntry = {
	binding: string;
	dataset: string;
	required: boolean;
	description?: string;
	addedIn?: SemVer;
};

export type RendererEntry = {
	version: number;
	eagerRerender: boolean;
};

export type BreakingChange = {
	id: string;
	summary: string;
	manualSteps: string[];
};

export type Manifest = {
	version: SemVer;
	minPreviousVersion: SemVer;
	renderer: RendererEntry;
	secrets: SecretEntry[];
	kvNamespaces: KvEntry[];
	d1Databases: D1Entry[];
	analyticsDatasets: AnalyticsEntry[];
	migrations: string[];
	breakingChanges: BreakingChange[];
};

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const stripV = (s: SemVer): string => s.replace(/^v/, "");

export const parseSemver = (
	s: SemVer,
): [number, number, number] | null => {
	if (!SEMVER_RE.test(s)) return null;
	const core = stripV(s).split(/[-+]/)[0] ?? "";
	const parts = core.split(".").map((n) => Number.parseInt(n, 10));
	if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
	return [parts[0] as number, parts[1] as number, parts[2] as number];
};

export const compareSemver = (a: SemVer, b: SemVer): number => {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) {
		throw new Error(`bad semver: ${a} vs ${b}`);
	}
	for (let i = 0; i < 3; i++) {
		const av = pa[i] as number;
		const bv = pb[i] as number;
		if (av !== bv) return av - bv;
	}
	return 0;
};

export const isNewer = (target: SemVer, current: SemVer): boolean =>
	compareSemver(target, current) > 0;

export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const requireString = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): string => {
	const v = parent[key];
	if (typeof v !== "string") {
		throw new ManifestError(`${path}.${key} must be a string`);
	}
	return v;
};

const optionalString = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): string | undefined => {
	const v = parent[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") {
		throw new ManifestError(`${path}.${key} must be a string`);
	}
	return v;
};

const requireBool = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): boolean => {
	const v = parent[key];
	if (typeof v !== "boolean") {
		throw new ManifestError(`${path}.${key} must be a boolean`);
	}
	return v;
};

const requireNumber = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): number => {
	const v = parent[key];
	if (typeof v !== "number" || !Number.isFinite(v)) {
		throw new ManifestError(`${path}.${key} must be a finite number`);
	}
	return v;
};

const requireArray = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): unknown[] => {
	const v = parent[key];
	if (!Array.isArray(v)) {
		throw new ManifestError(`${path}.${key} must be an array`);
	}
	return v;
};

const requireSemver = (
	parent: Record<string, unknown>,
	key: string,
	path: string,
): SemVer => {
	const s = requireString(parent, key, path);
	if (!parseSemver(s)) {
		throw new ManifestError(`${path}.${key} is not a valid semver: ${s}`);
	}
	return s;
};

const validateSecret = (raw: unknown, i: number): SecretEntry => {
	if (!isObject(raw)) throw new ManifestError(`secrets[${i}] must be object`);
	const entry: SecretEntry = {
		name: requireString(raw, "name", `secrets[${i}]`),
		required: requireBool(raw, "required", `secrets[${i}]`),
	};
	const desc = optionalString(raw, "description", `secrets[${i}]`);
	if (desc !== undefined) entry.description = desc;
	const addedIn = optionalString(raw, "addedIn", `secrets[${i}]`);
	if (addedIn !== undefined) entry.addedIn = addedIn;
	return entry;
};

const validateKv = (raw: unknown, i: number): KvEntry => {
	if (!isObject(raw))
		throw new ManifestError(`kvNamespaces[${i}] must be object`);
	const entry: KvEntry = {
		binding: requireString(raw, "binding", `kvNamespaces[${i}]`),
		required: requireBool(raw, "required", `kvNamespaces[${i}]`),
	};
	const desc = optionalString(raw, "description", `kvNamespaces[${i}]`);
	if (desc !== undefined) entry.description = desc;
	const addedIn = optionalString(raw, "addedIn", `kvNamespaces[${i}]`);
	if (addedIn !== undefined) entry.addedIn = addedIn;
	return entry;
};

const validateD1 = (raw: unknown, i: number): D1Entry => {
	if (!isObject(raw))
		throw new ManifestError(`d1Databases[${i}] must be object`);
	const entry: D1Entry = {
		binding: requireString(raw, "binding", `d1Databases[${i}]`),
		databaseName: requireString(raw, "databaseName", `d1Databases[${i}]`),
		required: requireBool(raw, "required", `d1Databases[${i}]`),
	};
	const desc = optionalString(raw, "description", `d1Databases[${i}]`);
	if (desc !== undefined) entry.description = desc;
	const addedIn = optionalString(raw, "addedIn", `d1Databases[${i}]`);
	if (addedIn !== undefined) entry.addedIn = addedIn;
	return entry;
};

const validateAnalytics = (raw: unknown, i: number): AnalyticsEntry => {
	if (!isObject(raw))
		throw new ManifestError(`analyticsDatasets[${i}] must be object`);
	const entry: AnalyticsEntry = {
		binding: requireString(raw, "binding", `analyticsDatasets[${i}]`),
		dataset: requireString(raw, "dataset", `analyticsDatasets[${i}]`),
		required: requireBool(raw, "required", `analyticsDatasets[${i}]`),
	};
	const desc = optionalString(raw, "description", `analyticsDatasets[${i}]`);
	if (desc !== undefined) entry.description = desc;
	const addedIn = optionalString(raw, "addedIn", `analyticsDatasets[${i}]`);
	if (addedIn !== undefined) entry.addedIn = addedIn;
	return entry;
};

const validateBreakingChange = (raw: unknown, i: number): BreakingChange => {
	if (!isObject(raw))
		throw new ManifestError(`breakingChanges[${i}] must be object`);
	const steps = requireArray(raw, "manualSteps", `breakingChanges[${i}]`);
	for (let j = 0; j < steps.length; j++) {
		if (typeof steps[j] !== "string") {
			throw new ManifestError(
				`breakingChanges[${i}].manualSteps[${j}] must be a string`,
			);
		}
	}
	return {
		id: requireString(raw, "id", `breakingChanges[${i}]`),
		summary: requireString(raw, "summary", `breakingChanges[${i}]`),
		manualSteps: steps as string[],
	};
};

export const validateManifest = (raw: unknown): Manifest => {
	if (!isObject(raw)) throw new ManifestError("manifest must be an object");

	const renderer = raw["renderer"];
	if (!isObject(renderer)) {
		throw new ManifestError("renderer must be an object");
	}

	const migrationsArr = requireArray(raw, "migrations", "");
	for (let i = 0; i < migrationsArr.length; i++) {
		if (typeof migrationsArr[i] !== "string") {
			throw new ManifestError(`migrations[${i}] must be a string`);
		}
	}

	return {
		version: requireSemver(raw, "version", ""),
		minPreviousVersion: requireSemver(raw, "minPreviousVersion", ""),
		renderer: {
			version: requireNumber(renderer, "version", "renderer"),
			eagerRerender: requireBool(renderer, "eagerRerender", "renderer"),
		},
		secrets: requireArray(raw, "secrets", "").map(validateSecret),
		kvNamespaces: requireArray(raw, "kvNamespaces", "").map(validateKv),
		d1Databases: requireArray(raw, "d1Databases", "").map(validateD1),
		analyticsDatasets: requireArray(raw, "analyticsDatasets", "").map(
			validateAnalytics,
		),
		migrations: migrationsArr as string[],
		breakingChanges: requireArray(raw, "breakingChanges", "").map(
			validateBreakingChange,
		),
	};
};

export const MANIFEST_FILENAME = "release-manifest.json";

export const loadLocal = (repoRoot: string): Manifest | null => {
	const path = join(repoRoot, MANIFEST_FILENAME);
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(text);
	return validateManifest(parsed);
};

export const fetchRemote = async (
	owner: string,
	repo: string,
	tag: string,
): Promise<Manifest> => {
	const url = `https://raw.githubusercontent.com/${owner}/${repo}/refs/tags/${tag}/${MANIFEST_FILENAME}`;
	const res = await fetch(url);
	if (!res.ok) {
		throw new ManifestError(
			`failed to fetch remote manifest (${res.status}): ${url}`,
		);
	}
	const text = await res.text();
	const parsed: unknown = JSON.parse(text);
	return validateManifest(parsed);
};
