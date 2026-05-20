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
	breakingChanges: [],
};

const makeWranglerMock = (): typeof wranglerModule => ({
	listSecrets: vi.fn(() => ["JWT_SECRET"]),
	parseWranglerToml: vi.fn(() => ({
		kvBindings: ["RATE_LIMITS"],
		d1Bindings: ["DB"],
		analyticsBindings: [],
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
}));
const fetchTargetManifest = vi.fn(
	async (): Promise<Manifest> => structuredClone(fakeTargetManifest),
);

// Inject a low local version so this test stays valid across release bumps.
// Without injection, loadLocal reads the real release-manifest.json from
// disk; when that version equals the test's target version, the upgrade
// script early-returns ("nothing to do") and never calls fetchTargetManifest.
const loadLocal = vi.fn(
	(): Manifest => ({ ...structuredClone(fakeTargetManifest), version: "1.0.0" }),
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

	it("targets the version passed via --version, skipping GitHub", async () => {
		await main(["--dry-run", "--version", "v1.2.0"], {
			wrangler: wranglerMock,
			git: gitMock,
			fetchLatest,
			fetchTargetManifest,
			loadLocal,
		});

		expect(fetchLatest).not.toHaveBeenCalled();
		expect(fetchTargetManifest).toHaveBeenCalledWith(
			"kingpin",
			"garrul",
			"v1.2.0",
		);
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
