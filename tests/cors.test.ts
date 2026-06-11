/**
 * Origin-allowlist + CSRF middleware (src/lib/cors.ts).
 *
 * Same stub-Hono-context approach as session.test.ts — no Miniflare needed,
 * the middleware only touches c.req.{header,method,path}, c.env, c.header,
 * c.body, and c.json.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { corsAndCsrf } from "../src/lib/cors";

type Outcome =
	| { kind: "blocked"; status: number; body: unknown }
	| { kind: "preflight"; status: number; headers: Record<string, string> }
	| { kind: "passed"; headers: Record<string, string> };

const runMiddleware = async (
	mw: MiddlewareHandler,
	opts: {
		method: string;
		path: string;
		origin?: string;
		env?: Record<string, string | undefined>;
	},
): Promise<Outcome> => {
	const headers: Record<string, string> = {};
	let nextCalled = false;
	let earlyResponse:
		| { kind: "blocked"; status: number; body: unknown }
		| { kind: "preflight"; status: number }
		| null = null;

	// The middleware also backfills headers onto c.res after next(); the stub
	// models it as a plain reassignable Response like Hono's context.
	let res = new Response(null);
	const ctx = {
		env: opts.env ?? { ALLOWED_ORIGINS: "https://blog.example.com" },
		get res() {
			return res;
		},
		set res(r: Response) {
			res = r;
		},
		req: {
			header: (name: string) =>
				name.toLowerCase() === "origin" ? opts.origin : undefined,
			method: opts.method,
			path: opts.path,
		},
		header: (name: string, value: string) => {
			headers[name] = value;
		},
		body: (_b: unknown, status: number) => {
			earlyResponse = { kind: "preflight", status };
			return undefined as unknown as Response;
		},
		json: (body: unknown, status: number) => {
			earlyResponse = { kind: "blocked", status, body };
			return undefined as unknown as Response;
		},
	};

	const next = async (): Promise<void> => {
		nextCalled = true;
	};

	// Hono's middleware signature is (c, next) => Promise<void | Response>.
	// Our stub matches its surface area for the parts cors.ts uses.
	await (mw as unknown as (c: typeof ctx, n: typeof next) => Promise<void>)(
		ctx,
		next,
	);

	if (earlyResponse?.kind === "blocked") return earlyResponse;
	if (earlyResponse?.kind === "preflight") {
		return { kind: "preflight", status: earlyResponse.status, headers };
	}
	if (!nextCalled) {
		throw new Error("middleware neither blocked nor called next()");
	}
	return { kind: "passed", headers };
};

describe("corsAndCsrf — Origin allowlist on /api/*", () => {
	const mw = corsAndCsrf();

	describe("GET reads now require Origin (hardening)", () => {
		it("GET /api/v1/comments with no Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/comments",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
			expect(r.body).toEqual({ error: "err.origin.forbidden" });
		});

		it("GET /api/v1/comments with disallowed Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/comments",
				origin: "https://evil.example.com",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
		});

		it("GET /api/v1/comments with allowed Origin → passes, CORS headers echoed", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/comments",
				origin: "https://blog.example.com",
			});
			expect(r.kind).toBe("passed");
			if (r.kind !== "passed") return;
			expect(r.headers["Access-Control-Allow-Origin"]).toBe(
				"https://blog.example.com",
			);
			expect(r.headers["Access-Control-Allow-Credentials"]).toBe("true");
			expect(r.headers.Vary).toBe("Origin");
		});

		it("GET /api/v1/counts with no Origin → 403 (also gated)", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/counts",
			});
			expect(r.kind).toBe("blocked");
		});

		it("GET /api/v1/config with no Origin → 403 (also gated)", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/config",
			});
			expect(r.kind).toBe("blocked");
		});
	});

	describe("State-changing methods still gated (existing behavior)", () => {
		it("POST /api/v1/comments with no Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "POST",
				path: "/api/v1/comments",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
		});

		it("POST /api/v1/comments with allowed Origin → passes", async () => {
			const r = await runMiddleware(mw, {
				method: "POST",
				path: "/api/v1/comments",
				origin: "https://blog.example.com",
			});
			expect(r.kind).toBe("passed");
		});

		it("DELETE /api/v1/comments/abc with disallowed Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "DELETE",
				path: "/api/v1/comments/abc",
				origin: "https://evil.example.com",
			});
			expect(r.kind).toBe("blocked");
		});
	});

	describe("Carve-outs bypass the Origin check", () => {
		it("GET /api/v1/health with no Origin → passes (uptime probes)", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/health",
			});
			expect(r.kind).toBe("passed");
		});

		it("GET /api/v1/auth/github/start with no Origin → passes (OAuth nav)", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/auth/github/start",
			});
			expect(r.kind).toBe("passed");
		});

		it("GET /api/v1/auth/google/callback with no Origin → passes (OAuth callback)", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/auth/google/callback",
			});
			expect(r.kind).toBe("passed");
		});

		it("carve-out match is anchored — /api/v1/healthcheck does NOT bypass", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/healthcheck",
			});
			expect(r.kind).toBe("blocked");
		});

		it("carve-out match is anchored — /api/v1/auth/foo (no /start) does NOT bypass", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/auth/foo",
			});
			expect(r.kind).toBe("blocked");
		});

		it("carve-out match rejects sub-paths — /api/v1/health/sub does NOT bypass", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/health/sub",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
		});

		it("carve-out match rejects sub-paths — /api/v1/auth/github/start/admin does NOT bypass", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/auth/github/start/admin",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
		});

		it("carve-out tolerates trailing slash — GET /api/v1/health/ still bypasses", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/health/",
			});
			expect(r.kind).toBe("passed");
		});

		it("carve-out is GET-only — POST /api/v1/health with no Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "POST",
				path: "/api/v1/health",
			});
			expect(r.kind).toBe("blocked");
			if (r.kind !== "blocked") return;
			expect(r.status).toBe(403);
		});

		it("carve-out is GET-only — POST /api/v1/auth/github/start with no Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "POST",
				path: "/api/v1/auth/github/start",
			});
			expect(r.kind).toBe("blocked");
		});

		it("carve-out is GET-only — PATCH /api/v1/auth/google/callback with no Origin → 403", async () => {
			const r = await runMiddleware(mw, {
				method: "PATCH",
				path: "/api/v1/auth/google/callback",
			});
			expect(r.kind).toBe("blocked");
		});
	});

	describe("Dev mode escape hatch", () => {
		it("ENV=dev with no Origin still passes on a normally-gated GET", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/comments",
				env: { ALLOWED_ORIGINS: "", ENV: "dev" },
			});
			expect(r.kind).toBe("passed");
		});

		it("ENV=dev with arbitrary Origin still passes on POST", async () => {
			const r = await runMiddleware(mw, {
				method: "POST",
				path: "/api/v1/comments",
				origin: "https://anything.example.com",
				env: { ALLOWED_ORIGINS: "", ENV: "dev" },
			});
			expect(r.kind).toBe("passed");
		});
	});

	describe("CORS preflight (OPTIONS)", () => {
		it("OPTIONS with allowed Origin → 204 with CORS headers", async () => {
			const r = await runMiddleware(mw, {
				method: "OPTIONS",
				path: "/api/v1/comments",
				origin: "https://blog.example.com",
			});
			expect(r.kind).toBe("preflight");
			if (r.kind !== "preflight") return;
			expect(r.status).toBe(204);
			expect(r.headers["Access-Control-Allow-Origin"]).toBe(
				"https://blog.example.com",
			);
			expect(r.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
			expect(r.headers["Access-Control-Max-Age"]).toBe("86400");
		});

		it("OPTIONS with disallowed Origin → 204 with no CORS headers (browser will block)", async () => {
			const r = await runMiddleware(mw, {
				method: "OPTIONS",
				path: "/api/v1/comments",
				origin: "https://evil.example.com",
			});
			expect(r.kind).toBe("preflight");
			if (r.kind !== "preflight") return;
			expect(r.status).toBe(204);
			expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
		});
	});

	// The stub-context tests above record c.header() calls — but Hono only
	// applies those "prepared headers" to responses created via the context
	// (c.json/c.body). A handler that returns a raw `Response` (the edge-cache
	// paths in lib/response-cache.ts) drops them entirely, which is exactly the
	// bug that shipped: OPTIONS carried Access-Control-Allow-Origin but GET
	// /api/v1/counts did not, so browsers blocked the cross-origin read. These
	// tests go through real Hono to pin the on-the-wire behavior.
	describe("real Hono — CORS headers reach the wire", () => {
		const env = { ALLOWED_ORIGINS: "https://blog.example.com" };
		const mkApp = () => {
			const app = new Hono();
			app.use("*", corsAndCsrf());
			// Raw Response, like matchCache()/cacheJson() return.
			app.get("/api/v1/raw", () =>
				new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
				}),
			);
			// Context-created response (the path that always worked).
			app.get("/api/v1/ctx", (c) => c.json({ ok: true }));
			return app;
		};

		it("handler returning a raw Response still gets CORS headers", async () => {
			const res = await mkApp().request(
				"/api/v1/raw",
				{ headers: { origin: "https://blog.example.com" } },
				env,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://blog.example.com",
			);
			expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
			expect(res.headers.get("Vary")).toBe("Origin");
		});

		it("handler using c.json() still gets CORS headers (regression guard)", async () => {
			const res = await mkApp().request(
				"/api/v1/ctx",
				{ headers: { origin: "https://blog.example.com" } },
				env,
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
				"https://blog.example.com",
			);
			expect(res.headers.get("Vary")).toBe("Origin");
		});

		it("disallowed origin gets no CORS headers on a raw Response", async () => {
			const res = await mkApp().request(
				"/api/v1/raw",
				{ headers: { origin: "https://evil.example.com" } },
				env,
			);
			expect(res.status).toBe(403);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
		});
	});

	describe("ALLOWED_ORIGINS parsing", () => {
		it("multi-value comma list — each origin allowed", async () => {
			const env = {
				ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
			};
			for (const origin of [
				"https://a.example.com",
				"https://b.example.com",
			]) {
				const r = await runMiddleware(mw, {
					method: "GET",
					path: "/api/v1/comments",
					origin,
					env,
				});
				expect(r.kind).toBe("passed");
			}
		});

		it("origin not on list is rejected even when list is non-empty", async () => {
			const r = await runMiddleware(mw, {
				method: "GET",
				path: "/api/v1/comments",
				origin: "https://c.example.com",
				env: {
					ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
				},
			});
			expect(r.kind).toBe("blocked");
		});
	});
});
