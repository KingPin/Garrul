/**
 * End-to-end dry-run smoke for the upgrade orchestrator. Drives main()
 * with fully mocked deps. The key invariant: --dry-run must not call any
 * mutating wrangler or git function, full stop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { main } from "../scripts/upgrade";
import type * as wranglerModule from "../scripts/upgrade/wrangler";
import {
	SubprocessError,
	WranglerReadError,
	describeFailure,
} from "../scripts/upgrade/wrangler";
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
		// Two `mustEdit` vars: the operator has edited one and not the other.
		{
			name: "PUBLIC_BASE_URL",
			required: false,
			addedIn: "1.0.0",
			placeholder: "https://comments.example.com",
		},
		{
			name: "ALLOWED_ORIGINS",
			required: false,
			addedIn: "1.0.0",
			placeholder: "https://yourblog.example.com",
		},
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
	// Error classes and the pure formatter are the real ones: main() does an
	// `instanceof WranglerReadError`, so a mocked class would never match.
	SubprocessError,
	WranglerReadError,
	describeFailure,
	checkAuth: vi.fn(() => ({ ok: true }) as wranglerModule.AuthStatus),
	listSecrets: vi.fn(() => ["JWT_SECRET"]),
	parseWranglerToml: vi.fn(() => ({
		kvBindings: ["RATE_LIMITS"],
		d1Bindings: ["DB"],
		analyticsBindings: [],
		varNames: ["ENV", "PUBLIC_BASE_URL", "ALLOWED_ORIGINS"],
		vars: {
			ENV: "production",
			PUBLIC_BASE_URL: "https://comments.example.com",
			ALLOWED_ORIGINS: "https://mysite.dev",
		},
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

	it("warns about vars still set to the shipped example value", async () => {
		// The gap this closes: every var is `required: false`, so drift detection
		// can never flag one — and these are *set*, just set to the template's
		// value. Nothing else in the upgrade path looks at values at all.
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
		expect(output).toMatch(/Still set to the example value/);
		expect(output).toMatch(/• PUBLIC_BASE_URL = "https:\/\/comments\.example\.com"/);
		// Edited to a real origin — silence is the whole point of comparing
		// against the value rather than against presence.
		expect(output).not.toMatch(/• ALLOWED_ORIGINS/);
		// Warning, not blocker: the plan still printed and the run reached the
		// dry-run exit rather than the "refusing to apply" path.
		expect(output).toMatch(/\(dry-run; no changes applied\)/);
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

/**
 * The 2.23.0 incident: an expired `wrangler login` made every live read fail,
 * every failure was swallowed as "nothing there", and the operator was shown
 * a plan to re-enter four secrets and re-run all 23 migrations. These pin the
 * three layers that now stand in the way: preflight refuses to start, a read
 * failure during drift detection stops the run with the cause, and a plan
 * that still comes out all-missing on a configured install carries a warning.
 */
