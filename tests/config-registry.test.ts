/**
 * The registry is the source of truth for every environment name Garrul
 * reads. These tests are the regression guard for the bug that motivated
 * it: `build-manifest.ts` used to classify any `string` field in `Bindings`
 * as a secret unless it appeared in a hardcoded 10-name allowlist. The
 * allowlist never grew as feature flags were added, so 20 plain `[vars]`
 * (`COMMENTS_PER_PAGE`, `VOTING_ENABLED`, `AUTO_CLOSE_DAYS`, …) ended up
 * recorded as secrets in the release contract.
 *
 * The failure was silent — an inverted allowlist that defaults to "secret"
 * misclassifies every future setting without ever erroring. The parity test
 * below turns that into a hard failure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_REGISTRY,
	SECRETS,
	VARS,
	REQUIRED_SECRET_NAMES,
	GENERATED_SECRET_NAMES,
} from "../scripts/config-registry";
import { assertRegistryMatchesBindings } from "../scripts/upgrade/build-manifest";

const REPO_ROOT = join(__dirname, "..");

/**
 * Same textual parse `build-manifest.ts` performs. `Bindings` is a type, so
 * it has no runtime form to import.
 */
const bindingStringFields = (): string[] => {
	const src = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
	const start = src.indexOf("export type Bindings");
	const open = src.indexOf("{", start);
	const close = src.indexOf("};", open);
	const body = src.slice(open + 1, close);
	const out: string[] = [];
	for (const line of body.split("\n")) {
		const m = /^([A-Z_][A-Z0-9_]*)\??:\s*([^;]+);?$/.exec(line.trim());
		if (m && (m[2] as string).trim() === "string") out.push(m[1] as string);
	}
	return out;
};

describe("registry ↔ Bindings parity", () => {
	it("covers every string field in Bindings, and nothing more", () => {
		const bindings = bindingStringFields().sort();
		const registry = CONFIG_REGISTRY.map((e) => e.name).sort();
		expect(registry).toEqual(bindings);
	});

	it("accepts the real Bindings set", () => {
		expect(() =>
			assertRegistryMatchesBindings(bindingStringFields()),
		).not.toThrow();
	});

	it("rejects a binding that was never registered", () => {
		expect(() =>
			assertRegistryMatchesBindings([
				...bindingStringFields(),
				"UNREGISTERED_FLAG",
			]),
		).toThrow(/missing from scripts\/config-registry\.ts.*UNREGISTERED_FLAG/s);
	});

	it("rejects a registry entry with no matching binding", () => {
		expect(() =>
			assertRegistryMatchesBindings(bindingStringFields().slice(1)),
		).toThrow(/missing from src\/index\.ts Bindings/);
	});
});

describe("registry shape", () => {
	it("has no duplicate names", () => {
		const names = CONFIG_REGISTRY.map((e) => e.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("splits cleanly into secrets and vars", () => {
		expect(SECRETS.length + VARS.length).toBe(CONFIG_REGISTRY.length);
	});

	it("gives every entry a group, hint, description, and addedIn", () => {
		for (const e of CONFIG_REGISTRY) {
			expect(e.group, `${e.name}.group`).toBeTruthy();
			expect(e.hint, `${e.name}.hint`).toBeTruthy();
			expect(e.description, `${e.name}.description`).toBeTruthy();
			expect(e.addedIn, `${e.name}.addedIn`).toMatch(/^\d+\.\d+\.\d+$/);
		}
	});

	it("marks only genuinely always-needed secrets required", () => {
		// Deliberately excludes the OAuth pairs: an instance running GitHub-only
		// login must not fail deploy over a missing DISCORD_CLIENT_SECRET.
		expect(REQUIRED_SECRET_NAMES).toEqual([
			"JWT_SECRET",
			"IP_HASH_SECRET",
			"TURNSTILE_SITE_KEY",
			"TURNSTILE_SECRET",
		]);
	});

	it("only marks secrets as generated, never vars", () => {
		expect(GENERATED_SECRET_NAMES).toEqual(["JWT_SECRET", "IP_HASH_SECRET"]);
		for (const e of VARS) expect(e.generate, `${e.name}`).toBeUndefined();
	});

	it("does not classify known-public feature flags as secrets", () => {
		// The exact names the old allowlist bug leaked into secrets[].
		const secretNames = new Set(SECRETS.map((e) => e.name));
		for (const name of [
			"COMMENTS_PER_PAGE",
			"VOTING_ENABLED",
			"DOWNVOTES_ENABLED",
			"AUTO_CLOSE_DAYS",
			"AUTO_CLOSE_AT",
			"COMMUNITY_MIN_VOTES",
			"COMMUNITY_COLLAPSE_RATIO",
			"SPAM_PROVIDER",
			"CF_ACCOUNT_ID",
			"TELEGRAM_BOT_USERNAME",
		]) {
			expect(secretNames.has(name), `${name} must be a var`).toBe(false);
		}
	});

	it("keeps credential-bearing names on the secret side", () => {
		const varNames = new Set(VARS.map((e) => e.name));
		for (const name of [
			"JWT_SECRET",
			"IP_HASH_SECRET",
			"TURNSTILE_SECRET",
			"GH_CLIENT_SECRET",
			"GOOGLE_CLIENT_SECRET",
			"FACEBOOK_CLIENT_SECRET",
			"TWITTER_CLIENT_SECRET",
			"DISCORD_CLIENT_SECRET",
			"RESEND_API_KEY",
			"AKISMET_API_KEY",
			"SPAM_FORM_TS_SECRET",
			"CF_API_TOKEN",
			"GITHUB_TOKEN",
			"TELEGRAM_BOT_TOKEN",
			"TELEGRAM_WEBHOOK_SECRET",
		]) {
			expect(varNames.has(name), `${name} must be a secret`).toBe(false);
		}
	});
});

describe("registry ↔ release manifest", () => {
	const manifest: {
		secrets: { name: string; required: boolean; addedIn?: string }[];
		vars: { name: string; required: boolean; addedIn?: string }[];
	} = JSON.parse(
		readFileSync(join(REPO_ROOT, "release-manifest.json"), "utf8"),
	);

	it("declares exactly the registry's secrets", () => {
		expect(manifest.secrets.map((s) => s.name)).toEqual(
			SECRETS.map((e) => e.name),
		);
	});

	it("declares exactly the registry's vars", () => {
		expect(manifest.vars.map((v) => v.name)).toEqual(VARS.map((e) => e.name));
	});

	it("takes required and addedIn from the registry", () => {
		for (const e of CONFIG_REGISTRY) {
			const row = [...manifest.secrets, ...manifest.vars].find(
				(r) => r.name === e.name,
			);
			expect(row?.required, `${e.name}.required`).toBe(e.required);
			expect(row?.addedIn, `${e.name}.addedIn`).toBe(e.addedIn);
		}
	});
});
