/**
 * Startup configuration assertion (src/lib/require-config.ts).
 *
 * An unset IP_HASH_SECRET already failed closed — WebCrypto rejects a
 * zero-length HMAC key — but it did so as an anonymous 500 with a stack trace,
 * on eight separate endpoints, with nothing naming the cause. An unset
 * JWT_SECRET was worse: it looked like "OAuth is broken" rather than "a secret
 * is missing". These pin the replacement: one refusal, one named log line, and
 * nothing about the deployment leaked to whoever asked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
	DEV_PLACEHOLDERS,
	REQUIRED_SECRETS,
	missingRequiredSecrets,
	placeholderRequiredSecrets,
	requireConfig,
} from "../src/lib/require-config";
import { byName } from "../scripts/config-registry";

const OK_ENV = {
	IP_HASH_SECRET: "test-ip-hash-secret",
	JWT_SECRET: "test-jwt-secret",
};

describe("placeholderRequiredSecrets", () => {
	it("mirrors the registry's devPlaceholder for both secrets", () => {
		// src/ cannot import scripts/, so the two strings are repeated in
		// require-config.ts. This is what keeps the copy honest: edit one side
		// and this names the other.
		for (const name of REQUIRED_SECRETS) {
			expect(DEV_PLACEHOLDERS[name]).toBe(byName(name)?.devPlaceholder);
		}
	});

	it("passes a real env, with or without ENV set", () => {
		expect(placeholderRequiredSecrets(OK_ENV)).toEqual([]);
		expect(placeholderRequiredSecrets({ ...OK_ENV, ENV: "production" })).toEqual(
			[],
		);
	});

	it("names each secret still on its public placeholder outside dev", () => {
		expect(
			placeholderRequiredSecrets({ ...DEV_PLACEHOLDERS, ENV: "production" }),
		).toEqual([...REQUIRED_SECRETS]);
		expect(
			placeholderRequiredSecrets({
				...OK_ENV,
				JWT_SECRET: DEV_PLACEHOLDERS.JWT_SECRET,
			}),
		).toEqual(["JWT_SECRET"]);
	});

	it("treats an unset ENV as not-dev", () => {
		// ENV is a var an operator may never set; the secret check must not
		// hinge on them remembering to. Only an explicit "dev" opts out.
		expect(placeholderRequiredSecrets({ ...DEV_PLACEHOLDERS })).toEqual([
			...REQUIRED_SECRETS,
		]);
	});

	it("allows the placeholders under ENV=dev", () => {
		// `.dev.vars.example` ships them so `wrangler dev` works out of the box.
		expect(
			placeholderRequiredSecrets({ ...DEV_PLACEHOLDERS, ENV: "dev" }),
		).toEqual([]);
	});

	it("is an exact match, not a prefix or length rule", () => {
		// A short or odd-looking secret is the operator's business; the check is
		// only for the two strings this repository publishes.
		expect(
			placeholderRequiredSecrets({
				IP_HASH_SECRET: "x",
				JWT_SECRET: `${DEV_PLACEHOLDERS.JWT_SECRET}-2`,
			}),
		).toEqual([]);
	});
});

describe("missingRequiredSecrets", () => {
	it("passes a fully configured env", () => {
		expect(missingRequiredSecrets(OK_ENV)).toEqual([]);
	});

	it("names each missing secret", () => {
		expect(missingRequiredSecrets({})).toEqual([...REQUIRED_SECRETS]);
		expect(missingRequiredSecrets({ JWT_SECRET: "x" })).toEqual([
			"IP_HASH_SECRET",
		]);
	});

	it("treats an empty string as unset", () => {
		// `wrangler secret put` with an empty value, or a var declared but never
		// filled in, both land here. An empty HMAC key is not a key.
		expect(missingRequiredSecrets({ ...OK_ENV, IP_HASH_SECRET: "" })).toEqual([
			"IP_HASH_SECRET",
		]);
	});

	it("does not require Turnstile", () => {
		// An OAuth-only instance never needs it, and verifyTurnstile already
		// fails closed for anonymous posts. Hard-failing here would take such a
		// deployment offline on upgrade.
		expect(REQUIRED_SECRETS).not.toContain("TURNSTILE_SECRET");
		expect(REQUIRED_SECRETS).not.toContain("TURNSTILE_SITE_KEY");
	});
});

describe("requireConfig middleware", () => {
	let errors: string[];

	const mount = () => {
		const app = new Hono();
		app.use("*", requireConfig());
		app.get("/api/v1/health", (c) => c.json({ ok: true }));
		return app;
	};

	beforeEach(() => {
		errors = [];
		vi.spyOn(console, "error").mockImplementation((s: unknown) => {
			errors.push(String(s));
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it("serves normally when everything is set", async () => {
		const res = await mount().request("/api/v1/health", {}, OK_ENV);
		expect(res.status).toBe(200);
		expect(errors).toEqual([]);
	});

	it("refuses to serve when a required secret is missing", async () => {
		const res = await mount().request("/api/v1/health", {}, {
			JWT_SECRET: "x",
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "server_misconfigured" });
	});

	it("names the missing secrets in the log but not in the response", async () => {
		const res = await mount().request("/api/v1/health", {}, {});
		expect(await res.text()).not.toContain("IP_HASH_SECRET");

		expect(errors).toHaveLength(1);
		const line = JSON.parse(errors[0] as string) as {
			msg: string;
			missing: string[];
		};
		expect(line.msg).toBe("config.missing_required_secrets");
		expect(line.missing).toEqual([...REQUIRED_SECRETS]);
	});

	it("refuses to serve on the public dev placeholders outside dev", async () => {
		const res = await mount().request("/api/v1/health", {}, {
			...DEV_PLACEHOLDERS,
			ENV: "production",
		});
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(JSON.parse(body)).toEqual({ error: "server_misconfigured" });
		expect(body).not.toContain("JWT_SECRET");

		expect(errors).toHaveLength(1);
		const line = JSON.parse(errors[0] as string) as {
			msg: string;
			placeholder: string[];
		};
		expect(line.msg).toBe("config.placeholder_required_secrets");
		expect(line.placeholder).toEqual([...REQUIRED_SECRETS]);
	});

	it("serves on the dev placeholders under ENV=dev", async () => {
		const res = await mount().request("/api/v1/health", {}, {
			...DEV_PLACEHOLDERS,
			ENV: "dev",
		});
		expect(res.status).toBe(200);
		expect(errors).toEqual([]);
	});

	it("reports missing before placeholder when both apply", async () => {
		// One line per request: an operator fixing "missing" should not then be
		// surprised by a second refusal they were never told about, so the
		// missing list is the one that gets logged first — it is the one that
		// stops the Worker from working at all, not just insecurely.
		const res = await mount().request("/api/v1/health", {}, {
			JWT_SECRET: DEV_PLACEHOLDERS.JWT_SECRET,
		});
		expect(res.status).toBe(500);
		expect(errors).toHaveLength(1);
		expect(JSON.parse(errors[0] as string).msg).toBe(
			"config.missing_required_secrets",
		);
	});

	it("gates every route, not just the API surface", async () => {
		// Registered on "*" in src/index.ts ahead of the route table, so a
		// misconfigured instance can't serve the admin UI or the embed script
		// either. Health included: an instance in this state is not healthy.
		const app = mount();
		app.get("/embed.js", (c) => c.text("bundle"));
		const res = await app.request("/embed.js", {}, {});
		expect(res.status).toBe(500);
	});
});
