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
	REQUIRED_SECRETS,
	missingRequiredSecrets,
	requireConfig,
} from "../src/lib/require-config";

const OK_ENV = {
	IP_HASH_SECRET: "test-ip-hash-secret",
	JWT_SECRET: "test-jwt-secret",
};

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
