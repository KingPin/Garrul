/**
 * Thin git wrappers. All subprocesses go through node's execFile (no shell).
 * The upgrade orchestrator never accepts arbitrary refs from the network —
 * tags are matched against /^v?\d+\.\d+\.\d+/ before reaching this module.
 */
import { execFileSync as runFile } from "node:child_process";

type RunOpts = { cwd?: string };

const run = (args: string[], opts: RunOpts = {}): string =>
	runFile("git", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	}).trim();

export const isClean = (cwd?: string): boolean => {
	try {
		const out = run(["status", "--porcelain"], cwd ? { cwd } : {});
		return out.length === 0;
	} catch {
		return false;
	}
};

export const currentTag = (cwd?: string): string | null => {
	try {
		return run(["describe", "--tags", "--exact-match"], cwd ? { cwd } : {});
	} catch {
		return null;
	}
};

export const fetchTags = (cwd?: string): void => {
	// --force re-syncs local tags whose targets diverged from the remote
	// (e.g. a tag was re-pushed). Safe here: we only ever checkout tags
	// matching /^v?\d+\.\d+\.\d+/ and never push from this script.
	run(["fetch", "--tags", "--force"], cwd ? { cwd } : {});
};

export const checkout = (ref: string, cwd?: string): void => {
	if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
		throw new Error(`refusing to checkout suspicious ref: ${ref}`);
	}
	run(["checkout", ref], cwd ? { cwd } : {});
};

export type RemoteInfo = { owner: string; repo: string };

export const parseRemote = (cwd?: string): RemoteInfo => {
	const url = run(["remote", "get-url", "origin"], cwd ? { cwd } : {});
	const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
	if (!m) {
		throw new Error(`could not parse owner/repo from origin: ${url}`);
	}
	return { owner: m[1] as string, repo: m[2] as string };
};
