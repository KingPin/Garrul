/**
 * Manifest validator + semver helpers. These are pure functions over JSON
 * — no I/O, no Workers runtime needed.
 */
import { describe, it, expect } from "vitest";
import {
	validateManifest,
	parseSemver,
	compareSemver,
	isNewer,
	ManifestError,
	type Manifest,
} from "../scripts/upgrade/manifest";

const validRaw: Manifest = {
	version: "0.0.2",
	minPreviousVersion: "0.0.1",
	renderer: { version: 1, eagerRerender: false },
	secrets: [{ name: "JWT_SECRET", required: true, addedIn: "0.0.1" }],
	kvNamespaces: [{ binding: "RATE_LIMITS", required: true }],
	d1Databases: [
		{ binding: "DB", databaseName: "garrul-db", required: true },
	],
	analyticsDatasets: [
		{ binding: "ANALYTICS", dataset: "garrul_events", required: false },
	],
	migrations: ["0001_init.sql"],
	breakingChanges: [],
};

describe("semver helpers", () => {
	it("parses bare and v-prefixed semver", () => {
		expect(parseSemver("0.0.1")).toEqual([0, 0, 1]);
		expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
	});

	it("rejects non-semver strings", () => {
		expect(parseSemver("nope")).toBeNull();
		expect(parseSemver("1.2")).toBeNull();
		expect(parseSemver("")).toBeNull();
	});

	it("compares with v-prefix tolerance", () => {
		expect(compareSemver("v0.0.2", "0.0.1")).toBeGreaterThan(0);
		expect(compareSemver("0.0.1", "v0.0.1")).toBe(0);
		expect(compareSemver("0.1.0", "0.0.9")).toBeGreaterThan(0);
		expect(compareSemver("1.0.0", "0.9.9")).toBeGreaterThan(0);
	});

	it("isNewer", () => {
		expect(isNewer("0.0.2", "0.0.1")).toBe(true);
		expect(isNewer("0.0.1", "0.0.2")).toBe(false);
		expect(isNewer("0.0.1", "0.0.1")).toBe(false);
	});
});

describe("validateManifest", () => {
	it("accepts a well-formed manifest", () => {
		const m = validateManifest(JSON.parse(JSON.stringify(validRaw)));
		expect(m.version).toBe("0.0.2");
		expect(m.secrets[0]?.name).toBe("JWT_SECRET");
	});

	it("rejects missing version", () => {
		const bad = { ...validRaw } as Partial<Manifest>;
		delete bad.version;
		expect(() => validateManifest(bad)).toThrow(ManifestError);
	});

	it("rejects invalid semver in version", () => {
		expect(() =>
			validateManifest({ ...validRaw, version: "not-a-semver" }),
		).toThrow(/valid semver/);
	});

	it("rejects non-array migrations", () => {
		expect(() =>
			validateManifest({ ...validRaw, migrations: "wat" as unknown as string[] }),
		).toThrow(ManifestError);
	});

	it("rejects unknown shapes", () => {
		expect(() => validateManifest(null)).toThrow(ManifestError);
		expect(() => validateManifest("string")).toThrow(ManifestError);
	});

	it("requires required:boolean on secret entries", () => {
		const bad = {
			...validRaw,
			secrets: [{ name: "X" }],
		};
		expect(() => validateManifest(bad)).toThrow(ManifestError);
	});

	it("rejects malformed addedIn on secret entries", () => {
		const bad = {
			...validRaw,
			secrets: [{ name: "X", required: true, addedIn: "not-a-version" }],
		};
		expect(() => validateManifest(bad)).toThrow(/valid semver/);
	});

	it("rejects malformed addedIn on kv/d1/analytics entries", () => {
		expect(() =>
			validateManifest({
				...validRaw,
				kvNamespaces: [
					{ binding: "K", required: true, addedIn: "nope" },
				],
			}),
		).toThrow(/valid semver/);
		expect(() =>
			validateManifest({
				...validRaw,
				d1Databases: [
					{
						binding: "DB",
						databaseName: "garrul-db",
						required: true,
						addedIn: "1.x",
					},
				],
			}),
		).toThrow(/valid semver/);
		expect(() =>
			validateManifest({
				...validRaw,
				analyticsDatasets: [
					{
						binding: "A",
						dataset: "d",
						required: false,
						addedIn: "v",
					},
				],
			}),
		).toThrow(/valid semver/);
	});

	it("accepts a well-formed addedIn semver", () => {
		const m = validateManifest({
			...validRaw,
			secrets: [{ name: "X", required: true, addedIn: "v1.2.3" }],
		});
		expect(m.secrets[0]?.addedIn).toBe("v1.2.3");
	});
});
