/**
 * Widget reaction merging (src/widget/reactions.ts).
 *
 * Reactions used to reload the whole thread, so there was no client state to
 * get wrong. Now there is: the server is authoritative for counts, the toggle
 * response is authoritative for the clicker's own `mine` on one kind, and
 * everything else has to survive untouched. Those three rules are what this
 * pins — the DOM paint on top of it is a loop with no arithmetic in it.
 */
import { describe, it, expect } from "vitest";
import { mergeReactionTotals } from "../src/widget/reactions";

const prev = [
	{ kind: "like", count: 3, mine: false },
	{ kind: "love", count: 1, mine: true },
];

describe("mergeReactionTotals", () => {
	it("takes counts from the server, not from a local +1", () => {
		// 3 -> 5, because somebody else reacted between the page load and the
		// click. A local increment would have shown 4 until the next reload.
		const out = mergeReactionTotals(prev, { like: 5, love: 1 }, "like", true);
		expect(out).toContainEqual({ kind: "like", count: 5, mine: true });
	});

	it("sets `mine` on the toggled kind from `added`", () => {
		const on = mergeReactionTotals(prev, { like: 4, love: 1 }, "like", true);
		expect(on.find((r) => r.kind === "like")?.mine).toBe(true);

		const off = mergeReactionTotals(prev, { love: 1 }, "like", false);
		expect(off.find((r) => r.kind === "like")).toBeUndefined();
	});

	it("leaves every other kind's `mine` alone", () => {
		// The response says nothing about `love`; forgetting it would un-highlight
		// a reaction the reader can see they made.
		const out = mergeReactionTotals(prev, { like: 4, love: 1 }, "like", true);
		expect(out.find((r) => r.kind === "love")?.mine).toBe(true);
	});

	it("drops a kind that fell to zero", () => {
		// Matches the tree payload, whose aggregate only contains existing rows —
		// one shape for both, so a re-render after Load more agrees with the patch.
		const out = mergeReactionTotals(prev, { like: 3, love: 0 }, "love", false);
		expect(out).toEqual([{ kind: "like", count: 3, mine: false }]);
	});

	it("picks up a kind nobody had reacted with before", () => {
		const out = mergeReactionTotals(prev, { like: 3, love: 1, cry: 1 }, "cry", true);
		expect(out).toContainEqual({ kind: "cry", count: 1, mine: true });
	});

	it("returns an empty list when the last reaction is removed", () => {
		const one = [{ kind: "like", count: 1, mine: true }];
		expect(mergeReactionTotals(one, {}, "like", false)).toEqual([]);
	});
});
