/**
 * Thread acceptance resolver tests (src/lib/thread.ts).
 *
 * resolveThreadOpen is a pure function, so these are straight input→output
 * assertions — no KV/D1 stubs needed. The contract under test is the
 * precedence chain:
 *
 *   1. comments_enabled OFF  → closed (comments_disabled)
 *   2. posts.closed set      → closed (post_closed)
 *   3. auto_close_at reached  → closed (sunset)
 *   4. auto_close_days passed → closed (aged_out), anchored on published_at
 *                               falling back to created_at
 *   else                     → open
 */
import { describe, it, expect } from "vitest";
import { resolveThreadOpen } from "../src/lib/thread";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed "now" for all cases

// Convenience builders so each test states only the field it exercises.
const post = (
	over: Partial<{ closed: boolean; published_at: number | null; created_at: number }> = {},
) => ({
	closed: false,
	published_at: null,
	created_at: NOW,
	...over,
});
const flags = (comments_enabled = true) => ({ comments_enabled });
const numbers = (auto_close_days = 0, auto_close_at = 0) => ({
	auto_close_days,
	auto_close_at,
});

describe("resolveThreadOpen", () => {
	it("is open by default (no rules active)", () => {
		expect(resolveThreadOpen(post(), flags(), numbers(), NOW)).toEqual({
			open: true,
		});
	});

	it("closes everywhere when comments_enabled is off (highest precedence)", () => {
		// Even with the post otherwise open, the global switch wins.
		const r = resolveThreadOpen(post(), flags(false), numbers(), NOW);
		expect(r).toEqual({ open: false, reason: "comments_disabled" });
	});

	it("global switch beats a per-post close (precedence order)", () => {
		const r = resolveThreadOpen(
			post({ closed: true }),
			flags(false),
			numbers(),
			NOW,
		);
		expect(r.reason).toBe("comments_disabled");
	});

	it("closes a manually frozen post", () => {
		const r = resolveThreadOpen(post({ closed: true }), flags(), numbers(), NOW);
		expect(r).toEqual({ open: false, reason: "post_closed" });
	});

	it("closes once the instance sunset is reached", () => {
		const r = resolveThreadOpen(post(), flags(), numbers(0, NOW), NOW);
		expect(r).toEqual({ open: false, reason: "sunset" });
	});

	it("stays open just before the sunset instant", () => {
		const r = resolveThreadOpen(post(), flags(), numbers(0, NOW + 1), NOW);
		expect(r.open).toBe(true);
	});

	it("sunset of 0 is disabled (epoch 0 must not close everything)", () => {
		const r = resolveThreadOpen(post(), flags(), numbers(0, 0), NOW);
		expect(r.open).toBe(true);
	});

	it("ages out a thread N days after published_at", () => {
		const published_at = NOW - 6 * DAY;
		const r = resolveThreadOpen(
			post({ published_at }),
			flags(),
			numbers(5),
			NOW,
		);
		expect(r).toEqual({ open: false, reason: "aged_out" });
	});

	it("stays open inside the age window", () => {
		const published_at = NOW - 4 * DAY;
		const r = resolveThreadOpen(
			post({ published_at }),
			flags(),
			numbers(5),
			NOW,
		);
		expect(r.open).toBe(true);
	});

	it("anchors age on published_at over created_at when both are present", () => {
		// created_at (first comment) is old, but the article was published
		// recently — the published_at anchor keeps the thread open.
		const r = resolveThreadOpen(
			post({ published_at: NOW - 1 * DAY, created_at: NOW - 100 * DAY }),
			flags(),
			numbers(5),
			NOW,
		);
		expect(r.open).toBe(true);
	});

	it("falls back to created_at when published_at is null", () => {
		const r = resolveThreadOpen(
			post({ published_at: null, created_at: NOW - 10 * DAY }),
			flags(),
			numbers(5),
			NOW,
		);
		expect(r).toEqual({ open: false, reason: "aged_out" });
	});

	it("auto_close_days of 0 is disabled (ancient thread stays open)", () => {
		const r = resolveThreadOpen(
			post({ created_at: NOW - 10_000 * DAY }),
			flags(),
			numbers(0),
			NOW,
		);
		expect(r.open).toBe(true);
	});

	it("a manual close beats an otherwise-open age rule", () => {
		const r = resolveThreadOpen(
			post({ closed: true, published_at: NOW }),
			flags(),
			numbers(5),
			NOW,
		);
		expect(r.reason).toBe("post_closed");
	});
});
