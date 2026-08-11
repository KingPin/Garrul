/**
 * End-to-end dry-run smoke for the upgrade orchestrator. Drives main()
 * with fully mocked deps. The key invariant: --dry-run must not call any
 * mutating wrangler or git function, full stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { main } from "../scripts/upgrade";
import type * as wranglerModule from "../scripts/upgrade/wrangler";
import type * as gitModule from "../scripts/upgrade/git";
import type { Manifest } from "../scripts/upgrade/manifest";

const fakeTargetManifest: Manifest = {
	version: "1.2.0",
	minPreviousVersion: "1.0.0",
	renderer: { version: 1, eagerRerender: false },
	secrets: [
		{ name: "JWT_SECRET", required: true },
		{ name: "NEW_SECRET", required: true },
		// Optional, added by the target. diffSecrets filters `missing` on
		// `required`, so this one only ever reaches the plan via newSecretsSince.
		{ name: "NEW_TOKEN", required: false, addedIn: "1.2.0" },
		{ name: "OLD_TOKEN", required: false, addedIn: "1.0.0" },
	],
	vars: [
		{ name: "ENV", required: false, addedIn: "1.0.0" },
		{ name: "NEW_FLAG", required: false, addedIn: "1.2.0" },
	],
	kvNamespaces: [
		{ binding: "RATE_LIMITS", required: true },
		{ binding: "NEW_KV", required: true },
	],
	d1Databases: [
		{ binding: "DB", databaseName: "garrul-db", required: true },
	],
	analyticsDatasets: [],
	migrations: ["0001_init.sql", "0002_notifications.sql", "0003_new.sql"],
	// Cumulative in the real manifest, so the target always carries entries the
	// installed version is already past. `OLD_BREAK` is the 1.0.0 operator's
	// "nothing to do" case; `NEW_BREAK` is the one they have to act on.
	breakingChanges: [
		{
			id: "OLD_BREAK",
			summary: "already handled on the way to 1.0.0",
			manualSteps: ["nothing to do"],
			addedIn: "1.0.0",
		},
		{
			id: "NEW_BREAK",
			summary: "the target release needs a manual step",
			manualSteps: ["do the thing"],
			addedIn: "1.2.0",
		},
	],
};

const makeWranglerMock = (): typeof wranglerModule => ({
	listSecrets: vi.fn(() => ["JWT_SECRET"]),
	parseWranglerToml: vi.fn(() => ({
		kvBindings: ["RATE_LIMITS"],
		d1Bindings: ["DB"],
		analyticsBindings: [],
		varNames: ["ENV"],
		raw: "",
	})),
	queryAppliedMigrations: vi.fn(() => [
		"0001_init.sql",
		"0002_notifications.sql",
	]),
	wranglerVersion: vi.fn(() => "wrangler 4.0.0"),
	createKvNamespace: vi.fn(),
	createD1Database: vi.fn(),
	putSecret: vi.fn(),
	appendKvBlock: vi.fn(),
	appendD1Block: vi.fn(),
	npmRun: vi.fn(),
	npmCi: vi.fn(),
	appendUpgradeLog: vi.fn(),
});

const makeGitMock = (): typeof gitModule => ({
	isClean: vi.fn(() => true),
	currentTag: vi.fn(() => null),
	fetchTags: vi.fn(),
	checkout: vi.fn(),
	parseRemote: vi.fn(() => ({ owner: "kingpin", repo: "garrul" })),
});

const fetchLatest = vi.fn(async () => ({
	tag: "v1.2.0",
	url: "https://github.com/kingpin/garrul/releases/tag/v1.2.0",
	notes: "## Highlights\n- new shiny thing",
}));
const fetchReleaseForTag = vi.fn(async (_o: string, _r: string, tag: string) => ({
	tag,
	url: `https://github.com/kingpin/garrul/releases/tag/${tag}`,
	notes: "## Highlights\n- new shiny thing",
}));
const fetchTargetManifest = vi.fn(
	async (): Promise<Manifest> => structuredClone(fakeTargetManifest),
);

// Inject a low local version so this test stays valid across release bumps.
// Without injection, loadLocal reads the real release-manifest.json from
// disk; when that version equals the test's target version, the upgrade
// script early-returns ("nothing to do") and never calls fetchTargetManifest.
// `vars` is narrowed to ENV so NEW_FLAG reads as introduced by the target —
// that's the case the "new optional settings" report exists for.
const loadLocal = vi.fn(
	(): Manifest => ({
		...structuredClone(fakeTargetManifest),
		version: "1.0.0",
		vars: [{ name: "ENV", required: false, addedIn: "1.0.0" }],
	}),
);

describe("upgrade dry-run", () => {
	let wranglerMock: typeof wranglerModule;
	let gitMock: typeof gitModule;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		wranglerMock = makeWranglerMock();
		gitMock = makeGitMock();
		fetchLatest.mockClear();
		fetchReleaseForTag.mockClear();
		fetchTargetManifest.mockClear();
		loadLocal.mockClear();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
	});

	afterEach(() => {
		logSpy.mockRestore();
		stdoutSpy.mockRestore();
	});

	it("never calls any mutating wrangler/git function in --dry-run mode", async () => {
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		expect(wranglerMock.createKvNamespace).not.toHaveBeenCalled();
		expect(wranglerMock.createD1Database).not.toHaveBeenCalled();
		expect(wranglerMock.putSecret).not.toHaveBeenCalled();
		expect(wranglerMock.appendKvBlock).not.toHaveBeenCalled();
		expect(wranglerMock.appendD1Block).not.toHaveBeenCalled();
		expect(wranglerMock.npmRun).not.toHaveBeenCalled();
		expect(wranglerMock.npmCi).not.toHaveBeenCalled();
		expect(wranglerMock.appendUpgradeLog).not.toHaveBeenCalled();
		expect(gitMock.fetchTags).not.toHaveBeenCalled();
		expect(gitMock.checkout).not.toHaveBeenCalled();
	});

	it("reads target manifest exactly once", async () => {
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		expect(fetchTargetManifest).toHaveBeenCalledTimes(1);
		expect(fetchTargetManifest).toHaveBeenCalledWith(
			"kingpin",
			"garrul",
			"v1.2.0",
		);
	});

	it("targets the version passed via --version, skipping releases/latest", async () => {
		await main(["--dry-run", "--version", "v1.2.0"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		expect(fetchLatest).not.toHaveBeenCalled();
		expect(fetchReleaseForTag).toHaveBeenCalledWith(
			"kingpin",
			"garrul",
			"v1.2.0",
		);
		expect(fetchTargetManifest).toHaveBeenCalledWith(
			"kingpin",
			"garrul",
			"v1.2.0",
		);
	});

	it("prints release notes before the plan", async () => {
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		const output: string = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toMatch(/Release notes \(v1\.2\.0\):/);
		expect(output).toMatch(/new shiny thing/);
		expect(output.indexOf("Release notes")).toBeLessThan(
			output.indexOf("Plan: 1.0.0"),
		);
	});

	it("reports vars the target release added that are not set", async () => {
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		const output: string = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toMatch(/New optional settings since 1\.0\.0/);
		expect(output).toMatch(/• NEW_FLAG \[1\.2\.0\]/);
		// ENV predates the installed release and is already set in wrangler.toml
		// — announcing it would make the section noise on every upgrade.
		expect(output).not.toMatch(/• ENV\b/);
		// All vars are optional, so nothing is reported as a hard requirement.
		expect(output).not.toMatch(/Missing required wrangler\.toml/);
	});

	it("reports optional secrets the target release added", async () => {
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		const output: string = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toMatch(/New optional secrets since 1\.0\.0/);
		expect(output).toMatch(/• NEW_TOKEN \[1\.2\.0\]/);
		// Predates the installed release and is deliberately unset — repeating it
		// on every upgrade would train operators to skip the section.
		expect(output).not.toMatch(/• OLD_TOKEN\b/);
		// Optional, so it must never be filed under the required-secrets heading.
		// Scoped to that section's bullets — a whole-output match would also see
		// the new-optional-secrets section further down and always pass.
		const lines = output.split("\n");
		const start = lines.indexOf("Missing required secrets:");
		expect(start).toBeGreaterThan(-1);
		const after = lines.slice(start + 1);
		const end = after.findIndex((l) => !l.startsWith("  • "));
		const requiredBullets = end === -1 ? after : after.slice(0, end);
		expect(requiredBullets).toEqual(["  • NEW_SECRET"]);
	});

	it("prints only the breaking changes the operator has not crossed", async () => {
		// The whole point of the filter: before it, a 2.5.0 → 2.7.0 hop printed
		// all nine historical entries, including eight from 2.0.0 that the
		// operator had already done to get there.
		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest,
			loadLocal,
		});

		const output: string = logSpy.mock.calls
			.map((c: unknown[]) => c.join(" "))
			.join("\n");
		expect(output).toMatch(/Breaking changes since 1\.0\.0 — manual steps/);
		expect(output).toMatch(/• \[NEW_BREAK\] \[1\.2\.0\]/);
		expect(output).toMatch(/do the thing/);
		expect(output).not.toMatch(/NEW_BREAK.*OLD_BREAK/s);
		expect(output).not.toMatch(/OLD_BREAK/);
		expect(output).not.toMatch(/nothing to do/);
	});

	it("omits the breaking-changes section entirely when none apply", async () => {
		// The 2.5.0 → 2.7.1 case: the heading itself must not print, or the
		// operator still stops to read a section with nothing in it.
		const current = vi.fn(
			(): Manifest => ({
				...structuredClone(fakeTargetManifest),
				version: "1.1.0",
				vars: [{ name: "ENV", required: false, addedIn: "1.0.0" }],
			}),
		);
		const targetNoBreaks = vi.fn(async (): Promise<Manifest> => {
			const m = structuredClone(fakeTargetManifest);
			m.breakingChanges = m.breakingChanges.filter(
				(bc) => bc.addedIn === "1.0.0",
			);
			return m;
		});

		await main(["--dry-run"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag,
			fetchTargetManifest: targetNoBreaks,
			loadLocal: current,
		});

		const output: string = logSpy.mock.calls
			.map((c: unknown[]) => c.join(" "))
			.join("\n");
		expect(output).toMatch(/Plan: 1\.1\.0 → 1\.2\.0/);
		expect(output).not.toMatch(/Breaking changes/);
	});

	it("tolerates a missing GitHub release (404)", async () => {
		const missing = vi.fn(async () => null);
		await main(["--dry-run", "--version", "v1.2.0"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchReleaseForTag: missing,
			fetchTargetManifest,
			loadLocal,
		});

		const output: string = logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
		expect(output).toMatch(/no GitHub release published/);
	});

	it("hard-errors when --version is passed without an argument", async () => {
		await expect(
			main(["--dry-run", "--version"], {
				wrangler: wranglerMock,
				git: gitMock,
				fetchLatest,
				fetchTargetManifest,
			}),
		).rejects.toThrow(/--version requires a tag argument/);
	});

	it("hard-errors when --version's argument is another flag", async () => {
		await expect(
			main(["--dry-run", "--version", "--yes"], {
				wrangler: wranglerMock,
				git: gitMock,
				fetchLatest,
				fetchTargetManifest,
			}),
		).rejects.toThrow(/--version requires a tag argument/);
	});
});
