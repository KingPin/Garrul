#!/usr/bin/env tsx
/**
 * One-command upgrade: pulls the latest tagged release, detects config
 * drift against the new manifest, applies migrations, deploys.
 *
 *   npm run upgrade                # interactive, latest GitHub release
 *   npm run upgrade -- --dry-run   # plan only, no changes
 *   npm run upgrade -- --yes       # non-interactive (CI); secrets must be pre-set
 *   npm run upgrade -- --version v0.0.2
 *
 * Interactive flow prints the GitHub release notes (when available) and
 * the drift plan, then asks for confirmation. `--yes` skips that prompt.
 *
 * Flags:
 *   --dry-run            Print the plan and exit; no side effects.
 *   --yes                Skip confirmations. Missing secrets become hard errors.
 *   --version vX.Y.Z     Target a specific tag (defaults to latest release).
 *   --allow-dirty        Skip the clean-tree precondition.
 *   --skip-migrations    Don't run `npm run migrate`.
 *   --skip-deploy        Don't run `npm run deploy`.
 *   --rerender           Force eager comment re-render after deploy.
 *
 * Exit codes:
 *   0   success (including "already on latest")
 *   1   plan refused (drift can't be auto-applied, preflight failed, etc.)
 *   2   migrations applied but deploy failed — see message; previous Worker
 *       still serves traffic until you re-deploy or `wrangler rollback`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadLocal,
	fetchRemote,
	compareSemver,
	isNewer,
	parseSemver,
	type Manifest,
} from "./upgrade/manifest";
import {
	diffSecrets,
	diffKv,
	diffD1,
	diffMigrations,
	diffRenderer,
	hasMutations,
	blocksAutoApply,
	type Plan,
} from "./upgrade/drift";
import * as wranglerModule from "./upgrade/wrangler";
import * as gitModule from "./upgrade/git";
import { confirm } from "./upgrade/prompt";
import { buildManifest } from "./upgrade/build-manifest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

type Flags = {
	dryRun: boolean;
	yes: boolean;
	version: string | null;
	allowDirty: boolean;
	skipMigrations: boolean;
	skipDeploy: boolean;
	rerender: boolean;
};

const parseFlags = (argv: string[]): Flags => {
	const flags: Flags = {
		dryRun: argv.includes("--dry-run"),
		yes: argv.includes("--yes"),
		version: null,
		allowDirty: argv.includes("--allow-dirty"),
		skipMigrations: argv.includes("--skip-migrations"),
		skipDeploy: argv.includes("--skip-deploy"),
		rerender: argv.includes("--rerender"),
	};
	const vIdx = argv.indexOf("--version");
	if (vIdx >= 0) {
		const next = vIdx + 1 < argv.length ? argv[vIdx + 1] : undefined;
		if (next === undefined || next.startsWith("--")) {
			throw new Error(
				"--version requires a tag argument, e.g. --version v0.2.0",
			);
		}
		flags.version = next;
	}
	return flags;
};

const step = (msg: string): void => {
	process.stdout.write(`→ ${msg}`);
};
const stepOk = (suffix = "OK"): void => {
	process.stdout.write(` ${suffix}\n`);
};
const stepFail = (suffix: string): void => {
	process.stdout.write(` FAIL\n  ${suffix}\n`);
};

type ReleaseInfo = { tag: string; url: string; notes: string | null };

const parseReleaseResponse = (
	body: unknown,
	owner: string,
	repo: string,
): ReleaseInfo => {
	if (
		typeof body !== "object" ||
		body === null ||
		typeof (body as { tag_name?: unknown }).tag_name !== "string"
	) {
		throw new Error("GitHub release response missing tag_name");
	}
	const tag = (body as { tag_name: string }).tag_name;
	const rawNotes = (body as { body?: unknown }).body;
	const notes =
		typeof rawNotes === "string" && rawNotes.trim().length > 0
			? rawNotes
			: null;
	return {
		tag,
		url:
			typeof (body as { html_url?: unknown }).html_url === "string"
				? ((body as { html_url: string }).html_url)
				: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
		notes,
	};
};

const fetchLatestRelease = async (
	owner: string,
	repo: string,
): Promise<ReleaseInfo> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/releases/latest`,
		{ headers: { Accept: "application/vnd.github+json" } },
	);
	if (!res.ok) {
		throw new Error(
			`GitHub releases/latest returned ${res.status} for ${owner}/${repo}`,
		);
	}
	return parseReleaseResponse(await res.json(), owner, repo);
};

const fetchReleaseForTag = async (
	owner: string,
	repo: string,
	tag: string,
): Promise<ReleaseInfo | null> => {
	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
		{ headers: { Accept: "application/vnd.github+json" } },
	);
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(
			`GitHub releases/tags/${tag} returned ${res.status} for ${owner}/${repo}`,
		);
	}
	return parseReleaseResponse(await res.json(), owner, repo);
};

const printReleaseNotes = (info: ReleaseInfo | null, tag: string): void => {
	console.log("");
	console.log(`Release notes (${tag}):`);
	if (!info) {
		console.log("  (no GitHub release published for this tag)");
		return;
	}
	console.log(`  ${info.url}`);
	if (!info.notes) {
		console.log("  (release has no description)");
		return;
	}
	console.log("");
	for (const line of info.notes.replace(/\r\n/g, "\n").split("\n")) {
		console.log(`  ${line}`);
	}
};

const computePlan = (
	current: Manifest,
	target: Manifest,
	wrangler: typeof wranglerModule,
): Plan => {
	const toml = wrangler.parseWranglerToml(REPO_ROOT);
	const presentSecrets = wrangler.listSecrets();
	const targetDb = target.d1Databases[0]?.databaseName ?? "garrul-db";
	const applied = wrangler.queryAppliedMigrations(targetDb, true);

	return {
		secrets: diffSecrets(presentSecrets, target.secrets),
		kv: diffKv(toml.kvBindings, target.kvNamespaces),
		d1: diffD1(toml.d1Bindings, target.d1Databases),
		migrations: diffMigrations(applied, target.migrations),
		renderer: diffRenderer(current.renderer.version, target),
		breakingChanges: target.breakingChanges,
	};
};

const printPlan = (current: Manifest, target: Manifest, plan: Plan): void => {
	console.log("");
	console.log(`Plan: ${current.version} → ${target.version}`);
	console.log("");

	if (plan.secrets.missing.length > 0) {
		console.log("Missing required secrets:");
		for (const s of plan.secrets.missing) {
			const desc = s.description ? ` — ${s.description}` : "";
			console.log(`  • ${s.name}${desc}`);
		}
	}
	if (plan.kv.missing.length > 0) {
		console.log("Missing KV namespaces (will be created):");
		for (const k of plan.kv.missing) {
			const desc = k.description ? ` — ${k.description}` : "";
			console.log(`  • ${k.binding}${desc}`);
		}
	}
	if (plan.d1.missing.length > 0) {
		console.log("Missing D1 databases (will be created):");
		for (const d of plan.d1.missing) {
			console.log(`  • ${d.binding} (${d.databaseName})`);
		}
	}
	if (plan.migrations.pending.length > 0) {
		console.log(`Pending migrations: ${plan.migrations.pending.length}`);
		for (const m of plan.migrations.pending) console.log(`  • ${m}`);
	}
	if (plan.migrations.diverged.length > 0) {
		console.log("Diverged migrations (live DB has migrations target doesn't):");
		for (const m of plan.migrations.diverged) console.log(`  • ${m}`);
	}
	if (plan.renderer.bumped) {
		console.log(
			`Renderer version: ${plan.renderer.current} → ${plan.renderer.target}${plan.renderer.eager ? " (eager re-render recommended)" : ""}`,
		);
	}
	if (plan.breakingChanges.length > 0) {
		console.log("");
		console.log("Breaking changes — manual steps required:");
		for (const bc of plan.breakingChanges) {
			console.log(`  • [${bc.id}] ${bc.summary}`);
			for (const s of bc.manualSteps) console.log(`      ${s}`);
		}
	}
	if (!hasMutations(plan) && !plan.renderer.bumped) {
		console.log("(no infra changes; code-only release)");
	}
	console.log("");
};

const applyPlan = async (
	plan: Plan,
	target: Manifest,
	flags: Flags,
	wrangler: typeof wranglerModule,
	git: typeof gitModule,
	fromVersion: string,
	targetTag: string,
): Promise<{ migratedNames: string[] }> => {
	for (const k of plan.kv.missing) {
		step(`Creating KV namespace ${k.binding}…`);
		const id = wrangler.createKvNamespace(k.binding);
		wrangler.appendKvBlock(REPO_ROOT, k.binding, id);
		stepOk(`id=${id}`);
	}
	for (const d of plan.d1.missing) {
		step(`Creating D1 database ${d.databaseName}…`);
		const id = wrangler.createD1Database(d.databaseName);
		wrangler.appendD1Block(REPO_ROOT, d.binding, d.databaseName, id);
		stepOk(`id=${id}`);
	}
	for (const s of plan.secrets.missing) {
		if (flags.yes) {
			throw new Error(
				`secret ${s.name} is required but --yes was passed; pre-create it with \`wrangler secret put ${s.name}\` before retrying`,
			);
		}
		console.log(`→ Setting secret ${s.name} (interactive)`);
		wrangler.putSecret(s.name);
	}

	step("Checking out target tag…");
	if (!flags.allowDirty && !git.isClean(REPO_ROOT)) {
		stepFail("working tree is dirty");
		throw new Error("dirty tree at apply time");
	}
	git.fetchTags(REPO_ROOT);
	git.checkout(targetTag, REPO_ROOT);
	stepOk(targetTag);

	step("Installing dependencies (npm ci)…");
	wrangler.npmCi(REPO_ROOT);
	stepOk();

	let migratedNames: string[] = [];
	if (!flags.skipMigrations && plan.migrations.pending.length > 0) {
		step(`Applying ${plan.migrations.pending.length} migration(s)…`);
		try {
			wrangler.npmRun("migrate", ["--remote"]);
			migratedNames = plan.migrations.pending;
			stepOk();
		} catch (err) {
			stepFail(`migrate failed: ${(err as Error).message}`);
			throw err;
		}
	}

	if (!flags.skipDeploy) {
		step("Deploying Worker…");
		try {
			wrangler.npmRun("deploy");
			stepOk();
		} catch (err) {
			stepFail(`deploy failed: ${(err as Error).message}`);
			console.error("");
			console.error(
				"!! Migrations may have applied but the deploy did not.\n" +
					"!! The previous Worker is still serving traffic.\n" +
					"!! Re-run `npm run deploy` after fixing, or `wrangler rollback`\n" +
					"!! to roll back to the prior deployment. Do NOT manually revert\n" +
					"!! the database — migrations are additive and forward-only.",
			);
			wrangler.appendUpgradeLog(REPO_ROOT, {
				from: fromVersion,
				to: target.version,
				outcome: "deploy_failed_after_migrate",
				migrationsApplied: migratedNames,
			});
			process.exit(2);
		}
	}

	if (
		!flags.skipDeploy &&
		(plan.renderer.bumped && (plan.renderer.eager || flags.rerender))
	) {
		step("Re-rendering comments…");
		try {
			wrangler.npmRun("rerender", ["--remote"]);
			stepOk();
		} catch (err) {
			console.warn(`[upgrade] rerender failed: ${(err as Error).message}`);
		}
	}

	wrangler.appendUpgradeLog(REPO_ROOT, {
		from: fromVersion,
		to: target.version,
		outcome: "ok",
		migrationsApplied: migratedNames,
		kvCreated: plan.kv.missing.map((k) => k.binding),
		d1Created: plan.d1.missing.map((d) => d.binding),
		secretsSet: plan.secrets.missing.map((s) => s.name),
	});

	return { migratedNames };
};

export const main = async (
	argv = process.argv.slice(2),
	deps: {
		wrangler?: typeof wranglerModule;
		git?: typeof gitModule;
		fetchLatest?: typeof fetchLatestRelease;
		fetchReleaseForTag?: typeof fetchReleaseForTag;
		fetchTargetManifest?: typeof fetchRemote;
		loadLocal?: typeof loadLocal;
	} = {},
): Promise<void> => {
	const wrangler = deps.wrangler ?? wranglerModule;
	const git = deps.git ?? gitModule;
	const fetchLatest = deps.fetchLatest ?? fetchLatestRelease;
	const fetchReleaseTag = deps.fetchReleaseForTag ?? fetchReleaseForTag;
	const fetchTargetManifest = deps.fetchTargetManifest ?? fetchRemote;
	const readLocal = deps.loadLocal ?? loadLocal;
	const flags = parseFlags(argv);

	step("Preflight checks…");
	const wv = wrangler.wranglerVersion();
	if (!wv) {
		stepFail("wrangler not found — run `npm install` first");
		process.exit(1);
	}
	if (!flags.allowDirty && !git.isClean(REPO_ROOT)) {
		stepFail("working tree is dirty (use --allow-dirty to override)");
		process.exit(1);
	}
	stepOk();

	step("Resolving target version…");
	const remote = git.parseRemote(REPO_ROOT);
	const local =
		readLocal(REPO_ROOT) ??
		(() => {
			console.warn("\n[upgrade] no local release-manifest.json; deriving from source");
			return buildManifest();
		})();

	let targetTag: string;
	let release: ReleaseInfo | null = null;
	if (flags.version) {
		if (!parseSemver(flags.version)) {
			stepFail(`bad --version: ${flags.version}`);
			process.exit(1);
		}
		targetTag = flags.version.startsWith("v") ? flags.version : `v${flags.version}`;
	} else {
		const latest = await fetchLatest(remote.owner, remote.repo);
		targetTag = latest.tag;
		release = latest;
	}
	stepOk(targetTag);

	const targetVersion = targetTag.replace(/^v/, "");
	if (compareSemver(targetVersion, local.version) === 0) {
		console.log(`[upgrade] already on ${local.version}; nothing to do`);
		return;
	}
	if (!isNewer(targetVersion, local.version)) {
		console.error(
			`[upgrade] target ${targetVersion} is older than installed ${local.version}; refusing`,
		);
		process.exit(1);
	}

	step("Fetching target manifest…");
	const target = await fetchTargetManifest(remote.owner, remote.repo, targetTag);
	stepOk();

	if (release === null) {
		step("Fetching release notes…");
		try {
			release = await fetchReleaseTag(remote.owner, remote.repo, targetTag);
			stepOk(release ? "OK" : "none");
		} catch (err) {
			stepOk(`skipped (${(err as Error).message})`);
		}
	}

	if (compareSemver(local.version, target.minPreviousVersion) < 0) {
		console.error(
			`[upgrade] cannot upgrade ${local.version} → ${target.version} directly; ` +
				`first upgrade to ${target.minPreviousVersion} (target.minPreviousVersion)`,
		);
		process.exit(1);
	}

	step("Detecting drift…");
	const plan = computePlan(local, target, wrangler);
	stepOk();

	const blockers = blocksAutoApply(plan);
	if (blockers.length > 0) {
		console.error("");
		console.error("Refusing to apply — manual intervention required:");
		for (const b of blockers) console.error(`  • ${b}`);
		process.exit(1);
	}

	printReleaseNotes(release, targetTag);
	printPlan(local, target, plan);

	if (flags.dryRun) {
		console.log("(dry-run; no changes applied)");
		return;
	}

	if (!flags.yes) {
		const proceed = await confirm("Proceed?");
		if (!proceed) {
			console.log("[upgrade] aborted by user");
			process.exit(1);
		}
	}

	await applyPlan(plan, target, flags, wrangler, git, local.version, targetTag);

	console.log(`[upgrade] Upgraded ${local.version} → ${target.version}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error("[upgrade] failed:", err);
		process.exit(1);
	});
}
