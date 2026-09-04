/**
 * Pure-functional drift detection. Given "what the deployed instance has"
 * and "what the target manifest requires", produces a structured diff.
 *
 * No I/O, no subprocesses, no globals — testable as plain unit functions.
 */
import { isNewer } from "./manifest";
import type {
	Manifest,
	SecretEntry,
	VarEntry,
	KvEntry,
	D1Entry,
	SemVer,
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
 * Vars introduced after the release the operator is on and still unset —
 * "new settings you may want to look at". Vars they've deliberately left at
 * their default across several releases stay quiet.
 *
 * Keyed on each entry's `addedIn`, not on a set-difference against the
 * current manifest's `vars[]`. Manifests from tags <= 1.20.0 have no `vars`
 * key at all (`validateManifest` defaults it to `[]`), so a set-difference
 * would announce all ~30 long-standing settings as "new in this release" on
 * the one upgrade every existing install has to perform. `addedIn` is
 * accurate across that boundary. An entry without `addedIn` is treated as
 * old — staying quiet is the safe direction for an informational report.
 */
export const newVarsSince = (
	present: string[],
	currentVersion: SemVer,
	target: VarEntry[],
): VarEntry[] => {
	const presentSet = new Set(present);
	return target.filter(
		(v) =>
			v.addedIn !== undefined &&
			isNewer(v.addedIn, currentVersion) &&
			!presentSet.has(v.name),
	);
};

export type PlaceholderVar = {
	name: string;
	value: string;
	description?: string;
};

/**
 * Vars still set to the value wrangler.example.toml ships them as.
 *
 * `diffVars` cannot catch these and never will: every var is `required: false`
 * by design, and these are *set* — just set to `https://comments.example.com`.
 * A deploy with untouched example origins passes every existing check and then
 * fails at runtime with the two most-reported errors in
 * docs/troubleshooting.md — CORS rejections and `redirect_uri_mismatch` —
 * neither of which points back at wrangler.toml.
 *
 * Reported, never blocking. An operator legitimately running Garrul on
 * `example.com` would be told to change a setting that is correct for them,
 * and a warning they can ignore is the right cost for that; refusing to
 * upgrade over it is not.
 *
 * `vars` is the operator's `[vars]` table with values; a `null` value is a key
 * set to a non-string, which no placeholder is.
 */
export const placeholderVars = (
	vars: Record<string, string | null>,
	manifest: VarEntry[],
): PlaceholderVar[] => {
	const out: PlaceholderVar[] = [];
	for (const v of manifest) {
		if (v.placeholder === undefined) continue;
		const actual = vars[v.name];
		if (typeof actual !== "string" || actual !== v.placeholder) continue;
		const entry: PlaceholderVar = { name: v.name, value: actual };
		if (v.description !== undefined) entry.description = v.description;
		out.push(entry);
	}
	return out;
};

/**
 * Optional secrets introduced after the release the operator is on and not
 * yet set — the secrets-side counterpart to `newVarsSince`.
 *
 * Without this an optional new secret is invisible to `upgrade`:
 * `diffSecrets` filters `missing` on `required`, so `required: false` never
 * reaches the plan. `GITHUB_TOKEN` shipped in 1.21.0 precisely because
 * operators hitting GitHub's unauthenticated 60 req/hr cap had no supported
 * way to discover the fix — declaring it in the manifest only helps if the
 * upgrade path actually says so.
 *
 * Required entries are excluded rather than duplicated: a missing required
 * secret is already reported, and far more loudly, by `diffSecrets`.
 */
export const newSecretsSince = (
	present: string[],
	currentVersion: SemVer,
	target: SecretEntry[],
): SecretEntry[] => {
	const presentSet = new Set(present);
	return target.filter(
		(s) =>
			!s.required &&
			s.addedIn !== undefined &&
			isNewer(s.addedIn, currentVersion) &&
			!presentSet.has(s.name),
	);
};

/**
 * Breaking changes introduced after the release the operator is on.
 *
 * `breakingChanges[]` is cumulative — it is the project's whole history of
 * manual-intervention releases, and every entry stays in the manifest forever
 * so an operator on any supported version can still be told about it. Printing
 * that list unfiltered meant a 2.5.0 → 2.7.0 hop demanded nine "manual steps
 * required" blocks whose real answer was "nothing to do, that was 1.20.0".
 * Nine irrelevant warnings is how an operator learns to skim past the section
 * that will one day contain a real one.
 *
 * Direction on a missing `addedIn` is the opposite of `newVarsSince`: an entry
 * without one is *shown*. An unannounced breaking change costs an operator a
 * broken deploy; a redundant one costs them a paragraph. `build-manifest.ts`
 * makes the missing case unreachable for anything added from 2.7.1 on.
 */
export const breakingChangesSince = (
	currentVersion: SemVer,
	target: Manifest["breakingChanges"],
): Manifest["breakingChanges"] =>
	target.filter(
		(bc) => bc.addedIn === undefined || isNewer(bc.addedIn, currentVersion),
	);

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
	/** Informational only. Optional by definition, so never applied either. */
	newSecrets: SecretEntry[];
	/** Informational only — wrangler.toml is the operator's file. */
	placeholders: PlaceholderVar[];
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

/**
 * True when the plan says the install has nothing: every required secret
 * missing and every migration pending, on a `wrangler.toml` that already
 * names its D1 database. A genuinely fresh install has no D1 block yet
 * (`setup.sh` creates it), so this shape is far more likely to be a read
 * that quietly came back empty than an operator who created a database and
 * then did nothing else. The reads throw on failure now, so this is a second
 * line — it costs one comparison and turns "re-run 23 migrations" into a
 * question the operator can answer before saying yes.
 */
export const looksLikeLostInstall = (plan: Plan, target: Manifest): boolean => {
	if (plan.d1.missing.length > 0) return false;
	const requiredSecrets = target.secrets.filter((s) => s.required).length;
	return (
		target.migrations.length > 0 &&
		plan.migrations.pending.length === target.migrations.length &&
		requiredSecrets > 0 &&
		plan.secrets.missing.length === requiredSecrets
	);
};
