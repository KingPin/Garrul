/**
 * Subprocess seam for wrangler + npm. Tests vi.mock this entire module so
 * the orchestrator's plan/apply logic can be exercised without hitting
 * Cloudflare or the real filesystem.
 *
 * All subprocesses use spawnSync with shell:false (the default), so values
 * passed in the args array can't break out into shell metacharacters.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type RunOpts = { cwd?: string; inheritStdio?: boolean };

const run = (cmd: string, args: string[], opts: RunOpts = {}): string => {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	});
	if (r.error) throw r.error;
	if (typeof r.status === "number" && r.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(" ")} exited with ${r.status}: ${r.stderr ?? ""}`,
		);
	}
	return typeof r.stdout === "string" ? r.stdout : "";
};

const wrangler = (args: string[], opts: RunOpts = {}): string =>
	run("npx", ["wrangler", ...args], opts);

export const listSecrets = (): string[] => {
	try {
		const out = wrangler(["secret", "list", "--format", "json"]);
		const parsed: unknown = JSON.parse(out);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((row) => {
				if (
					typeof row === "object" &&
					row !== null &&
					typeof (row as { name?: unknown }).name === "string"
				) {
					return (row as { name: string }).name;
				}
				return null;
			})
			.filter((n): n is string => n !== null);
	} catch {
		return [];
	}
};

export type WranglerToml = {
	kvBindings: string[];
	d1Bindings: string[];
	analyticsBindings: string[];
	raw: string;
};

const TOML_PATH = "wrangler.toml";

export const parseWranglerToml = (repoRoot: string): WranglerToml => {
	const path = join(repoRoot, TOML_PATH);
	if (!existsSync(path)) {
		throw new Error(
			`${TOML_PATH} not found at ${path} — run scripts/setup.sh first`,
		);
	}
	const raw = readFileSync(path, "utf8");
	const grabBindings = (blockHeader: string): string[] => {
		const re = new RegExp(
			String.raw`\[\[${blockHeader}\]\][\s\S]*?binding\s*=\s*"([^"]+)"`,
			"g",
		);
		const out: string[] = [];
		let m: RegExpExecArray | null = re.exec(raw);
		while (m !== null) {
			out.push(m[1] as string);
			m = re.exec(raw);
		}
		return out;
	};
	return {
		kvBindings: grabBindings("kv_namespaces"),
		d1Bindings: grabBindings("d1_databases"),
		analyticsBindings: grabBindings("analytics_engine_datasets"),
		raw,
	};
};

const matchCreatedId = (out: string): string | null => {
	const tomlForm = /\bid\s*=\s*"([0-9a-f]{16,})"/.exec(out);
	if (tomlForm) return tomlForm[1] as string;
	const jsonForm = /"id"\s*:\s*"([0-9a-f]{16,})"/.exec(out);
	if (jsonForm) return jsonForm[1] as string;
	return null;
};

const matchCreatedD1Id = (out: string): string | null => {
	const tomlForm = /\bdatabase_id\s*=\s*"([0-9a-f-]{16,})"/.exec(out);
	if (tomlForm) return tomlForm[1] as string;
	const jsonForm = /"uuid"\s*:\s*"([0-9a-f-]{16,})"/.exec(out);
	if (jsonForm) return jsonForm[1] as string;
	return null;
};

export const createKvNamespace = (binding: string): string => {
	const out = wrangler(["kv", "namespace", "create", binding]);
	const id = matchCreatedId(out);
	if (!id) {
		throw new Error(
			`could not parse created KV namespace id from wrangler output:\n${out}`,
		);
	}
	return id;
};

export const createD1Database = (databaseName: string): string => {
	const out = wrangler(["d1", "create", databaseName]);
	const id = matchCreatedD1Id(out);
	if (!id) {
		throw new Error(
			`could not parse created D1 database id from wrangler output:\n${out}`,
		);
	}
	return id;
};

export const appendKvBlock = (
	repoRoot: string,
	binding: string,
	id: string,
): void => {
	const path = join(repoRoot, TOML_PATH);
	const block = `\n# added by upgrade\n[[kv_namespaces]]\nbinding = "${binding}"\nid = "${id}"\n`;
	appendFileSync(path, block);
};

export const appendD1Block = (
	repoRoot: string,
	binding: string,
	databaseName: string,
	databaseId: string,
): void => {
	const path = join(repoRoot, TOML_PATH);
	const block = `\n# added by upgrade\n[[d1_databases]]\nbinding = "${binding}"\ndatabase_name = "${databaseName}"\ndatabase_id = "${databaseId}"\n`;
	appendFileSync(path, block);
};

export const putSecret = (name: string): void => {
	wrangler(["secret", "put", name], { inheritStdio: true });
};

export const queryAppliedMigrations = (
	databaseName: string,
	remote: boolean,
): string[] => {
	try {
		const out = wrangler([
			"d1",
			"execute",
			databaseName,
			remote ? "--remote" : "--local",
			"--json",
			"--command",
			"SELECT name FROM _migrations",
		]);
		const parsed: unknown = JSON.parse(out);
		if (!Array.isArray(parsed)) return [];
		const first = parsed[0] as unknown;
		if (
			typeof first !== "object" ||
			first === null ||
			!Array.isArray((first as { results?: unknown[] }).results)
		) {
			return [];
		}
		const rows = (first as { results: unknown[] }).results;
		return rows
			.map((r) => {
				if (
					typeof r === "object" &&
					r !== null &&
					typeof (r as { name?: unknown }).name === "string"
				) {
					return (r as { name: string }).name;
				}
				return null;
			})
			.filter((n): n is string => n !== null);
	} catch {
		return [];
	}
};

export const npmRun = (script: string, extraArgs: string[] = []): void => {
	const args = ["run", script];
	if (extraArgs.length > 0) args.push("--", ...extraArgs);
	run("npm", args, { inheritStdio: true });
};

/**
 * Install deps for an upgrade. Prefers `npm ci` for reproducibility, falls
 * back to `npm install` if there's no lockfile (e.g. shallow clone). This
 * is intentionally NOT routed through `npmRun` — `npm run install` runs
 * a package script named "install", not the install subcommand.
 */
export const npmCi = (repoRoot: string): void => {
	const lockfile = join(repoRoot, "package-lock.json");
	const sub = existsSync(lockfile) ? "ci" : "install";
	run("npm", [sub], { inheritStdio: true });
};

/**
 * Append one JSON line to .garrul-upgrade-log.json (gitignored, audit only).
 */
export const appendUpgradeLog = (
	repoRoot: string,
	entry: Record<string, unknown>,
): void => {
	const path = join(repoRoot, ".garrul-upgrade-log.json");
	const line = `${JSON.stringify({ ...entry, ts: Date.now() })}\n`;
	if (existsSync(path)) {
		appendFileSync(path, line);
	} else {
		writeFileSync(path, line);
	}
};

export const wranglerVersion = (): string | null => {
	try {
		return run("npx", ["wrangler", "--version"]).trim();
	} catch {
		return null;
	}
};
