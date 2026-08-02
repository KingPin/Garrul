/**
 * Request body size cap (src/lib/body-limit.ts).
 *
 * Every per-field limit in the app runs *after* c.req.json() has parsed the
 * whole body — the comment length cap, the name cap, the bulk-action id count.
 * So the interesting assertion here isn't just "returns 413", it's that the
 * handler never ran: a 40 MB array of junk must not cost a JSON parse.
 *
 * These use a small purpose-built Hono app rather than the real one, because
 * the middleware is registered globally in src/index.ts and mounting the real
 * app would drag in D1, KV, sessions and the origin gate for a test whose
 * subject is one middleware.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { jsonBodyLimit, MAX_JSON_BYTES } from "../src/lib/body-limit";

// Mirrors src/index.ts: the limit is registered on "*", ahead of the routes.
const makeApp = () => {
	let handlerRuns = 0;
	const app = new Hono();
	app.use("*", jsonBodyLimit());
	const handler = async (c: any) => {
		handlerRuns++;
		const body = await c.req.json().catch(() => null);
		return c.json({ ok: true, got: body });
	};
	app.post("/api/v1/comments", handler);
	app.post("/admin/api/ops/import-disqus", handler);
	app.get("/api/v1/comments", async (c) => {
		handlerRuns++;
		return c.json({ ok: true });
	});
	return { app, runs: () => handlerRuns };
};

// `{"pad":"…"}` is 10 characters of envelope around the padding, and every
// character is single-byte ASCII, so the encoded length is exactly `bytes`.
const ENVELOPE = 10;
const jsonOfBytes = (bytes: number): string =>
	JSON.stringify({ pad: "x".repeat(Math.max(0, bytes - ENVELOPE)) });

const post = (app: Hono, path: string, body: string) =>
	app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});

describe("jsonBodyLimit — content-length path", () => {
	it("passes a body under the cap through to the handler", async () => {
		const { app, runs } = makeApp();
		const res = await post(app, "/api/v1/comments", jsonOfBytes(1024));
		expect(res.status).toBe(200);
		expect(runs()).toBe(1);
		const json = (await res.json()) as { got: { pad: string } };
		// Not just "it returned 200" — the body arrived intact, so the
		// middleware didn't consume the stream out from under c.req.json().
		expect(json.got.pad.length).toBe(1024 - ENVELOPE);
	});

	it("rejects a body over the cap with a JSON 413", async () => {
		const { app } = makeApp();
		const res = await post(app, "/api/v1/comments", jsonOfBytes(MAX_JSON_BYTES + 1));
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
	});

	it("never runs the handler for an oversized body", async () => {
		const { app, runs } = makeApp();
		// The whole point: no parse, no D1, no rate-limit read. A 4 MB payload
		// would otherwise be fully deserialized before any field-level cap saw
		// it.
		await post(app, "/api/v1/comments", jsonOfBytes(4 * 1024 * 1024));
		expect(runs()).toBe(0);
	});

	it("accepts a body exactly at the cap", async () => {
		const { app } = makeApp();
		const res = await post(app, "/api/v1/comments", jsonOfBytes(MAX_JSON_BYTES));
		expect(res.status).toBe(200);
	});
});

describe("jsonBodyLimit — no content-length", () => {
	it("counts stream bytes when the length header is absent", async () => {
		const { app, runs } = makeApp();
		const payload = new TextEncoder().encode(jsonOfBytes(MAX_JSON_BYTES + 1024));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Chunked in slices so the counter has to accumulate rather
				// than see the whole thing at once.
				for (let i = 0; i < payload.length; i += 8192) {
					controller.enqueue(payload.subarray(i, i + 8192));
				}
				controller.close();
			},
		});
		const req = new Request("http://x/api/v1/comments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stream,
			// @ts-expect-error duplex is required for a stream body and is not
			// in the DOM RequestInit typings Node/workers-types ship.
			duplex: "half",
		});
		expect(req.headers.get("content-length")).toBeNull();
		const res = await app.fetch(req);
		expect(res.status).toBe(413);
		expect(runs()).toBe(0);
	});
});

describe("jsonBodyLimit — exemptions", () => {
	it("does not cap the Disqus XML import, which has its own limit", async () => {
		const { app, runs } = makeApp();
		// 50 MB is that route's own ceiling (MAX_XML_BYTES); 1 MB is well over
		// the JSON cap and must still reach the handler.
		const res = await app.request("/admin/api/ops/import-disqus", {
			method: "POST",
			headers: { "content-type": "application/xml" },
			body: "x".repeat(1024 * 1024),
		});
		expect(res.status).toBe(200);
		expect(runs()).toBe(1);
	});

	it("does not cap a route by content-type", async () => {
		// Request.json() parses regardless of the declared content-type, so a
		// content-type-gated cap would be an attacker-controlled bypass.
		// Declaring XML on a JSON route must not lift the limit.
		const { app, runs } = makeApp();
		const res = await app.request("/api/v1/comments", {
			method: "POST",
			headers: { "content-type": "application/xml" },
			body: jsonOfBytes(MAX_JSON_BYTES + 1),
		});
		expect(res.status).toBe(413);
		expect(runs()).toBe(0);
	});

	it("lets a bodyless GET through untouched", async () => {
		const { app, runs } = makeApp();
		const res = await app.request("/api/v1/comments");
		expect(res.status).toBe(200);
		expect(runs()).toBe(1);
	});
});
