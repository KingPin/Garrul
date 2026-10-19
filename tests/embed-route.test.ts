/**
 * GET /embed.js — the Hono fallback for installs without `[assets]`.
 * public/_headers (written by scripts/build-embed.ts) mirrors these two
 * headers, so this test is the contract both serving paths share.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = {
	IP_HASH_SECRET: "test-ip-hash-secret",
	JWT_SECRET: "test-jwt-secret",
	ALLOWED_ORIGINS: "https://blog.test",
	ENV: "prod",
};

describe("GET /embed.js (Worker fallback)", () => {
	it("serves the bundle with the same headers public/_headers declares", async () => {
		const res = await worker.fetch(new Request("https://comments.test/embed.js"), env as never, {
			waitUntil() {},
			passThroughOnException() {},
		} as never);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=3600, s-maxage=86400");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-type")).toMatch(/^application\/javascript/);
		expect(await res.text()).toBe(readFileSync(join(__dirname, "../dist/embed.js"), "utf8"));
	});
});
