/**
 * Widget comment-load error copy (src/widget/load-error.ts).
 *
 * A D1/KV/Worker outage makes GET /api/v1/comments 500 (or unreachable). The
 * widget must show reassuring, transient-outage copy — not a raw "HTTP 500" —
 * so a backend hiccup doesn't read like a bug in the host site.
 *
 * The copy itself now lives in the string table, so these assertions name the
 * *keys*: what matters is which of the two branches a given failure lands in,
 * and that the status code never reaches the reader either way.
 */
import { describe, it, expect } from "vitest";
import { loadErrorMessage } from "../src/widget/load-error";
import { EN, makeS } from "../src/widget/strings";

const { s } = makeS();
const TRANSIENT = EN["w.err.transient"];
const GENERIC = EN["w.err.generic"];

describe("loadErrorMessage", () => {
	it("shows transient copy for a 500 (the D1-outage case)", () => {
		expect(loadErrorMessage(new Error("HTTP 500"), s)).toBe(TRANSIENT);
	});

	it("shows transient copy for other 5xx statuses", () => {
		expect(loadErrorMessage(new Error("HTTP 502"), s)).toBe(TRANSIENT);
		expect(loadErrorMessage(new Error("HTTP 503"), s)).toBe(TRANSIENT);
	});

	it("shows transient copy when the backend is unreachable (no status)", () => {
		// fetch() rejects with a TypeError on network failure — no HTTP status.
		expect(loadErrorMessage(new TypeError("Failed to fetch"), s)).toBe(TRANSIENT);
	});

	it("shows generic copy for a 4xx (a real client-side problem)", () => {
		expect(loadErrorMessage(new Error("HTTP 400"), s)).toBe(GENERIC);
		expect(loadErrorMessage(new Error("HTTP 404"), s)).toBe(GENERIC);
	});

	it("never leaks the raw status code to the reader", () => {
		for (const status of [500, 502, 400, 404]) {
			expect(loadErrorMessage(new Error(`HTTP ${status}`), s)).not.toContain(
				String(status),
			);
		}
	});

	it("tolerates a non-Error thrown value", () => {
		expect(loadErrorMessage("boom", s)).toBe(TRANSIENT);
	});

	it("renders through the caller's translator, not a captured English one", () => {
		// The outage path is the one place a reader is most likely to be left
		// staring at a single sentence, so it has to be the translated one.
		const { s: translated } = makeS(
			{ ...EN, "w.err.generic": "Kommentare konnten nicht geladen werden." },
			"de",
		);
		expect(loadErrorMessage(new Error("HTTP 404"), translated)).toBe(
			"Kommentare konnten nicht geladen werden.",
		);
	});
});
