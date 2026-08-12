#!/usr/bin/env tsx
/**
 * Reports the embed.js gzip delta between the working tree and a base ref.
 *
 * `npm run size` answers "are we under the ceiling", which is a question you
 * only fail once, at the worst possible moment. This answers "did this change
 * make the bundle bigger, and by how much" — the question that actually keeps a
 * budget honest, because it puts the cost of a feature in front of review while
 * the trade is still being made (#79).
 *
 * Usage:  tsx scripts/bundle-delta.ts [baseRef]
 *         baseRef defaults to origin/$GITHUB_BASE_REF, then origin/main.
 *
 * This is informational and MUST NOT fail a build — the gate is `npm run size`.
 * A base commit that won't build, or a shallow clone that can't reach it, is a
 * missing baseline rather than a broken PR, so every failure path exits 0.
 *
 * When $GITHUB_STEP_SUMMARY is set the report is appended there too, so the
 * number lands on the PR's checks page instead of only in the log.
 */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT_GZ_BYTES = 30 * 1024;

const git = (args: string[]): string =>
	execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const kb = (n: number) => (n / 1024).toFixed(2);
const pctOfCeiling = (n: number) => ((n / LIMIT_GZ_BYTES) * 100).toFixed(1);

/**
 * Builds the widget bundle inside `checkout` and returns its gzipped size.
 *
 * The scripts are invoked from `checkout`, not from ROOT: build-styles and
 * build-embed both resolve their paths from their own `import.meta.url`, so
 * running ROOT's copies would rebuild — and overwrite — the working tree no
 * matter what `cwd` said.
 *
 * build-styles.ts only exists from the CSS extraction onward; a base commit
 * older than that builds fine without it.
 */
const measure = (checkout: string): number => {
	const run = (script: string) =>
		execFileSync("npx", ["tsx", join(checkout, script)], {
			cwd: checkout,
			stdio: "ignore",
		});
	if (existsSync(join(checkout, "scripts/build-styles.ts"))) {
		run("scripts/build-styles.ts");
	}
	run("scripts/build-embed.ts");
	return gzipSync(readFileSync(join(checkout, "dist/embed.js")), {
		level: 9,
	}).length;
};

const report = (lines: string[]): void => {
	for (const line of lines) console.log(`[delta] ${line}`);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) {
		appendFileSync(
			summary,
			`### Widget bundle size\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
		);
	}
};

const baseRef =
	process.argv[2] ??
	(process.env.GITHUB_BASE_REF
		? `origin/${process.env.GITHUB_BASE_REF}`
		: "origin/main");

const current = measure(ROOT);
const currentLine = `current   ${kb(current)} KB gz (${pctOfCeiling(current)}% of the ${kb(LIMIT_GZ_BYTES)} KB ceiling)`;

let worktree: string | undefined;
try {
	const baseSha = git(["rev-parse", baseRef]);

	// A detached worktree is the only way to build the baseline without
	// disturbing the working tree — the change under review stays put. Its
	// node_modules is a symlink to ours rather than a second install: the
	// baseline is a size measurement, not a dependency audit, and installing
	// twice per PR to shave bytes off a report would be its own kind of waste.
	worktree = mkdtempSync(join(tmpdir(), "garrul-bundle-base-"));
	git(["worktree", "add", "--detach", "--quiet", worktree, baseSha]);
	symlinkSync(join(ROOT, "node_modules"), join(worktree, "node_modules"));

	const base = measure(worktree);
	const diff = current - base;
	const sign = diff >= 0 ? "+" : "−";
	const pctDiff = base > 0 ? ((Math.abs(diff) / base) * 100).toFixed(1) : "0.0";

	report([
		currentLine,
		`base      ${kb(base)} KB gz (${baseRef} @ ${baseSha.slice(0, 7)})`,
		`delta     ${sign}${kb(Math.abs(diff))} KB (${sign}${pctDiff}%)`,
	]);
} catch (err) {
	// Never fail the build — see the header.
	const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
	report([
		currentLine,
		`baseline unavailable for ${baseRef} — delta not computed`,
		`reason: ${why}`,
	]);
} finally {
	if (worktree) {
		try {
			git(["worktree", "remove", "--force", worktree]);
		} catch {
			// Half-created worktree: drop the directory, then let git forget it.
			rmSync(worktree, { recursive: true, force: true });
			try {
				git(["worktree", "prune"]);
			} catch {
				// Nothing else to do; a stale entry is local to this checkout.
			}
		}
	}
}
