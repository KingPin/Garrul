/**
 * Drift detection — pure functions. No subprocess, no fixtures, no fs.
 */
import { describe, it, expect } from "vitest";
import {
	diffSecrets,
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
	KvEntry,
	D1Entry,
} from "../scripts/upgrade/manifest";

const secret = (name: string, required = true): SecretEntry => ({
	name,
	required,
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

describe("hasMutations + blocksAutoApply", () => {
	const empty = (): Plan => ({
		secrets: { missing: [], extra: [] },
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

	it("blocksAutoApply empty otherwise", () => {
		expect(blocksAutoApply(empty())).toHaveLength(0);
	});
});
