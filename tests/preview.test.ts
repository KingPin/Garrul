/**
 * Preview-endpoint tests (POST /api/v1/preview).
 *
 * The whole point of server-side preview is parity: the HTML returned here
 * must be byte-identical to what renderMarkdown() would store for a posted
 * comment, so the widget's Preview tab can't diverge from reality (and can't
 * be tricked into rendering markup the sanitizer would have stripped).
 *
 * No Miniflare: a KV stub for the rate-limit bucket, real renderMarkdown for
 * the parity assertion.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { preview } from "../src/routes/api.preview";
import { renderMarkdown } from "../src/lib/markdown";

const mkKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
	};
};

const mkApp = () => {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.route("/", preview);
	const env = {
		RATE_LIMITS: mkKv(),
		IP_HASH_SECRET: "x".repeat(32),
	};
	return { app, env };
};

const post = (app: Hono, env: Record<string, unknown>, body: unknown) =>
	app.request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		},
		env,
	);

describe("POST /preview — rendering parity", () => {
	it("returns HTML identical to renderMarkdown for the same source", async () => {
		const { app, env } = mkApp();
		const src = "**bold** and _em_ and `code`\n\n- a\n- b";
		const res = await post(app, env, { body: src });
		expect(res.status).toBe(200);
		const data = (await res.json()) as { html: string };
		expect(data.html).toBe(renderMarkdown(src));
	});

	it("renders a link with the same rel/target the store would apply", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, { body: "[x](https://example.com)" });
		const data = (await res.json()) as { html: string };
		expect(data.html).toContain('rel="nofollow ugc noopener"');
		expect(data.html).toContain('target="_blank"');
	});
});

describe("POST /preview — sanitizer (XSS)", () => {
	it("strips a raw <script> tag", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, {
			body: "hi <script>alert(1)</script> there",
		});
		const data = (await res.json()) as { html: string };
		expect(data.html).not.toContain("<script");
		expect(data.html).not.toContain("alert(1)</script>");
	});

	it("drops a javascript: link scheme", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, {
			// eslint-disable-next-line no-script-url
			body: "[click](javascript:alert(1))",
		});
		const data = (await res.json()) as { html: string };
		expect(data.html).not.toContain("javascript:");
		expect(data.html).not.toContain("<a ");
	});

	it("drops an <img onerror> payload", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, {
			body: '![x](https://e.com/x.png) <img src=x onerror=alert(1)>',
		});
		const data = (await res.json()) as { html: string };
		expect(data.html).not.toContain("onerror");
		expect(data.html).not.toContain("<img");
	});
});

describe("POST /preview — validation", () => {
	it("rejects an empty body with 400", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, { body: "   " });
		expect(res.status).toBe(400);
	});

	it("rejects a missing body with 400", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, {});
		expect(res.status).toBe(400);
	});

	it("rejects malformed JSON with 400", async () => {
		const { app, env } = mkApp();
		const res = await post(app, env, "{not json");
		expect(res.status).toBe(400);
	});
});

describe("POST /preview — rate limit", () => {
	it("429s once the short bucket is exhausted", async () => {
		const { app, env } = mkApp();
		// PREVIEW_LIMITS.short.max = 5; the 6th within the window trips it.
		let last = 200;
		for (let i = 0; i < 7; i++) {
			const res = await post(app, env, { body: "hello" });
			last = res.status;
		}
		expect(last).toBe(429);
	});
});
