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
 * Preflight requires a Cloudflare login (`wrangler whoami`) before anything
 * is fetched or read. The drift plan is built from live reads of the Worker's
 * secrets and the D1 `_migrations` table; if either read fails the run stops
 * with the wrangler error instead of treating the deployment as empty. The
 * one exception is a D1 database with no `_migrations` table at all, which is
 * a fresh install and legitimately has zero applied migrations.
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
	manifestDiffKeys,
	manifestsEqual,
	parseSemver,
	type Manifest,
} from "./upgrade/manifest";
import { plainText, releaseNotesLines } from "./upgrade/plain-text";
import {
	diffSecrets,
	diffVars,
	newVarsSince,
	newSecretsSince,
	placeholderVars,
	breakingChangesSince,
	diffKv,
	diffD1,
	diffMigrations,
	diffRenderer,
	hasMutations,
	blocksAutoApply,
	looksLikeLostInstall,
	type Plan,
} from "./upgrade/drift";
import * as wranglerModule from "./upgrade/wrangler";
import { WranglerReadError } from "./upgrade/wrangler";
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
	// `tag` and `html_url` are printed too, so they get the same stripping as the
	// body. The fallback URL interpolates `tag`, which is why it is cleaned here
	// at the boundary rather than at each print site.
	return {
		tag: plainText(tag),
		url: plainText(
			typeof (body as { html_url?: unknown }).html_url === "string"
				? (body as { html_url: string }).html_url
				: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
		),
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
	// The release body is attacker-controlled free text on exactly the same
	// terms as the manifest descriptions below, and it prints FIRST — so a
	// cursor-movement sequence here can rewrite the "Breaking changes — manual
	// steps required" block that appears further down, before the operator ever
	// reaches `confirm("Proceed?")`. plain-text.ts strips the escapes and caps
	// the volume so the body can't scroll the plan out of the terminal either.
	const { lines, truncated } = releaseNotesLines(info.notes);
	for (const line of lines) {
		console.log(`  ${line}`);
	}
	if (truncated > 0) {
		console.log("");
		console.log(
			`  … ${truncated} more line(s) not shown — read the full notes at ${info.url}`,
		);
	}
};

const computePlan = (
	current: Manifest,
	target: Manifest,
	wrangler: typeof wranglerModule,
): Plan => {
	const toml = wrangler.parseWranglerToml(REPO_ROOT);
	const presentSecrets = wrangler.listSecrets();
	// By binding, not by database_name: the operator names their own D1.
	const targetDb = target.d1Databases[0]?.binding ?? "DB";
	// No block in wrangler.toml means the database is about to be created by
	// this run (plan.d1.missing); nothing can be applied on it yet, and asking
	// wrangler about an unbound binding is an error, not an empty answer.
	const applied = toml.d1Bindings.includes(targetDb)
		? wrangler.queryAppliedMigrations(targetDb, true)
		: [];

	return {
		secrets: diffSecrets(presentSecrets, target.secrets),
		vars: diffVars(toml.varNames, target.vars),
		newVars: newVarsSince(toml.varNames, current.version, target.vars),
		newSecrets: newSecretsSince(
			presentSecrets,
			current.version,
			target.secrets,
		),
		placeholders: placeholderVars(toml.vars, target.vars),
		kv: diffKv(toml.kvBindings, target.kvNamespaces),
		d1: diffD1(toml.d1Bindings, target.d1Databases),
		migrations: diffMigrations(applied, target.migrations),
		renderer: diffRenderer(current.renderer.version, target),
		breakingChanges: breakingChangesSince(
			current.version,
			target.breakingChanges,
		),
	};
};

/**
 * Printed when the plan cannot be trusted because wrangler could not read the
 * live deployment. Every line is for an operator at a terminal: what went
 * wrong, why the run stopped instead of showing a plan, and the two ways to
 * fix it. The `detail` is wrangler's own text so the fix matches the cause.
 */
