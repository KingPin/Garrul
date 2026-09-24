/**
 * The migration runner (src/db/migrate.ts), with wrangler mocked.
 *
 * `npm run migrate` must be idempotent: apply only the files missing from
 * _migrations, in filename order, record each one, and address D1 by its
 * `DB` binding rather than a database name the operator may have changed.
 * The module runs on import, so each case re-imports it.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({ execFileSync: (...a: unknown[]) => execFileSync(...a) }));

const FILES = readdirSync(join(__dirname, "../src/db/migrations"))
	.filter((f) => f.endsWith(".sql"))
	.sort();

const run = async (argv: string[], applied: string[] | "garbage") => {
	execFileSync.mockReset();
	execFileSync.mockImplementation((_cmd: string, args: string[]) => {
		const sql = args[args.indexOf("--command") + 1] ?? "";
		if (args.includes("--command") && sql.startsWith("SELECT name")) {
			return applied === "garbage" ? "not json" : JSON.stringify([{ results: applied.map((name) => ({ name })) }]);
		}
		return "[]";
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	const argvBefore = process.argv;
	process.argv = ["node", "migrate.ts", ...argv];
	vi.resetModules();
	try {
		await import("../src/db/migrate");
	} finally {
		process.argv = argvBefore;
	}
	const calls = execFileSync.mock.calls.map(([cmd, args]) => ({ cmd, args: args as string[] }));
	return {
		calls,
		appliedFiles: calls.filter((c) => c.args.includes("--file")).map((c) => c.args.at(-1)?.split("/").at(-1)),
		recorded: calls
			.map((c) => c.args.at(-1) as string)
			.filter((sql) => sql.startsWith("INSERT INTO _migrations"))
			.map((sql) => sql.match(/VALUES \('([^']+)'/)?.[1]),
	};
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("migration runner", () => {
	it("applies and records only the missing files, in order, against the local DB binding", async () => {
		const { calls, appliedFiles, recorded } = await run([], FILES.slice(0, 3));
		expect(appliedFiles).toEqual(FILES.slice(3));
		expect(recorded).toEqual(FILES.slice(3));
		for (const { cmd, args } of calls) {
			expect(cmd).toBe("wrangler");
			expect(args.slice(0, 4)).toEqual(["d1", "execute", "DB", "--local"]);
		}
	});

	it("targets --remote on request and applies nothing when up to date", async () => {
		const { calls, appliedFiles } = await run(["--remote"], FILES);
		expect(appliedFiles).toEqual([]);
		expect(calls.every((c) => c.args[3] === "--remote")).toBe(true);
	});

	it("aborts without applying anything when migration history is unreadable", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { appliedFiles } = await run([], "garbage");
		expect(appliedFiles).toEqual([]);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("exits 1 when wrangler fails", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
		execFileSync.mockReset();
		execFileSync.mockImplementation(() => {
			throw new Error("wrangler: not logged in");
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.resetModules();
		await import("../src/db/migrate");
		expect(exit).toHaveBeenCalledWith(1);
	});
});
