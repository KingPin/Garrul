/**
 * Subprocess seam for wrangler + npm. Tests vi.mock this entire module so
 * the orchestrator's plan/apply logic can be exercised without hitting
 * Cloudflare or the real filesystem.
 *
 * All subprocesses use spawnSync with shell:false (the default), so values
 * passed in the args array can't break out into shell metacharacters.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTomlVars } from "./toml-vars";
import type { TomlVars } from "./toml-vars";

type RunOpts = { cwd?: string; inheritStdio?: boolean };

/**
 * A subprocess that exited non-zero. Carries both streams: `wrangler --json`
 * commands put their error object on *stdout* and leave stderr empty, so a
 * message built from stderr alone reads "exited with 1: " and nothing else.
 */
export class SubprocessError extends Error {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number;
	constructor(cmd: string, args: string[], status: number, stdout: string, stderr: string) {
		super(`${cmd} ${args.join(" ")} exited with ${status}: ${stderr || stdout}`);
		this.name = "SubprocessError";
		this.stdout = stdout;
		this.stderr = stderr;
		this.status = status;
	}
}

const run = (cmd: string, args: string[], opts: RunOpts = {}): string => {
	const r = spawnSync(cmd, args, {
		encoding: "utf8",
		stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	});
	if (r.error) throw r.error;
	if (typeof r.status === "number" && r.status !== 0) {
		throw new SubprocessError(
			cmd,
			args,
			r.status,
			typeof r.stdout === "string" ? r.stdout : "",
			typeof r.stderr === "string" ? r.stderr : "",
		);
	}
	return typeof r.stdout === "string" ? r.stdout : "";
};

const wrangler = (args: string[], opts: RunOpts = {}): string =>
	run("npx", ["wrangler", ...args], opts);

/** Terminal colour codes: wrangler colours its error output even when piped. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * The one line of a failed wrangler command worth showing an operator. Prefers
 * the `error.text` of a `--json` error object (D1), then the first non-empty
 * stderr line with wrangler's `✘ [ERROR]` prefix and colour codes removed.
 */
export const describeFailure = (err: unknown): string => {
	if (err instanceof SubprocessError) {
		try {
			const parsed: unknown = JSON.parse(err.stdout);
			const text = (parsed as { error?: { text?: unknown } })?.error?.text;
			if (typeof text === "string" && text.trim()) return text.trim();
		} catch {
			// stdout was not JSON; fall through to stderr
		}
		const line = `${err.stderr}\n${err.stdout}`
			.replace(ANSI_RE, "")
			.split("\n")
			.map((l) => l.replace(/^\s*✘?\s*\[ERROR\]\s*/, "").trim())
			.find((l) => l.length > 0);
		if (line) return line;
		return `exited with ${err.status}`;
	}
	if (err instanceof Error) return err.message;
	return String(err);
};

/**
 * Raised when a *read* of live Cloudflare state fails. The upgrade plan is a
 * diff against that state, so a failed read must stop the run — an empty
 * answer would print "everything is missing" and offer to redo the install.
 */
export class WranglerReadError extends Error {
	readonly what: string;
	readonly detail: string;
	constructor(what: string, cause: unknown) {
		const detail = describeFailure(cause);
		super(`could not ${what}: ${detail}`);
		this.name = "WranglerReadError";
		this.what = what;
		this.detail = detail;
	}
}

export type AuthStatus =
	| { ok: true }
	| { ok: false; reason: "not_logged_in" | "whoami_failed"; detail: string };

/**
 * `wrangler whoami` exits 0 whether or not there is a login, so the verdict
 * has to come from its output. An expired OAuth token also lands here: the
 * refresh happens lazily and a failed refresh leaves wrangler logged out.
 */
export const checkAuth = (): AuthStatus => {
	let out: string;
	try {
		out = wrangler(["whoami"]);
	} catch (err) {
		return { ok: false, reason: "whoami_failed", detail: describeFailure(err) };
	}
	const line = out
		.replace(ANSI_RE, "")
		.split("\n")
		.map((l) => l.trim())
		.find((l) => /not authenticated/i.test(l));
	if (line !== undefined) {
		return { ok: false, reason: "not_logged_in", detail: line };
	}
	return { ok: true };
};

const names = (rows: unknown[]): string[] =>
	rows
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

export const listSecrets = (): string[] => {
	let out: string;
	try {
		out = wrangler(["secret", "list", "--format", "json"]);
	} catch (err) {
		throw new WranglerReadError("list the Worker's secrets", err);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch (err) {
		throw new WranglerReadError("parse `wrangler secret list` output", err);
	}
	if (!Array.isArray(parsed)) {
		throw new WranglerReadError(
			"parse `wrangler secret list` output",
			new Error("expected a JSON array"),
		);
	}
	return names(parsed);
};

export type WranglerToml = {
	kvBindings: string[];
	d1Bindings: string[];
	analyticsBindings: string[];
	/**
	 * Keys set under the top-level `[vars]`. Used to report newly available
	 * settings. Environment-scoped tables (`[env.production.vars]`) are
	 * deliberately not merged in — that would need real TOML parsing, and no
	 * var is `required` today, so the worst case is an informational report
	 * naming a setting the operator has already set in an env block.
	 */
	varNames: string[];
	/** The same table with its values, for the shipped-placeholder check. */
	vars: TomlVars;
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
	const vars = parseTomlVars(raw);

	return {
		kvBindings: grabBindings("kv_namespaces"),
		d1Bindings: grabBindings("d1_databases"),
		analyticsBindings: grabBindings("analytics_engine_datasets"),
		varNames: Object.keys(vars),
		vars,
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

/**
 * `database` is a name *or* a binding — `wrangler d1 execute` accepts
 * either. Callers pass the binding: it is the half this repo owns, while
 * `database_name` is whatever the operator typed at setup.
 *
 * Exactly one failure means "zero applied": a database that has no
 * `_migrations` table yet, which is what a freshly created D1 looks like.
 * Everything else — no login, wrong database, network — throws. Until
 * v2.24 every failure returned `[]`, and an expired wrangler login produced a
 * plan that offered to re-run all migrations and re-enter every secret.
 */
export const queryAppliedMigrations = (
	database: string,
	remote: boolean,
): string[] => {
	let out: string;
	try {
		out = wrangler([
			"d1",
			"execute",
			database,
			remote ? "--remote" : "--local",
			"--json",
			"--command",
			"SELECT name FROM _migrations",
		]);
	} catch (err) {
		if (/no such table: _migrations/i.test(describeFailure(err))) return [];
		throw new WranglerReadError(
			`read applied migrations from D1 binding ${database}`,
			err,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch (err) {
		throw new WranglerReadError("parse `wrangler d1 execute` output", err);
	}
	const first = Array.isArray(parsed) ? (parsed[0] as unknown) : undefined;
	if (
		typeof first !== "object" ||
		first === null ||
		!Array.isArray((first as { results?: unknown[] }).results)
	) {
		throw new WranglerReadError(
			"parse `wrangler d1 execute` output",
			new Error("expected [{ results: [...] }]"),
		);
	}
	return names((first as { results: unknown[] }).results);
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
	// appendFileSync creates the file when it is missing, so no exists-check —
	// the check/write pair was also a TOCTOU race (CodeQL js/file-system-race).
	appendFileSync(path, line);
};

export const wranglerVersion = (): string | null => {
	try {
		return run("npx", ["wrangler", "--version"]).trim();
	} catch {
		return null;
	}
};
