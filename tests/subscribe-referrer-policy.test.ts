/**
 * The emailed confirm and unsubscribe pages POST a form back to themselves.
 * Under `Referrer-Policy: no-referrer` browsers serialize that POST's Origin
 * as `null`, which the self-origin CSRF check in lib/cors.ts rejects with
 * err.origin.forbidden — so no reader could ever press the button.
 *
 * The POST tests in subscriptions-confirm.test.ts build the request by hand
 * with a correct Origin, so they cannot catch this: it is the browser that
 * produces `null`, from the header asserted here.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const SELF = "https://comments.test.example";
const TOKEN = "0".repeat(64);

// Every lookup misses: these pages render "link expired" for an unknown token,
// which is enough to see the headers the global middleware sets.
const emptyD1 = {
	prepare() {
		return {
			bind() {
				return this;
			},
			async first() {
				return null;
			},
			async all() {
				return { results: [] };
			},
			async run() {
				return { success: true, meta: { changes: 0 } };
			},
		};
	},
};

const get = async (path: string): Promise<Response> =>
	await worker.fetch(
		new Request(`${SELF}${path}`),
		{
			ALLOWED_ORIGINS: "https://blog.example.com",
			IP_HASH_SECRET: "test-ip-hash-secret",
			JWT_SECRET: "test-jwt-secret",
			DB: emptyD1,
		} as unknown as Record<string, unknown>,
		{} as ExecutionContext,
	);

describe("Referrer-Policy on the emailed subscription pages", () => {
	it.each([
		`/api/v1/subscribe/confirm/${TOKEN}`,
		`/api/v1/subscribe/unsubscribe/${TOKEN}`,
	])("serves %s as same-origin so its form POST keeps a real Origin", async (path) => {
		const res = await get(path);
		expect(res.headers.get("referrer-policy")).toBe("same-origin");
	});

	it("keeps no-referrer everywhere else", async () => {
		const res = await get("/api/v1/health");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	});
});
