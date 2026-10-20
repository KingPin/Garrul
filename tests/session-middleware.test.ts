/**
 * The TTL slide's Set-Cookie through real Hono. The slide runs in
 * sessionMiddleware before the handler, and a handler that returns a raw
 * Response (cached tree pages, /counts) replaces the headers it was set on.
 * The stub-context tests in session.test.ts cannot see that.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestLogger } from "../src/lib/log";
import { issueSession, sessionMiddleware } from "../src/lib/session";

const makeApp = () => {
	const store = new Map<string, string>();
	const env = {
		ENV: "prod",
		SESSIONS: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
		},
	};
	const app = new Hono();
	app.use("*", requestLogger());
	app.use("/api/*", sessionMiddleware() as never);
	app.get(
		"/api/raw",
		() =>
			new Response("{}", {
				headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
			}),
	);
	app.get("/api/json", (c) => c.json({}));
	app.get("/login", async (c) => {
		await issueSession(c as never, "u1");
		return c.text("ok");
	});
	// Leaves `days` of the 30-day lifetime on every stored session.
	const age = (days: number) => {
		for (const [k, v] of store) {
			if (!k.startsWith("sess:")) continue;
			const r = JSON.parse(v);
			r.expires_at = Date.now() + days * 86_400_000;
			store.set(k, JSON.stringify(r));
		}
	};
	return { app, env, age };
};

const login = async ({ app, env }: ReturnType<typeof makeApp>) =>
	(await app.request("/login", {}, env)).headers.getSetCookie()[0]!.split(";")[0]!;

describe("sessionMiddleware slide cookie", () => {
	it("reaches the browser when the handler returns a raw Response, never as public", async () => {
		const h = makeApp();
		const cookie = await login(h);
		h.age(10);
		const res = await h.app.request("/api/raw", { headers: { cookie } }, h.env);
		const set = res.headers.getSetCookie();
		expect(set).toHaveLength(1);
		expect(set[0]).toContain(`${cookie};`);
		expect(set[0]).toContain(`Max-Age=${30 * 86_400}`);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
		expect(res.headers.get("x-request-id")).toMatch(/\S/);
	});

	it("is sent once, not twice, on a c.json handler", async () => {
		const h = makeApp();
		const cookie = await login(h);
		h.age(10);
		const res = await h.app.request("/api/json", { headers: { cookie } }, h.env);
		expect(res.headers.getSetCookie()).toHaveLength(1);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});

	it("leaves a response alone when nothing slid", async () => {
		const h = makeApp();
		const cookie = await login(h);
		h.age(25);
		const res = await h.app.request("/api/raw", { headers: { cookie } }, h.env);
		expect(res.headers.getSetCookie()).toHaveLength(0);
		expect(res.headers.get("cache-control")).toBe("public, max-age=60");
	});
});
