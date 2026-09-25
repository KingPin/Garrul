/**
 * Two app-wide guards in src/index.ts, driven through worker.fetch:
 *
 *   - ENV=dev relaxes cookies and the Origin allowlist, so a deploy that
 *     leaks it onto a real hostname must refuse to serve, with an empty body.
 *   - An uncaught throw in any route answers a generic 500 and logs the error,
 *     never a stack trace to the caller.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { asD1 } from "./helpers/d1";
import { makeKv } from "./helpers/kv";

const fetchAt = (url: string, env: Record<string, unknown> = {}) =>
	worker.fetch(
		new Request(url),
		{
			ALLOWED_ORIGINS: "https://blog.example.com",
			IP_HASH_SECRET: "test-ip-hash-secret",
			JWT_SECRET: "test-jwt-secret",
			DB: asD1({ prepare: () => ({ all: async () => ({ results: [] }) }) }),
			TREE_CACHE: makeKv(),
			...env,
		} as unknown as Record<string, unknown>,
		{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
	);

const logged = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])).msg);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ENV=dev host guard", () => {
	it("refuses a public hostname with an empty 500", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await fetchAt("https://comments.example.com/", { ENV: "dev" });
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("");
		expect(logged(errors)).toContain("ENV=dev on non-local host; refusing to serve");
	});

	it.each([
		"http://localhost:8787/",
		"http://[::1]:8787/",
		"http://host.docker.internal/",
		"http://127.0.0.2/",
		"http://garrul.localhost/",
		"http://box.local/",
		"http://garrul.test/",
	])("serves local dev host %s", async (url) => {
		const res = await fetchAt(url, { ENV: "dev" });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("Garrul");
	});
});

describe("unhandled route errors", () => {
	it("answers a generic 500 and logs the error", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await fetchAt("https://comments.example.com/c/01HCOMMENT0000000000000000", {
			DB: asD1({
				prepare: () => {
					throw new Error("d1 exploded");
				},
			}),
		});
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "internal_error" });
		expect(logged(errors)).toContain("unhandled.error");
	});
});
