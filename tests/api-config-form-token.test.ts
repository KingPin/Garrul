/**
 * GET /api/v1/config — `form_token_enabled`.
 *
 * The widget uses this flag to skip the `/api/v1/comments/form-token`
 * request when that route would 404 anyway. The predicate here must equal
 * the route's own gate (secret present AND spam_honeypot_min_ms > 0); if the
 * two drift, the widget either wastes a request or submits without a token.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { config } from "../src/routes/api.config";
import type { Bindings } from "../src/index";

const kv = () => ({
	get: async () => null,
	put: async () => {},
	delete: async () => {},
});

const app = new Hono<{ Bindings: Bindings }>().route("/", config);

const makeEnv = (extra: Record<string, unknown> = {}) =>
	({
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				async all() {
					return { results: [] };
				},
				async first() {
					return null;
				},
			}),
		},
		TREE_CACHE: kv(),
		...extra,
	}) as unknown as Record<string, unknown>;

const getConfig = async (
	extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
	const res = await app.request("/", {}, makeEnv(extra));
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
};

describe("GET /api/v1/config form_token_enabled", () => {
	it("is false with no signing secret", async () => {
		const cfg = await getConfig({ SPAM_HONEYPOT_MIN_MS: "1500" });
		expect(cfg.form_token_enabled).toBe(false);
	});

	it("is false when the secret is set but the minimum is 0 (the default)", async () => {
		const cfg = await getConfig({ SPAM_FORM_TS_SECRET: "k" });
		expect(cfg.form_token_enabled).toBe(false);
	});

	it("is true when the secret is set and the minimum is above 0", async () => {
		const cfg = await getConfig({
			SPAM_FORM_TS_SECRET: "k",
			SPAM_HONEYPOT_MIN_MS: "1500",
		});
		expect(cfg.form_token_enabled).toBe(true);
	});
});