const printCannotReachCloudflare = (
	headline: string,
	detail: string,
	opts: { maybeMisconfigured: boolean },
): void => {
	console.error("");
	console.error(`✘ ${headline}`);
	console.error("");
	console.error(`  wrangler said: ${detail}`);
	console.error("");
	console.error(
		"  The upgrade plan is a comparison against your live Worker — its",
	);
	console.error(
		"  secrets and the migrations already applied to your D1 database.",
	);
	console.error(
		"  Without that reading, every secret would show as missing and every",
	);
	console.error(
		"  migration as pending, so nothing is shown rather than a wrong plan.",
	);
	console.error("");
	console.error("  To fix it, do one of these and then re-run `npm run upgrade`:");
	console.error("");
	console.error("    • At a terminal:   npx wrangler login");
	console.error("      (also the fix when a previous login has expired)");
	console.error("    • In CI or a script:   export CLOUDFLARE_API_TOKEN=<token>");
	console.error(
		"      Token needs Workers Scripts:Edit and D1:Edit on this account.",
	);
	if (opts.maybeMisconfigured) {
		console.error(
			"    • Already logged in?  Check that `name`, `account_id` and the D1",
		);
		console.error(
			"      `database_id` in wrangler.toml are the ones for this deployment.",
		);
	}
	console.error("");
	console.error(
		"  Nothing was changed. Your Worker, database and secrets are as they were.",
	);
};

