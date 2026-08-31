/**
 * The reaction vocabulary and reaction merging (src/widget/reactions.ts).
 *
 * Reactions used to reload the whole thread, so there was no client state to
 * get wrong. Now there is: the server is authoritative for counts, the toggle
 * response is authoritative for the clicker's own `mine` on one kind, and
 * everything else has to survive untouched. Those three rules are what this
 * pins — the DOM paint on top of it is a loop with no arithmetic in it.
 */
import { describe, it, expect } from "vitest";
import {
	REACTION_KINDS,
	REACTION_KIND_SET,
	mergeReactionTotals,
} from "../src/widget/reactions";

const prev = [
	{ kind: "fire", count: 3, mine: false },
	{ kind: "love", count: 1, mine: true },
];

describe("mergeReactionTotals", () => {
	it("takes counts from the server, not from a local +1", () => {
		// 3 -> 5, because somebody else reacted between the page load and the
		// click. A local increment would have shown 4 until the next reload.
		const out = mergeReactionTotals(prev, { fire: 5, love: 1 }, "fire", true);
		expect(out).toContainEqual({ kind: "fire", count: 5, mine: true });
	});

	it("sets `mine` on the toggled kind from `added`", () => {
		const on = mergeReactionTotals(prev, { fire: 4, love: 1 }, "fire", true);
		expect(on.find((r) => r.kind === "fire")?.mine).toBe(true);

		const off = mergeReactionTotals(prev, { love: 1 }, "fire", false);
		expect(off.find((r) => r.kind === "fire")).toBeUndefined();
	});

	it("leaves every other kind's `mine` alone", () => {
		// The response says nothing about `love`; forgetting it would un-highlight
		// a reaction the reader can see they made.
		const out = mergeReactionTotals(prev, { fire: 4, love: 1 }, "fire", true);
		expect(out.find((r) => r.kind === "love")?.mine).toBe(true);
	});

	it("drops a kind that fell to zero", () => {
		// Matches the tree payload, whose aggregate only contains existing rows —
		// one shape for both, so a re-render after Load more agrees with the patch.
		const out = mergeReactionTotals(prev, { fire: 3, love: 0 }, "love", false);
		expect(out).toEqual([{ kind: "fire", count: 3, mine: false }]);
	});

	it("picks up a kind nobody had reacted with before", () => {
		const out = mergeReactionTotals(prev, { fire: 3, love: 1, cry: 1 }, "cry", true);
		expect(out).toContainEqual({ kind: "cry", count: 1, mine: true });
	});

	it("returns an empty list when the last reaction is removed", () => {
		const one = [{ kind: "fire", count: 1, mine: true }];
		expect(mergeReactionTotals(one, {}, "fire", false)).toEqual([]);
	});
});

describe("the vocabulary", () => {
	it("derives the membership set from the list", () => {
		// The whole reason this module holds the vocabulary: two routes validate
		// against REACTION_KIND_SET while the widget renders REACTION_KINDS, and a
		// kind in one but not the other is a button that 400s.
		expect([...REACTION_KIND_SET].sort()).toEqual(
			REACTION_KINDS.map((r) => r.kind).sort(),
		);
	});

	it("has no duplicate kind", () => {
		const kinds = REACTION_KINDS.map((r) => r.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
	});

	it("gives every kind an emoji", () => {
		for (const r of REACTION_KINDS) expect(r.emoji).not.toBe("");
	});

	it("no longer offers `like`", () => {
		// 👍 duplicated the up-vote directly below it; migration 0022 renamed the
		// stored rows to `fire`. The wire alias that accepted `like` during the
		// transition was removed in v2.24.0 — re-adding the kind would resurrect
		// the duplication.
		expect(REACTION_KIND_SET.has("like")).toBe(false);
		expect(REACTION_KIND_SET.has("fire")).toBe(true);
	});
});
