/**
 * Pure-functional drift detection. Given "what the deployed instance has"
 * and "what the target manifest requires", produces a structured diff.
 *
 * No I/O, no subprocesses, no globals — testable as plain unit functions.
 */
import type {
	Manifest,
	SecretEntry,
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
	return reasons;
};
