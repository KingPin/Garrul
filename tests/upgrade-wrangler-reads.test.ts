/**
 * The wrangler subprocess seam's *read* functions, driven through a mocked
 * spawnSync so the real output shapes can be replayed: `wrangler whoami`
 * exits 0 whether or not there is a login, `secret list` fails on stderr,
 * `d1 execute --json` fails with an error object on stdout and an empty
 * stderr. The shapes below are copied from wrangler 4.123.0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync: (...a: unknown[]) => spawnSync(...a) }));

import {
	checkAuth,
	listSecrets,
	queryAppliedMigrations,
	describeFailure,
	SubprocessError,
	WranglerReadError,
} from "../scripts/upgrade/wrangler";

const NOT_AUTH =
	"In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work. Please go to https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ for instructions on how to create an api token, and assign its value to CLOUDFLARE_API_TOKEN.";

const exits = (status: number, stdout = "", stderr = "") =>
	spawnSync.mockReturnValueOnce({ status, stdout, stderr, error: undefined });

const lastArgs = (): string[] =>
	(spawnSync.mock.calls.at(-1) as [string, string[]])[1];

beforeEach(() => {
	spawnSync.mockReset();
});

describe("checkAuth", () => {
	it("is ok for an OAuth login", () => {
		exits(
			0,
			" ⛅️ wrangler 4.123.0\n───\nGetting User settings...\n👋 You are logged in with an OAuth Token, associated with the email someone@example.com.\n",
		);
		expect(checkAuth()).toEqual({ ok: true });
		expect(lastArgs()).toEqual(["wrangler", "whoami"]);
	});

	it("is ok for an API token", () => {
		exits(0, "👋 You are logged in with an API Token, associated with the email someone@example.com.\n");
		expect(checkAuth()).toEqual({ ok: true });
	});

	it("reads a logged-out wrangler off stdout despite exit 0", () => {
		exits(
			0,
			" ⛅️ wrangler 4.123.0\n───\nGetting User settings...\nYou are not authenticated. Please run `wrangler login`.\nTo deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.\n",
		);
		const r = checkAuth();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("not_logged_in");
			expect(r.detail).toMatch(/not authenticated/);
		}
	});

	it("sees through colour codes", () => {
		exits(0, "\x1b[33mYou are not authenticated.\x1b[0m Please run `wrangler login`.\n");
		expect(checkAuth().ok).toBe(false);
	});

	it("reports the failure when whoami itself exits non-zero", () => {
		exits(1, "", "✘ [ERROR] getaddrinfo ENOTFOUND api.cloudflare.com\n");
		const r = checkAuth();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("whoami_failed");
			expect(r.detail).toBe("getaddrinfo ENOTFOUND api.cloudflare.com");
		}
	});

	it("reports the failure when wrangler cannot be spawned", () => {
		spawnSync.mockReturnValueOnce({
			status: null,
			stdout: "",
			stderr: "",
			error: new Error("spawnSync npx ENOENT"),
		});
		const r = checkAuth();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.detail).toMatch(/ENOENT/);
	});
});

describe("listSecrets", () => {
	it("returns the secret names", () => {
		exits(0, JSON.stringify([{ name: "JWT_SECRET", type: "secret_text" }, { name: "IP_HASH_SECRET", type: "secret_text" }]));
		expect(listSecrets()).toEqual(["JWT_SECRET", "IP_HASH_SECRET"]);
	});

	it("returns [] for a Worker with no secrets", () => {
		exits(0, "[]\n");
		expect(listSecrets()).toEqual([]);
	});

	it("throws WranglerReadError instead of [] when logged out", () => {
		exits(1, "\n", `\n\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1m${NOT_AUTH}\x1b[0m\n\n\n🪵  Logs were written to "/home/x/.wrangler/logs/wrangler-2026-09-04_01-21-59_882.log"\n`);
		let caught: unknown;
		try {
			listSecrets();
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WranglerReadError);
		const err = caught as WranglerReadError;
		expect(err.what).toBe("list the Worker's secrets");
		expect(err.detail).toBe(NOT_AUTH);
		expect(err.message).toMatch(/could not list the Worker's secrets: In a non-interactive/);
	});

	it("throws when the Worker does not exist", () => {
		exits(1, "", "✘ [ERROR] A request to the Cloudflare API (/accounts/abc/workers/scripts/garrul/secrets) failed.\n\n  workers.api.error.script_not_found [code: 10007]\n");
		expect(() => listSecrets()).toThrow(WranglerReadError);
		expect(() => {
			exits(1, "", "✘ [ERROR] A request to the Cloudflare API failed.\n");
			listSecrets();
		}).toThrow(/could not list the Worker's secrets: A request to the Cloudflare API failed\./);
	});

	it("throws on output that is not a JSON array", () => {
		exits(0, "Getting secrets…\n");
		expect(() => listSecrets()).toThrow(/parse `wrangler secret list` output/);
		exits(0, JSON.stringify({ error: "nope" }));
		expect(() => listSecrets()).toThrow(/expected a JSON array/);
	});
});

describe("queryAppliedMigrations", () => {
	it("returns the applied names", () => {
		exits(0, JSON.stringify([{ results: [{ name: "0001_init.sql" }, { name: "0002_notifications.sql" }], success: true, meta: {} }]));
		expect(queryAppliedMigrations("DB", true)).toEqual(["0001_init.sql", "0002_notifications.sql"]);
		expect(lastArgs()).toEqual(["wrangler", "d1", "execute", "DB", "--remote", "--json", "--command", "SELECT name FROM _migrations"]);
	});

	it("returns [] for a fresh database with no _migrations table", () => {
		exits(1, '\n{\n  "error": {\n    "text": "no such table: _migrations: SQLITE_ERROR"\n  }\n}\n', "");
		expect(queryAppliedMigrations("DB", true)).toEqual([]);
	});

	it("throws WranglerReadError instead of [] when logged out", () => {
		exits(1, `\n{\n  "error": {\n    "text": ${JSON.stringify(NOT_AUTH)}\n  }\n}\n`, "");
		let caught: unknown;
		try {
			queryAppliedMigrations("DB", true);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(WranglerReadError);
		const err = caught as WranglerReadError;
		expect(err.what).toBe("read applied migrations from D1 binding DB");
		expect(err.detail).toBe(NOT_AUTH);
	});

	it("throws when the database does not exist", () => {
		exits(1, '{"error":{"text":"Couldn\'t find a D1 DB with the name or binding \'DB\' in your wrangler.toml."}}', "");
		expect(() => queryAppliedMigrations("DB", true)).toThrow(/Couldn't find a D1 DB/);
	});

	it("throws on output without a results array", () => {
		exits(0, "[]");
		expect(() => queryAppliedMigrations("DB", true)).toThrow(/expected \[\{ results/);
		exits(0, "not json");
		expect(() => queryAppliedMigrations("DB", true)).toThrow(/parse `wrangler d1 execute` output/);
	});
});

describe("describeFailure", () => {
	it("prefers the --json error text on stdout", () => {
		const e = new SubprocessError("npx", ["wrangler"], 1, '{"error":{"text":"boom"}}', "ignored stderr");
		expect(describeFailure(e)).toBe("boom");
	});

	it("falls back to the first meaningful stderr line, de-prefixed and de-coloured", () => {
		const e = new SubprocessError("npx", ["wrangler"], 1, "", "\n\n\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mSomething broke\x1b[0m\n\nmore\n");
		expect(describeFailure(e)).toBe("Something broke");
	});

	it("falls back to stdout when stderr is empty and stdout is not JSON", () => {
		const e = new SubprocessError("npx", ["wrangler"], 1, "plain text failure\n", "");
		expect(describeFailure(e)).toBe("plain text failure");
	});

	it("reports the exit status when both streams are empty", () => {
		expect(describeFailure(new SubprocessError("npx", ["wrangler"], 3, "", ""))).toBe("exited with 3");
	});

	it("passes plain Errors and non-Errors through", () => {
		expect(describeFailure(new Error("x"))).toBe("x");
		expect(describeFailure("y")).toBe("y");
	});

	it("SubprocessError's message carries stdout when stderr is empty", () => {
		const e = new SubprocessError("npx", ["wrangler", "d1"], 1, '{"error":{"text":"boom"}}', "");
		expect(e.message).toMatch(/npx wrangler d1 exited with 1: \{"error"/);
	});
});
