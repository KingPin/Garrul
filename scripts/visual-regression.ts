#!/usr/bin/env tsx
/**
 * Widget visual regression: renders the working tree's widget and a baseline
 * ref's widget side by side in headless Chromium and pixel-diffs the shots.
 *
 *   npm run vr                    # baseline = main
 *   npm run vr -- --base v2.16.0  # baseline = any git ref
 *   npm run vr -- --out <dir>     # keep artifacts somewhere specific
 *
 * The baseline is built from a throwaway detached git worktree (the repo's
 * node_modules symlinked in, the worktree's OWN build script run from inside
 * it — the build scripts resolve paths from import.meta.url, so running the
 * main repo's copy would rebuild the working tree regardless of cwd). The
 * working tree itself is never modified.
 *
 * Both bundles are mounted the way examples/plain-html/index.html mounts the
 * widget, against a local `wrangler dev` seeded with the demo thread, across
 * five theme scenarios. ImageMagick `compare -metric AE` counts changed
 * pixels per pair. Intentional diffs are normal: the script exits 0 whenever
 * the run completed and leaves every artifact in the run directory for
 * eyeballing. Nonzero exit means the harness itself failed (build, server,
 * screenshot, or compare).
 *
 * System prerequisites (deliberately no npm dependencies): /usr/bin/chromium,
 * ImageMagick (`compare`), python3. Ports 8787 (Worker) and 8080 (test pages)
 * must be free — the script refuses to start if either is taken.
 */
