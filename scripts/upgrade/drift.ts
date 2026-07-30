/**
 * Pure-functional drift detection. Given "what the deployed instance has"
 * and "what the target manifest requires", produces a structured diff.
 *
 * No I/O, no subprocesses, no globals — testable as plain unit functions.
 */
import type {
	Manifest,
	SecretEntry,
	VarEntry,
	KvEntry,
	D1Entry,
} from "./manifest";

export type Diff<TMissing, TExtra = string> = {
	missing: TMissing[];
	extra: TExtra[];
};

export const diffSecrets = (
	present: string[],
	manifest: SecretEntry[],
): Diff<SecretEntry> => {
	const presentSet = new Set(present);
	const declaredSet = new Set(manifest.map((s) => s.name));
	return {
		missing: manifest.filter((s) => s.required && !presentSet.has(s.name)),
		extra: present.filter((name) => !declaredSet.has(name)),
	};
};

/**
 * `present` is the set of keys under `[vars]` in the operator's
 * wrangler.toml.
 *
 * Every var is optional by design — Garrul ships a default for each — so
 * `missing` is normally empty and this diff is informational: it tells an
 * operator which settings the target release added that they haven't set.
 * `extra` catches vars left in wrangler.toml after a release removed them.
 */
export const diffVars = (
	present: string[],
	manifest: VarEntry[],
): Diff<VarEntry> => {
	const presentSet = new Set(present);
	const declaredSet = new Set(manifest.map((v) => v.name));
	return {
		missing: manifest.filter((v) => v.required && !presentSet.has(v.name)),
		extra: present.filter((name) => !declaredSet.has(name)),
	};
};

/**
 * Vars the target release declares that the operator has not set and that
 * did not exist in the release they're upgrading from — "new settings you
 * may want to look at". Vars they've deliberately left at their default
 * across several releases stay quiet.
 */
export const newVarsSince = (
	present: string[],
	current: VarEntry[],
	target: VarEntry[],
): VarEntry[] => {
	const presentSet = new Set(present);
	const knownSet = new Set(current.map((v) => v.name));
	return target.filter((v) => !knownSet.has(v.name) && !presentSet.has(v.name));
};

export const diffKv = (
	present: string[],
	manifest: KvEntry[],
): Diff<KvEntry> => {
	const presentSet = new Set(present);
	const declaredSet = new Set(manifest.map((k) => k.binding));
	return {
		missing: manifest.filter((k) => k.required && !presentSet.has(k.binding)),
		extra: present.filter((binding) => !declaredSet.has(binding)),
	};
};

export const diffD1 = (
	present: string[],
	manifest: D1Entry[],
): Diff<D1Entry> => {
	const presentSet = new Set(present);
	const declaredSet = new Set(manifest.map((d) => d.binding));
	return {
		missing: manifest.filter((d) => d.required && !presentSet.has(d.binding)),
		extra: present.filter((binding) => !declaredSet.has(binding)),
	};
};

export type MigrationDiff = {
	pending: string[];
	diverged: string[];
};

/**
 * applied: names from the _migrations table (D1)
 * declared: full migration list from the target manifest (cumulative, sorted)
 *
 * `pending` = migrations declared by the target but not yet applied.
 * `diverged` = migrations applied to the live DB that the target manifest
 * doesn't know about. This is normally empty; non-empty means the operator
 * is running ahead of (or sideways from) the target, and the upgrade should
 * refuse.
 */
export const diffMigrations = (
	applied: string[],
	declared: string[],
): MigrationDiff => {
	const appliedSet = new Set(applied);
	const declaredSet = new Set(declared);
	return {
		pending: declared.filter((m) => !appliedSet.has(m)),
		diverged: applied.filter((m) => !declaredSet.has(m)),
	};
};

export type RendererDiff = {
	current: number;
	target: number;
	bumped: boolean;
	eager: boolean;
};

export const diffRenderer = (
	currentLocal: number,
	manifest: Manifest,
): RendererDiff => ({
	current: currentLocal,
	target: manifest.renderer.version,
	bumped: manifest.renderer.version > currentLocal,
	eager: manifest.renderer.eagerRerender,
});

export type Plan = {
	secrets: Diff<SecretEntry>;
	vars: Diff<VarEntry>;
	/** Informational only — never blocks or triggers an apply step. */
	newVars: VarEntry[];
	kv: Diff<KvEntry>;
	d1: Diff<D1Entry>;
	migrations: MigrationDiff;
	renderer: RendererDiff;
	breakingChanges: Manifest["breakingChanges"];
};

export const hasMutations = (plan: Plan): boolean =>
	plan.secrets.missing.length > 0 ||
	plan.kv.missing.length > 0 ||
	plan.d1.missing.length > 0 ||
	plan.migrations.pending.length > 0;

export const blocksAutoApply = (plan: Plan): string[] => {
	const reasons: string[] = [];
	if (plan.migrations.diverged.length > 0) {
		reasons.push(
			`live database has migrations the target doesn't declare: ${plan.migrations.diverged.join(", ")}`,
		);
	}
	// Secrets can be set non-interactively; `[vars]` cannot — they live in
	// wrangler.toml, which is the operator's file and never rewritten here.
	if (plan.vars.missing.length > 0) {
		reasons.push(
			`wrangler.toml [vars] is missing required entries — add them by hand: ${plan.vars.missing
				.map((v) => v.name)
				.join(", ")}`,
		);
	}
	return reasons;
};