const printPlan = (current: Manifest, target: Manifest, plan: Plan): void => {
	console.log("");
	console.log(`Plan: ${current.version} → ${target.version}`);
	console.log("");

	if (looksLikeLostInstall(plan, target)) {
		console.log("⚠ This plan reads like a brand-new install, but it is not one:");
		console.log(
			"  wrangler.toml already names a D1 database, yet every required",
		);
		console.log(
			"  secret shows as missing and every migration as pending. On an",
		);
		console.log(
			"  instance that has been running, that usually means wrangler is",
		);
		console.log(
			"  talking to the wrong account or Worker — check `npx wrangler whoami`",
		);
		console.log(
			"  and the `name` / `account_id` in wrangler.toml before answering yes.",
		);
		console.log("");
	}
	if (plan.placeholders.length > 0) {
		// First, not last: this is a "your instance is misconfigured right now"
		// warning rather than anything about the upgrade, and burying it under
		// the new-optional-settings list is how it goes unread. Printed before
		// the confirm prompt either way — see plain-text.ts.
		console.log(
			"Still set to the example value shipped in wrangler.example.toml:",
		);
		for (const v of plan.placeholders) {
			const desc = v.description ? ` — ${v.description}` : "";
			console.log(`  • ${v.name} = "${v.value}"${desc}`);
		}
		console.log(
			"  (a deploy with these will pass every check here and then fail at",
		);
		console.log(
			"   runtime — CORS rejections and redirect_uri_mismatch. Not blocking:",
		);
		console.log("   ignore this if example.com really is your domain.)");
		console.log("");
	}
	if (plan.secrets.missing.length > 0) {
		console.log("Missing required secrets:");
		for (const s of plan.secrets.missing) {
			const desc = s.description ? ` — ${s.description}` : "";
			console.log(`  • ${s.name}${desc}`);
		}
	}
	if (plan.newSecrets.length > 0) {
		// Optional by definition, so this is the only place they surface —
		// `diffSecrets` filters `missing` on `required` and never sees them.
		console.log(`New optional secrets since ${current.version}:`);
		for (const s of plan.newSecrets) {
			const desc = s.description ? ` — ${s.description}` : "";
			const added = s.addedIn ? ` [${s.addedIn}]` : "";
			console.log(`  • ${s.name}${added}${desc}`);
		}
		console.log(
			"  (opt-in; set the ones you want with `wrangler secret put <NAME>`)",
		);
	}
	if (plan.vars.missing.length > 0) {
		console.log("Missing required wrangler.toml [vars] (set these by hand):");
		for (const v of plan.vars.missing) {
			const desc = v.description ? ` — ${v.description}` : "";
			console.log(`  • ${v.name}${desc}`);
		}
	}
	if (plan.newVars.length > 0) {
		// "since", not "in this release" — an upgrade can span several tags.
		console.log(
			`New optional settings since ${current.version} (wrangler.toml [vars]):`,
		);
		for (const v of plan.newVars) {
			const desc = v.description ? ` — ${v.description}` : "";
			const added = v.addedIn ? ` [${v.addedIn}]` : "";
			console.log(`  • ${v.name}${added}${desc}`);
		}
		console.log("  (all have defaults; set only the ones you want to change)");
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
		// "since", not "in this release" — an upgrade can span several tags.
		console.log(
			`Breaking changes since ${current.version} — manual steps required:`,
		);
		for (const bc of plan.breakingChanges) {
			const added = bc.addedIn ? ` [${bc.addedIn}]` : "";
			console.log(`  • [${bc.id}]${added} ${bc.summary}`);
			for (const s of bc.manualSteps) console.log(`      ${s}`);
		}
	}
	// `vars` and `newSecrets` are counted here but not in hasMutations(): they
	// are reported, never applied, so they must not make the plan look like a
	// no-op.
	if (
		!hasMutations(plan) &&
		!plan.renderer.bumped &&
		plan.newVars.length === 0 &&
		plan.newSecrets.length === 0 &&
		plan.vars.missing.length === 0
	) {
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
	readLocal: typeof loadLocal,
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

	// The plan the operator just approved — pending migrations, new secrets,
	// breaking changes, the renderer bump — was computed from the manifest
	// fetched over HTTPS from raw.githubusercontent at this tag. The code about
	// to be deployed arrived separately, over the git transport from their own
	// remote. Nothing until now checked that the two agree.
	//
	// This is the last point where that's cheap to check and still means
	// something: after this line come migrations against the production
	// database and a deploy. Both are hard to walk back, and a migration that
	// wasn't in the plan is the worst version of the surprise.
	//
	// It is not a signature, and it doesn't claim to be — an attacker who can
	// rewrite the tag rewrites both copies. What it does catch: a tag moved
	// between the fetch and the checkout, a stale or poisoned raw.git CDN
	// response, a fork whose tag doesn't carry the upstream tree, and the
	// ordinary case of a manifest that was never regenerated for the release.
	step("Verifying checkout matches the fetched manifest…");
	const checkedOut = readLocal(REPO_ROOT);
	if (checkedOut === null) {
		stepFail("no release-manifest.json in the checked-out tag");
		throw new Error(
			`${targetTag} has no release-manifest.json; refusing to migrate or deploy`,
		);
	}
	if (!manifestsEqual(checkedOut, target)) {
		const keys = manifestDiffKeys(checkedOut, target);
		stepFail(`checkout disagrees with the fetched manifest (${keys.join(", ")})`);
		console.error("");
		console.error(
			"!! The release-manifest.json in the checked-out tag is not the one\n" +
				"!! this upgrade plan was built from, so the plan you approved may not\n" +
				`!! describe what would be deployed. Differing fields: ${keys.join(", ")}\n` +
				"!! No migrations have run and nothing has been deployed.\n" +
				"!! Re-run `npm run upgrade`. If it persists, compare the tag against\n" +
				"!! the repository before continuing.",
		);
		throw new Error("manifest mismatch between fetched plan and checkout");
	}
	stepOk();

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
	// Before anything is fetched or compared: a logged-out wrangler used to
	// sail through here and surface only as an all-missing plan five steps
	// later, with nothing naming the real cause.
	const auth = wrangler.checkAuth();
	if (!auth.ok) {
		stepFail(
			auth.reason === "not_logged_in"
				? "wrangler is not logged in to Cloudflare"
				: "could not run `wrangler whoami`",
		);
		printCannotReachCloudflare(
			auth.reason === "not_logged_in"
				? "Wrangler is not logged in to Cloudflare."
				: "Wrangler could not check who is logged in.",
			auth.detail,
			{ maybeMisconfigured: auth.reason !== "not_logged_in" },
		);
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
	let plan: Plan;
	try {
		plan = computePlan(local, target, wrangler);
	} catch (err) {
		if (!(err instanceof WranglerReadError)) throw err;
		stepFail(`could not ${err.what}`);
		// Preflight already proved a login exists, so a failure here is more
		// likely a wrong Worker name or database id than a missing token.
		printCannotReachCloudflare(`Wrangler could not ${err.what}.`, err.detail, {
			maybeMisconfigured: true,
		});
		process.exit(1);
	}
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

	await applyPlan(
		plan,
		target,
		flags,
		wrangler,
		git,
		local.version,
		targetTag,
		readLocal,
	);

	console.log(`[upgrade] Upgraded ${local.version} → ${target.version}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((err) => {
		console.error("[upgrade] failed:", err);
		process.exit(1);
	});
}