describe("upgrade refuses to plan against a deployment it cannot read", () => {
	let wranglerMock: typeof wranglerModule;
	let gitMock: typeof gitModule;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;

	const deps = () => ({
		wrangler: wranglerMock,
		git: gitMock,
		fetchLatest,
		fetchReleaseForTag,
		fetchTargetManifest,
		loadLocal,
	});
	const joined = (spy: ReturnType<typeof vi.spyOn>): string =>
		spy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");

	beforeEach(() => {
		wranglerMock = makeWranglerMock();
		gitMock = makeGitMock();
		fetchLatest.mockClear();
		fetchTargetManifest.mockClear();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		// main() calls process.exit(1) on a refusal; throwing here lets the
		// test observe the refusal and prove nothing ran after it.
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code) => {
			throw new Error(`process.exit(${code})`);
		}) as (code?: number | string | null) => never);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		stdoutSpy.mockRestore();
		exitSpy.mockRestore();
	});

	it("stops in preflight when wrangler is not logged in, before any fetch", async () => {
		vi.mocked(wranglerMock.checkAuth).mockReturnValue({
			ok: false,
			reason: "not_logged_in",
			detail: "wrangler whoami: You are not authenticated.",
		});

		await expect(main(["--dry-run"], deps())).rejects.toThrow(
			/process\.exit\(1\)/,
		);

		expect(fetchLatest).not.toHaveBeenCalled();
		expect(fetchTargetManifest).not.toHaveBeenCalled();
		expect(wranglerMock.listSecrets).not.toHaveBeenCalled();
		expect(wranglerMock.queryAppliedMigrations).not.toHaveBeenCalled();

		const err = joined(errSpy);
		expect(err).toMatch(/Wrangler is not logged in to Cloudflare/);
		expect(err).toMatch(/npx wrangler login/);
		expect(err).toMatch(/CLOUDFLARE_API_TOKEN/);
		expect(err).toMatch(/Nothing was changed/);
		// No plan of any kind was printed.
		expect(joined(logSpy)).not.toMatch(/Plan:/);
	});

	it("names the wrangler failure when whoami itself cannot run", async () => {
		vi.mocked(wranglerMock.checkAuth).mockReturnValue({
			ok: false,
			reason: "whoami_failed",
			detail: "getaddrinfo ENOTFOUND api.cloudflare.com",
		});

		await expect(main(["--dry-run"], deps())).rejects.toThrow(
			/process\.exit\(1\)/,
		);
		const err = joined(errSpy);
		expect(err).toMatch(/could not check who is logged in/);
		expect(err).toMatch(/ENOTFOUND api\.cloudflare\.com/);
	});

	it("stops during drift detection when a live read fails, with wrangler's own text", async () => {
		vi.mocked(wranglerMock.listSecrets).mockImplementation(() => {
			throw new WranglerReadError(
				"list the Worker's secrets",
				new SubprocessError(
					"npx",
					["wrangler", "secret", "list"],
					1,
					"",
					"✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/garrul/secrets) failed. workers.api.error.script_not_found [code: 10007]",
				),
			);
		});

		await expect(main(["--dry-run"], deps())).rejects.toThrow(
			/process\.exit\(1\)/,
		);

		const err = joined(errSpy);
		expect(err).toMatch(/could not list the Worker's secrets/);
		expect(err).toMatch(/script_not_found/);
		expect(err).toMatch(/Already logged in\?/);
		expect(joined(logSpy)).not.toMatch(/Missing required secrets/);
	});

	it("lets a non-wrangler error out of drift detection untouched", async () => {
		vi.mocked(wranglerMock.listSecrets).mockImplementation(() => {
			throw new TypeError("boom");
		});
		await expect(main(["--dry-run"], deps())).rejects.toThrow(/boom/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("does not query D1 for a binding wrangler.toml does not have yet", async () => {
		// A first-ever run: setup.sh has not created the database, so there is
		// nothing to read and asking wrangler about the binding would fail.
		(wranglerMock.parseWranglerToml as ReturnType<typeof vi.fn>).mockReturnValue({
			kvBindings: ["RATE_LIMITS"],
			d1Bindings: [],
			analyticsBindings: [],
			varNames: ["ENV"],
			vars: { ENV: "production" },
			raw: "",
		});
		vi.mocked(wranglerMock.queryAppliedMigrations).mockImplementation(() => {
			throw new Error("should not be called");
		});

		await main(["--dry-run"], deps());

		expect(wranglerMock.queryAppliedMigrations).not.toHaveBeenCalled();
		const out = joined(logSpy);
		expect(out).toMatch(/Missing D1 databases/);
		expect(out).toMatch(/Pending migrations: 3/);
		// All-missing on a *fresh* install is the expected shape, not suspicious.
		expect(out).not.toMatch(/reads like a brand-new install/);
	});

	it("warns when a configured install reads as entirely missing", async () => {
		vi.mocked(wranglerMock.listSecrets).mockReturnValue([]);
		vi.mocked(wranglerMock.queryAppliedMigrations).mockReturnValue([]);

		await main(["--dry-run"], deps());

		const out = joined(logSpy);
		expect(out).toMatch(/reads like a brand-new install, but it is not one/);
		expect(out).toMatch(/npx wrangler whoami/);
		// The warning sits above the drift lists it is warning about.
		expect(out.indexOf("brand-new install")).toBeLessThan(
			out.indexOf("Missing required secrets"),
		);
	});

	it("does not warn when only some drift is present", async () => {
		await main(["--dry-run"], deps());
		expect(joined(logSpy)).not.toMatch(/brand-new install/);
	});
});
