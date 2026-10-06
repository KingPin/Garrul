/**
 * The release-notes section `npm run upgrade` prints before the drift plan.
 *
 * An upgrade can span many tags. The manifest already aggregates the infra
 * side across them (vars, secrets, migrations, breaking changes), but behavior
 * changes live only in release bodies — so printing just the target's body
 * hides everything an operator skipped. This covers every release in
 * (installed, target]: the newest bodies in full, older ones as a single
 * headline each, all under one total line cap so a long span (2.16 → 2.34 is
 * ~330 lines of bodies) can't scroll the plan out of the terminal.
 *
 * Everything here is attacker-controlled GitHub text: titles and bodies go
 * through `plainText`/`releaseNotesLines` before they are printed.
 */
import { compareSemver, isNewer, parseSemver } from "./manifest";
import { plainText, releaseNotesLines } from "./plain-text";

export type Release = {
	tag: string;
	/** The GitHub release name; older releases often carry the bare tag. */
	title: string | null;
	url: string;
	notes: string | null;
};

/** Newest releases in the range whose body prints in full. */
const FULL_BODIES = 3;
/** Older releases listed as one headline each before the overflow line. */
const MAX_TITLES = 20;
/** Cap on the whole section, whatever the bodies contain. */
const MAX_LINES = 100;
/** Cap on one headline, so a long title or summary stays on one row. */
const MAX_HEADLINE_LEN = 160;

const clamp = (s: string): string =>
	s.length > MAX_HEADLINE_LEN ? `${s.slice(0, MAX_HEADLINE_LEN)}…` : s;

/** Releases newer than `installed` and not newer than `target`, newest first. */
export const releasesInRange = (
	releases: Release[],
	installed: string,
	target: string,
): Release[] =>
	releases
		.filter(
			(r) =>
				parseSemver(r.tag) !== null &&
				isNewer(r.tag, installed) &&
				!isNewer(r.tag, target),
		)
		.sort((a, b) => compareSemver(b.tag, a.tag));

/**
 * One line naming the release. Titles follow `vX.Y.Z — <change>`; a release
 * from before that convention is titled with the bare tag, so its summary
 * falls back to the first body line that isn't a markdown heading.
 */
export const headline = (r: Release): string => {
	const title = plainText(r.title ?? "").trim();
	if (title && title !== r.tag) return clamp(title);
	const first = (r.notes ?? "")
		.split(/\r\n|\n|\r/)
		.map((l) => plainText(l).trim())
		.find((l) => l.length > 0 && !l.startsWith("#"));
	const summary = first?.replace(/^[-*>]\s+/, "").replaceAll("**", "");
	return clamp(summary ? `${r.tag} — ${summary}` : r.tag);
};

/**
 * The section as terminal-safe lines. `releases` is the already-ranged list,
 * newest first; `compareUrl` is the GitHub compare view for the full span
 * (code changes only), `releasesUrl` the releases page — the one place every
 * body the caps cut off can still be read.
 */
export const releaseNotesSection = (
	releases: Release[],
	compareUrl: string,
	releasesUrl: string,
): string[] => {
	if (releases.length === 0) {
		return ["  (no GitHub release published for this range)"];
	}
	const out: string[] = [];
	if (releases.length > 1) out.push(`  Compare: ${compareUrl}`);
	for (const r of releases.slice(0, FULL_BODIES)) {
		out.push("", `  ${headline(r)}`, `  ${r.url}`);
		if (!r.notes) {
			out.push("  (release has no description)");
			continue;
		}
		out.push("");
		for (const line of releaseNotesLines(r.notes).lines) out.push(`    ${line}`);
	}
	const older = releases.slice(FULL_BODIES);
	if (older.length > 0) {
		out.push("", "  Earlier releases in this upgrade:");
		for (const r of older.slice(0, MAX_TITLES)) out.push(`    ${headline(r)}`);
		const hidden = older.length - MAX_TITLES;
		if (hidden > 0) {
			out.push(`    … ${hidden} earlier release(s) — see ${releasesUrl}`);
		}
	}
	if (out.length <= MAX_LINES) return out;
	return [
		...out.slice(0, MAX_LINES),
		"",
		`  … ${out.length - MAX_LINES} more line(s) not shown — read the full notes at ${releasesUrl}`,
	];
};
