/**
 * Drift detection — pure functions. No subprocess, no fixtures, no fs.
 */
import { describe, it, expect } from "vitest";
import {
	diffSecrets,
	diffVars,
	newVarsSince,
	newSecretsSince,
	diffKv,
	diffD1,
	diffMigrations,
	diffRenderer,
	hasMutations,
	blocksAutoApply,
	type Plan,
} from "../scripts/upgrade/drift";
import type {
	Manifest,
	SecretEntry,
	VarEntry,
	KvEntry,
	D1Entry,
} from "../scripts/upgrade/manifest";

const secret = (name: string, required = true): SecretEntry => ({
	name,
	required,
});
const v = (name: string, addedIn = "1.0.0", required = false): VarEntry => ({
	name,
	required,
	addedIn,
});
const kv = (binding: string, required = true): KvEntry => ({
	binding,
	required,
});
const d1 = (binding: string, databaseName = "garrul-db"): D1Entry => ({
	binding,
	databaseName,
	required: true,
});

describe("diffSecrets", () => {
	it("returns no missing when all required are present", () => {
		const r = diffSecrets(
			["JWT", "IP"],
			[secret("JWT"), secret("IP")],
		);
		expect(r.missing).toHaveLength(0);
		expect(r.extra).toHaveLength(0);
	});

	it("flags a missing required secret", () => {
		const r = diffSecrets(["JWT"], [secret("JWT"), secret("IP")]);
		expect(r.missing.map((s) => s.name)).toEqual(["IP"]);
	});

	it("ignores optional secrets that are missing", () => {
		const r = diffSecrets(
			["JWT"],
			[secret("JWT"), secret("OPTIONAL", false)],
		);
		expect(r.missing).toHaveLength(0);
	});

	it("reports extras (informational, never deleted)", () => {
		const r = diffSecrets(["JWT", "LEGACY"], [secret("JWT")]);
		expect(r.extra).toEqual(["LEGACY"]);
		expect(r.missing).toHaveLength(0);
	});
});

describe("diffKv", () => {
	it("identifies missing required namespaces", () => {
		const r = diffKv(["RATE_LIMITS"], [kv("RATE_LIMITS"), kv("SESSIONS")]);
		expect(r.missing.map((k) => k.binding)).toEqual(["SESSIONS"]);
	});

	it("ignores optional KV that's missing", () => {
		const r = diffKv(["A"], [kv("A"), kv("B", false)]);
		expect(r.missing).toHaveLength(0);
	});
});

describe("diffD1", () => {
	it("flags missing required D1", () => {
		const r = diffD1([], [d1("DB")]);
		expect(r.missing.map((x) => x.binding)).toEqual(["DB"]);
	});
});

describe("diffMigrations", () => {
	it("returns no pending when applied matches declared", () => {
		const r = diffMigrations(["a.sql", "b.sql"], ["a.sql", "b.sql"]);
		expect(r.pending).toHaveLength(0);
		expect(r.diverged).toHaveLength(0);
	});

	it("returns pending for unapplied declared", () => {
		const r = diffMigrations(["a.sql"], ["a.sql", "b.sql"]);
		expect(r.pending).toEqual(["b.sql"]);
	});

	it("flags diverged when applied has migrations the target doesn't", () => {
		const r = diffMigrations(["a.sql", "future.sql"], ["a.sql"]);
		expect(r.diverged).toEqual(["future.sql"]);
	});
});

describe("diffRenderer", () => {
	const m = (rendererVersion: number, eager = false): Manifest =>
		({
			renderer: { version: rendererVersion, eagerRerender: eager },
		}) as Manifest;

	it("reports bumped when target > current", () => {
		const r = diffRenderer(1, m(2));
		expect(r.bumped).toBe(true);
	});

	it("not bumped when equal", () => {
		const r = diffRenderer(2, m(2));
		expect(r.bumped).toBe(false);
	});

	it("eager flag propagates", () => {
		const r = diffRenderer(1, m(2, true));
		expect(r.eager).toBe(true);
	});
});

describe("diffVars", () => {
	it("reports nothing when every declared var is optional", () => {
		const r = diffVars(["ENV"], [v("ENV"), v("VOTING_ENABLED")]);
		expect(r.missing).toHaveLength(0);
		expect(r.extra).toHaveLength(0);
	});

	it("flags a required var the operator has not set", () => {
		const r = diffVars(["ENV"], [v("ENV"), v("ALLOWED_ORIGINS", "1.0.0", true)]);
		expect(r.missing.map((e) => e.name)).toEqual(["ALLOWED_ORIGINS"]);
	});

	it("reports vars in wrangler.toml the target no longer declares", () => {
		const r = diffVars(["ENV", "REMOVED_FLAG"], [v("ENV")]);
		expect(r.extra).toEqual(["REMOVED_FLAG"]);
	});
});

