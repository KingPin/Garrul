/**
 * Widget comment-load error copy (src/widget/load-error.ts).
 *
 * A D1/KV/Worker outage makes GET /api/v1/comments 500 (or unreachable). The
 * widget must show reassuring, transient-outage copy — not a raw "HTTP 500" —
 * so a backend hiccup doesn't read like a bug in the host site.
 */
import { describe, it, expect } from "vitest";
import { loadErrorMessage } from "../src/widget/load-error";

const TRANSIENT =
	"Comments are temporarily unavailable. Please check back in a few minutes.";
const GENERIC = "Could not load comments.";

describe("loadErrorMessage", () => {
	it("shows transient copy for a 500 (the D1-outage case)", () => {
		expect(loadErrorMessage(new Error("HTTP 500"))).toBe(TRANSIENT);
	});

	it("shows transient copy for other 5xx statuses", () => {
		expect(loadErrorMessage(new Error("HTTP 502"))).toBe(TRANSIENT);
		expect(loadErrorMessage(new Error("HTTP 503"))).toBe(TRANSIENT);
	});

	it("shows transient copy when the backend is unreachable (no status)", () => {
		// fetch() rejects with a TypeError on network failure — no HTTP status.
		expect(loadErrorMessage(new TypeError("Failed to fetch"))).toBe(TRANSIENT);
	});

	it("shows generic copy for a 4xx (a real client-side problem)", () => {
		expect(loadErrorMessage(new Error("HTTP 400"))).toBe(GENERIC);
		expect(loadErrorMessage(new Error("HTTP 404"))).toBe(GENERIC);
	});

	it("never leaks the raw status code to the reader", () => {
		for (const status of [500, 502, 400, 404]) {
			expect(loadErrorMessage(new Error(`HTTP ${status}`))).not.toContain(
				String(status),
			);
		}
	});

	it("tolerates a non-Error thrown value", () => {
		expect(loadErrorMessage("boom")).toBe(TRANSIENT);
	});
});
