/**
 * Request-path redaction in the logger (M8).
 *
 * The double-opt-in confirm link and the unsubscribe link both carry 32 random
 * bytes hex-encoded *in the URL path*, and every request logs its pathname
 * twice. Anyone with `wrangler tail` access could lift a live confirm token and
 * turn double-opt-in into single-opt-in, or unsubscribe a reader at will —
 * which is also the project's own "no PII in logs" rule being broken by the
 * logger itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { requestLogger, sanitizeLoggedPath } from "../src/lib/log";

const TOKEN = "a3f".repeat(21) + "b"; // 64 hex chars, as randomToken() emits
const ULID = "01HC000000000000000000ABCD"; // 26 chars

describe("sanitizeLoggedPath", () => {
	it("redacts a capability token in the path", () => {
		expect(sanitizeLoggedPath(`/api/v1/subscribe/confirm/${TOKEN}`)).toBe(
			"/api/v1/subscribe/confirm/***",
		);
		expect(sanitizeLoggedPath(`/api/v1/subscribe/unsubscribe/${TOKEN}`)).toBe(
			"/api/v1/subscribe/unsubscribe/***",
		);
	});

	it("keeps ULIDs readable so the logs stay useful", () => {
		// 26 characters, below the secret threshold. Comment and user IDs are the
		// main thing an operator greps for.
		expect(sanitizeLoggedPath(`/api/v1/comments/${ULID}/source`)).toBe(
			`/api/v1/comments/${ULID}/source`,
		);
	});

	it("leaves ordinary routes untouched", () => {
		expect(sanitizeLoggedPath("/api/v1/health")).toBe("/api/v1/health");
		expect(sanitizeLoggedPath("/admin/queue")).toBe("/admin/queue");
		expect(sanitizeLoggedPath("/")).toBe("/");
	});

	it("caps the length so a caller can't pad the log stream", () => {
		// Many short segments: one long segment would be swallowed by the
		// redaction pass instead, which is the cheaper of the two bounds.
		const out = sanitizeLoggedPath("/ab".repeat(300));
		expect(out.length).toBe(203);
		expect(out.endsWith("...")).toBe(true);
	});

	it("strips control characters", () => {
		const raw = `/api/v1/he${String.fromCharCode(10)}alth`;
		expect(sanitizeLoggedPath(raw)).toBe("/api/v1/health");
	});

	it("redacts every secret-looking segment, not just the last", () => {
		expect(sanitizeLoggedPath(`/${TOKEN}/x/${TOKEN}`)).toBe("/***/x/***");
	});
});

describe("requestLogger", () => {
	let lines: string[];

	beforeEach(() => {
		lines = [];
		vi.spyOn(console, "log").mockImplementation((s: unknown) => {
			lines.push(String(s));
		});
	});
	afterEach(() => vi.restoreAllMocks());

	it("never writes a live confirm token to the log stream", async () => {
		const app = new Hono();
		app.use("*", requestLogger());
		app.get("/api/v1/subscribe/confirm/:token", (c) => c.text("ok"));

		const res = await app.request(`/api/v1/subscribe/confirm/${TOKEN}`);
		expect(res.status).toBe(200);

		// Both request.start and request.end carry the path.
		expect(lines).toHaveLength(2);
		const all = lines.join("\n");
		expect(all).not.toContain(TOKEN);
		for (const line of lines) {
			expect(JSON.parse(line).path).toBe("/api/v1/subscribe/confirm/***");
		}
	});
});