describe("newVarsSince", () => {
	it("surfaces only vars added after the operator's version and still unset", () => {
		const target = [
			v("ENV", "1.0.0"),
			v("VOTING_ENABLED", "1.8.0"),
			v("AUTO_CLOSE_DAYS", "1.21.0"),
			v("COMMUNITY_MIN_VOTES", "1.21.0"),
		];
		const r = newVarsSince(["ENV"], "1.20.0", target);
		expect(r.map((e) => e.name)).toEqual([
			"AUTO_CLOSE_DAYS",
			"COMMUNITY_MIN_VOTES",
		]);
	});

	it("stays quiet about old vars left at their default", () => {
		// VOTING_ENABLED predates the operator's version and is unset. That is a
		// deliberate default, not news — it must not be re-announced every upgrade.
		const target = [v("ENV", "1.0.0"), v("VOTING_ENABLED", "1.8.0")];
		expect(newVarsSince(["ENV"], "1.20.0", target)).toHaveLength(0);
	});

	it("does not re-announce a var the operator already set", () => {
		const target = [v("ENV", "1.0.0"), v("AUTO_CLOSE_DAYS", "1.21.0")];
		const r = newVarsSince(["ENV", "AUTO_CLOSE_DAYS"], "1.20.0", target);
		expect(r).toHaveLength(0);
	});

	it("does not flood on the first upgrade from a pre-1.21.0 manifest", () => {
		// Manifests from tags <= 1.20.0 have no vars key, so a set-difference
		// against current.vars would call all ~30 long-standing settings "new"
		// on the one upgrade every existing install has to perform. addedIn is
		// accurate across that boundary.
		const target = [
			v("ENV", "1.0.0"),
			v("VOTING_ENABLED", "1.8.0"),
			v("BRANDING_HIDDEN", "1.21.0"),
		];
		const r = newVarsSince([], "1.20.0", target);
		expect(r.map((e) => e.name)).toEqual(["BRANDING_HIDDEN"]);
	});

	it("spans several releases, not just the newest tag", () => {
		const target = [v("A", "1.17.0"), v("B", "1.21.0"), v("C", "1.10.0")];
		const r = newVarsSince([], "1.15.0", target);
		expect(r.map((e) => e.name)).toEqual(["A", "B"]);
	});

	it("treats a var with no addedIn as old", () => {
		const bare: VarEntry = { name: "MYSTERY", required: false };
		expect(newVarsSince([], "1.0.0", [bare])).toHaveLength(0);
	});
});

describe("newSecretsSince", () => {
	const s = (name: string, addedIn: string, required = false): SecretEntry => ({
		name,
		required,
		addedIn,
	});

	it("surfaces the optional secret a release adds", () => {
		// The GITHUB_TOKEN case: 1.21.0 shipped it to lift GitHub's
		// unauthenticated 60 req/hr cap on version checks. diffSecrets filters
		// `missing` on required, so without this the upgrade plan says nothing
		// about the one setting the release actually adds.
		const target = [
			s("JWT_SECRET", "1.0.0", true),
			s("GITHUB_TOKEN", "1.21.0"),
		];
		const r = newSecretsSince(["JWT_SECRET"], "1.20.0", target);
		expect(r.map((e) => e.name)).toEqual(["GITHUB_TOKEN"]);
	});

	it("leaves required secrets to diffSecrets", () => {
		// A missing required secret is already reported there, and far more
		// loudly. Duplicating it here would read as two separate problems.
		const target = [s("NEW_REQUIRED", "1.21.0", true)];
		expect(newSecretsSince([], "1.20.0", target)).toHaveLength(0);
	});

	it("stays quiet about old optional secrets left unset", () => {
		const target = [s("AKISMET_API_KEY", "1.9.0")];
		expect(newSecretsSince([], "1.20.0", target)).toHaveLength(0);
	});

	it("does not re-announce a secret the operator already set", () => {
		const target = [s("GITHUB_TOKEN", "1.21.0")];
		expect(newSecretsSince(["GITHUB_TOKEN"], "1.20.0", target)).toHaveLength(
			0,
		);
	});

	it("spans several releases, not just the newest tag", () => {
		const target = [s("A", "1.17.0"), s("B", "1.21.0"), s("C", "1.10.0")];
		const r = newSecretsSince([], "1.15.0", target);
		expect(r.map((e) => e.name)).toEqual(["A", "B"]);
	});

	it("treats a secret with no addedIn as old", () => {
		const bare: SecretEntry = { name: "MYSTERY", required: false };
		expect(newSecretsSince([], "1.0.0", [bare])).toHaveLength(0);
	});
});

describe("hasMutations + blocksAutoApply", () => {
	const empty = (): Plan => ({
		secrets: { missing: [], extra: [] },
		vars: { missing: [], extra: [] },
		newVars: [],
		newSecrets: [],
		kv: { missing: [], extra: [] },
		d1: { missing: [], extra: [] },
		migrations: { pending: [], diverged: [] },
		renderer: { current: 1, target: 1, bumped: false, eager: false },
		breakingChanges: [],
	});

	it("hasMutations false on empty plan", () => {
		expect(hasMutations(empty())).toBe(false);
	});

	it("hasMutations true when secret missing", () => {
		const p = empty();
		p.secrets.missing.push(secret("X"));
		expect(hasMutations(p)).toBe(true);
	});

	it("blocksAutoApply flags diverged migrations", () => {
		const p = empty();
		p.migrations.diverged.push("rogue.sql");
		expect(blocksAutoApply(p)).toHaveLength(1);
	});

	it("blocksAutoApply flags a missing required var", () => {
		// The script sets secrets but never rewrites wrangler.toml [vars], so a
		// required var it cannot supply has to stop an unattended apply.
		const p = empty();
		p.vars.missing.push(v("ALLOWED_ORIGINS", true));
		expect(blocksAutoApply(p)).toHaveLength(1);
	});

	it("newVars alone never blocks or counts as a mutation", () => {
		const p = empty();
		p.newVars.push(v("AUTO_CLOSE_DAYS"));
		expect(hasMutations(p)).toBe(false);
		expect(blocksAutoApply(p)).toHaveLength(0);
	});

	it("newSecrets alone never blocks or counts as a mutation", () => {
		// Optional by definition — `apply` must not start prompting for them.
		const p = empty();
		p.newSecrets.push({ name: "GITHUB_TOKEN", required: false });
		expect(hasMutations(p)).toBe(false);
		expect(blocksAutoApply(p)).toHaveLength(0);
	});

	it("blocksAutoApply empty otherwise", () => {
		expect(blocksAutoApply(empty())).toHaveLength(0);
	});
});