import {
	type ChildProcess,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CHROMIUM = "/usr/bin/chromium";
const WORKER_PORT = 8787;
const PAGES_PORT = 8080;
const SHOT_W = 900;
const SHOT_H = 2200;
const TOTAL_PX = SHOT_W * SHOT_H;
const VIRTUAL_TIME_BUDGET_MS = 9000;

// Cloudflare's public always-pass Turnstile test keys — documented public
// test values, not real credentials.
const DEV_VARS = [
	"ENV:dev",
	`ALLOWED_ORIGINS:http://localhost:${WORKER_PORT},http://localhost:${PAGES_PORT}`,
	"TURNSTILE_SITE_KEY:1x00000000000000000000AA",
	"TURNSTILE_SECRET:1x0000000000000000000000000000000AA",
];

type Scenario = {
	name: string;
	theme: "light" | "dark" | null;
	pageBg: string | null;
	turnstile: boolean;
};

// The exact scenario set the accessibility audits used, plus the forced
// Turnstile gate. Note that headless Chromium reports
// prefers-color-scheme: dark, so `auto` exercises the dark branch.
const SCENARIOS: Scenario[] = [
	{ name: "auto", theme: null, pageBg: null, turnstile: false },
	{ name: "light", theme: "light", pageBg: "#ffffff", turnstile: false },
	{ name: "dark", theme: "dark", pageBg: null, turnstile: false },
	// The a11y #49 case: light theme pinned on a near-black host page — the
	// widget must paint its own background rather than inherit transparency.
	{ name: "light-on-dark", theme: "light", pageBg: "#0a0a0a", turnstile: false },
	// `.gr-turnstile:empty { display:none }` hides the gate until Turnstile
	// mounts, and a --screenshot run can never focus the composer to arm it,
	// so the page appends a dummy .gr-turnstile-frame into the (open) shadow
	// root; --virtual-time-budget advances the timer.
	{ name: "turnstile", theme: null, pageBg: null, turnstile: true },
];

const BUNDLES = ["baseline", "current"] as const;
type Bundle = (typeof BUNDLES)[number];

const log = (msg: string) => console.log(`[vr] ${msg}`);
const fail = (msg: string): never => {
	console.error(`[vr] FAIL — ${msg}`);
	process.exit(1);
};
const sleep = (ms: number) =>
	new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

const run = (cmd: string, args: string[], cwd: string = ROOT): void => {
	execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

let baseRef = "main";
let outDir: string | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--base") {
		const v = argv[++i];
		if (!v) fail("--base requires a git ref");
		baseRef = v as string;
	} else if (arg === "--out") {
		const v = argv[++i];
		if (!v) fail("--out requires a directory");
		outDir = resolve(v as string);
	} else {
		fail(`unknown argument ${arg} (usage: npm run vr -- [--base <ref>] [--out <dir>])`);
	}
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

if (!existsSync(CHROMIUM)) fail(`${CHROMIUM} not found — install chromium.`);
for (const [cmd, args] of [
	["compare", ["-version"]],
	["python3", ["--version"]],
] as const) {
	if (spawnSync(cmd, args, { stdio: "ignore" }).status !== 0) {
		fail(`\`${cmd}\` not runnable — install ${cmd === "compare" ? "ImageMagick" : cmd}.`);
	}
}

const portInUse = (port: number): Promise<boolean> =>
	new Promise((resolvePort) => {
		const sock = connect({ port, host: "127.0.0.1" });
		sock.once("connect", () => {
			sock.destroy();
			resolvePort(true);
		});
		sock.once("error", () => resolvePort(false));
	});

const describePortHolder = (port: number): string => {
	for (const [cmd, args] of [
		["ss", ["-ltnp"]],
		["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]],
	] as const) {
		const res = spawnSync(cmd, args, { encoding: "utf8" });
		if (res.status === 0 && res.stdout) {
			const line = res.stdout
				.split("\n")
				.find((l) => l.includes(`:${port} `) || l.includes(`:${port}\t`));
			if (line) return line.trim();
		}
	}
	return "(holder unknown — install ss or lsof for details)";
};

for (const port of [WORKER_PORT, PAGES_PORT]) {
	if (await portInUse(port)) {
		fail(
			`port ${port} is already bound — not killing it. Holder:\n  ${describePortHolder(port)}\nStop that process (or your own dev server) and re-run.`,
		);
	}
}

if (outDir && (outDir === ROOT || outDir.startsWith(ROOT + sep))) {
	fail("--out must point outside the repo — the working tree stays clean.");
}
const runDir = outDir ?? mkdtempSync(join(tmpdir(), "garrul-vr-"));
mkdirSync(runDir, { recursive: true });
const shotsDir = join(runDir, "shots");
mkdirSync(shotsDir, { recursive: true });
log(`run dir: ${runDir}`);

// ---------------------------------------------------------------------------
// Cleanup plumbing — never leave a process holding 8787 or 8080, never leave
// the baseline worktree behind.
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
let worktreeDir: string | null = null;
let worktreeParent: string | null = null;
let cleaned = false;

const removeWorktree = (): void => {
	if (worktreeDir && existsSync(worktreeDir)) {
		spawnSync("git", ["worktree", "remove", "--force", worktreeDir], {
			cwd: ROOT,
			stdio: "ignore",
		});
	}
	worktreeDir = null;
	if (worktreeParent) {
		rmSync(worktreeParent, { recursive: true, force: true });
		worktreeParent = null;
	}
};

const cleanup = async (): Promise<void> => {
	if (cleaned) return;
	cleaned = true;
	for (const child of children) {
		if (child.pid != null && child.exitCode === null) {
			// detached:true made each child a process-group leader, so a negative
			// pid signals the whole group (wrangler's workerd included).
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {}
		}
	}
	await sleep(1500);
	for (const child of children) {
		if (child.pid != null && child.exitCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	}
	removeWorktree();
};

process.on("SIGINT", () => {
	void cleanup().then(() => process.exit(130));
});
process.on("SIGTERM", () => {
	void cleanup().then(() => process.exit(143));
});

const waitForHttp = async (
	url: string,
	timeoutMs: number,
	label: string,
	proc?: ChildProcess,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (proc && proc.exitCode !== null) {
			throw new Error(`${label} exited early (code ${proc.exitCode}) — see logs in ${runDir}`);
		}
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {}
		await sleep(500);
	}
	throw new Error(`${label} not ready at ${url} within ${timeoutMs / 1000}s`);
};

// ---------------------------------------------------------------------------
// Test pages
// ---------------------------------------------------------------------------

const TURNSTILE_ARM_SCRIPT = `
<script>
	// Force the Turnstile gate visible: append a dummy frame into the widget's
	// open shadow root once the composer has mounted. Retries because the
	// widget mounts after a network round-trip; chromium's
	// --virtual-time-budget advances these timers.
	(function arm(tries) {
		setTimeout(function () {
			var host = document.getElementById("garrul");
			var slot = host && host.shadowRoot &&
				host.shadowRoot.querySelector(".gr-turnstile");
			if (slot) {
				var frame = document.createElement("iframe");
				frame.className = "gr-turnstile-frame";
				slot.appendChild(frame);
				return;
			}
			if (tries > 0) arm(tries - 1);
		}, 1000);
	})(6);
</script>`;

const pageHtml = (s: Scenario, bundle: Bundle): string => {
	const themeAttr = s.theme ? ` data-theme="${s.theme}"` : "";
	const bg = s.pageBg ? ` background: ${s.pageBg};` : "";
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Garrul VR — ${s.name} (${bundle})</title>
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5;${bg} }
	</style>
</head>
<body>
	<div
		id="garrul"
		data-slug="welcome"
		data-api="http://localhost:${WORKER_PORT}"${themeAttr}
	></div>
	<script src="/embed.${bundle}.js" defer></script>${s.turnstile ? TURNSTILE_ARM_SCRIPT : ""}
</body>
</html>
`;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

try {
	// 1. Baseline bundle, built from a detached worktree of the base ref.
	log(`building baseline widget from ${baseRef} …`);
	worktreeParent = mkdtempSync(join(tmpdir(), "garrul-vr-wt-"));
	worktreeDir = join(worktreeParent, "baseline");
	run("git", ["worktree", "add", "--detach", worktreeDir, baseRef]);
	symlinkSync(join(ROOT, "node_modules"), join(worktreeDir, "node_modules"), "dir");
	// npm resolves scripts from the worktree's own package.json, so this runs
	// the worktree's scripts/build-embed.ts (and its build-styles prestep).
	run("npm", ["run", "build:embed"], worktreeDir);
	copyFileSync(join(worktreeDir, "dist/embed.js"), join(runDir, "embed.baseline.js"));
	removeWorktree();

	// 2. Current bundle from the working tree. build:assets rather than just
	// build:embed so wrangler dev's module imports (version.gen.ts,
	// agents.bundled.ts) exist too.
	log("building current widget from the working tree …");
	run("npm", ["run", "build:assets"]);
	copyFileSync(join(ROOT, "dist/embed.js"), join(runDir, "embed.current.js"));

	// 3. Local Worker: migrate + seed the demo thread, then wrangler dev.
	log("migrating and seeding local D1 …");
	run("npm", ["run", "migrate", "--", "--local"]);
	run("npm", ["run", "seed-demo"]);
	// The resolved-settings KV cache can go stale after settings-affecting
	// changes; delete it defensively (ignore failure — it may not exist).
	spawnSync(
		"npx",
		["wrangler", "kv", "key", "delete", "--binding", "TREE_CACHE", "--local", "settings:resolved"],
		{ cwd: ROOT, stdio: "ignore" },
	);

	log("starting wrangler dev …");
	const wranglerLog = openSync(join(runDir, "wrangler.log"), "w");
	const wrangler = spawn(
		"npx",
		[
			"wrangler",
			"dev",
			// The port in --local-upstream is required, not optional.
			"--local-upstream",
			`localhost:${WORKER_PORT}`,
			...DEV_VARS.flatMap((v) => ["--var", v]),
		],
		{ cwd: ROOT, detached: true, stdio: ["ignore", wranglerLog, wranglerLog] },
	);
	children.push(wrangler);
	await waitForHttp(
		`http://localhost:${WORKER_PORT}/api/v1/health`,
		120_000,
		"wrangler dev",
		wrangler,
	);

	// 4. Test pages + static server for them.
	for (const scenario of SCENARIOS) {
		for (const bundle of BUNDLES) {
			writeFileSync(
				join(runDir, `${scenario.name}.${bundle}.html`),
				pageHtml(scenario, bundle),
			);
		}
	}
	log("starting python3 http.server for the test pages …");
	const httpLog = openSync(join(runDir, "http.log"), "w");
	const pageServer = spawn(
		"python3",
		["-m", "http.server", String(PAGES_PORT), "--bind", "127.0.0.1"],
		{ cwd: runDir, detached: true, stdio: ["ignore", httpLog, httpLog] },
	);
	children.push(pageServer);
	await waitForHttp(
		`http://localhost:${PAGES_PORT}/embed.current.js`,
		15_000,
		"http.server",
		pageServer,
	);

	// 5. Screenshots.
	for (const scenario of SCENARIOS) {
		for (const bundle of BUNDLES) {
			const png = join(shotsDir, `${scenario.name}.${bundle}.png`);
			log(`shooting ${scenario.name} (${bundle}) …`);
			execFileSync(
				CHROMIUM,
				[
					"--headless",
					"--disable-gpu",
					"--no-sandbox",
					"--hide-scrollbars",
					`--user-data-dir=${join(runDir, "chromium-profile")}`,
					`--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
					`--window-size=${SHOT_W},${SHOT_H}`,
					`--screenshot=${png}`,
					`http://localhost:${PAGES_PORT}/${scenario.name}.${bundle}.html`,
				],
				{ stdio: ["ignore", "ignore", "pipe"], timeout: 90_000 },
			);
			if (!existsSync(png)) throw new Error(`chromium produced no screenshot for ${scenario.name} (${bundle})`);
		}
	}

	// 6. Diffs. Some ImageMagick Q16-HDRI builds (seen on 7.1.2-27) report the
	// AE metric scaled by QuantumRange — a 1-pixel difference prints 65535 —
	// so calibrate against a known 1-pixel diff and divide the readings.
	const detectAeScale = (): number => {
		const calA = join(runDir, "ae-cal-a.png");
		const calB = join(runDir, "ae-cal-b.png");
		const calD = join(runDir, "ae-cal-d.png");
		const mkA = spawnSync("magick", ["-size", "1x1", "xc:white", calA], { stdio: "ignore" });
		const mkB = spawnSync("magick", ["-size", "1x1", "xc:black", calB], { stdio: "ignore" });
		if (mkA.status !== 0 || mkB.status !== 0) return 1; // no `magick` — assume unscaled
		const cal = spawnSync("compare", ["-metric", "AE", calA, calB, calD], {
			encoding: "utf8",
		});
		const v = Number.parseFloat(cal.stderr.trim());
		return Number.isFinite(v) && v > 0 ? v : 1;
	};
	const aeScale = detectAeScale();

	type Row = { name: string; ae: number; pct: string; diff: string };
	const rows: Row[] = [];
	for (const scenario of SCENARIOS) {
		const basePng = join(shotsDir, `${scenario.name}.baseline.png`);
		const curPng = join(shotsDir, `${scenario.name}.current.png`);
		const diffPng = join(shotsDir, `${scenario.name}.diff.png`);
		const res = spawnSync("compare", ["-metric", "AE", basePng, curPng, diffPng], {
			encoding: "utf8",
		});
		// compare exits 0 (identical) or 1 (differs); 2 is an actual error.
		if (res.status !== 0 && res.status !== 1) {
			throw new Error(`compare failed for ${scenario.name}: ${res.stderr}`);
		}
		const aeRaw = Number.parseFloat(res.stderr.trim());
		if (!Number.isFinite(aeRaw)) {
			throw new Error(`compare emitted no AE count for ${scenario.name}: ${res.stderr}`);
		}
		const ae = Math.round(aeRaw / aeScale);
		rows.push({
			name: scenario.name,
			ae,
			pct: `${((ae / TOTAL_PX) * 100).toFixed(3)}%`,
			diff: diffPng,
		});
	}

	// 7. Report. Shots are shots/<scenario>.{baseline,current,diff}.png in the
	// run dir; intentional diffs are normal, so a completed run exits 0.
	log("");
	log("scenario         AE px      % changed   diff image");
	for (const r of rows) {
		log(
			`${r.name.padEnd(16)} ${String(r.ae).padStart(8)}   ${r.pct.padStart(8)}   ${r.diff}`,
		);
	}
	log("");
	log("note: headless chromium reports prefers-color-scheme: dark, so `auto` exercises the dark branch.");
	log(`baseline/current shots sit next to each diff in ${shotsDir}`);
	log(`run dir: ${runDir}`);
} catch (err) {
	console.error(`[vr] FAIL — ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
} finally {
	await cleanup();
}
