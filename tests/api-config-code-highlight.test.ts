/**
 * GET /api/v1/config — `code_highlight_enabled`.
 *
 * The widget lazy-loads embed-highlight.js only when this is true. The
 * operator panel switch lives in the settings table and defaults on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { config } from "../src/routes/api.config";
import { bustSettingsCache } from "../src/lib/settings";
import type { Bindings } from "../src/index";

const kv = () => ({
	get: async () => null,
	put: async () => {},
	delete: async () => {},
});

const app = new Hono<{ Bindings: Bindings }>().route("/", config);

const makeEnv = (rows: Record<string, string>) =>
	({
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				async all() {
					return {
						results: Object.entries(rows).map(([key, value]) => ({ key, value })),
					};
				},
				async first() {
					return null;
				},
			}),
		},
		TREE_CACHE: kv(),
	}) as unknown as Bindings;

const getConfig = async (rows: Record<string, string>) => {
	const env = makeEnv(rows);
	await bustSettingsCache(env);
	const res = await app.request("/", {}, env as unknown as Record<string, unknown>);
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
};

// The settings memo is module-level, so start every test cold.
beforeEach(async () => {
	await bustSettingsCache(makeEnv({}));
});

describe("GET /api/v1/config code_highlight_enabled", () => {
	it("is true by default", async () => {
		expect((await getConfig({})).code_highlight_enabled).toBe(true);
	});

	it("is false when the settings table sets it to \"false\"", async () => {
		const cfg = await getConfig({ code_highlight_enabled: "false" });
		expect(cfg.code_highlight_enabled).toBe(false);
	});
});
