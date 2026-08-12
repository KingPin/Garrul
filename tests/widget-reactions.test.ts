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
	normalizeReactionKind,
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
		// stored rows to `fire`. Re-adding it would resurrect the duplication and
		// collide with the deprecated-alias mapping below.
		expect(REACTION_KIND_SET.has("like")).toBe(false);
		expect(REACTION_KIND_SET.has("fire")).toBe(true);
	});
});

describe("normalizeReactionKind", () => {
	it("maps the deprecated `like` onto `fire`", () => {
		// A pre-2.10.0 bundle in a reader's cache still POSTs `like`. Without this
		// it would 400 — or, worse, land a row no build can render.
		expect(normalizeReactionKind("like")).toBe("fire");
	});

	it("leaves a current kind alone", () => {
		for (const r of REACTION_KINDS) {
			expect(normalizeReactionKind(r.kind)).toBe(r.kind);
		}
	});

	it("passes an unknown kind through unchanged", () => {
		// Load-bearing: the routes reject on REACTION_KIND_SET *after* normalizing,
		// so anything this invented would become a kind the API accepts.
		expect(normalizeReactionKind("shrug")).toBe("shrug");
		expect(REACTION_KIND_SET.has(normalizeReactionKind("shrug"))).toBe(false);
	});

	it("does not resolve inherited object keys", () => {
		// The input is a wire value. A plain-object lookup answers for every key on
		// Object.prototype, so these returned a function (or Object.prototype)
		// while still typed `string` — a lie waiting for the first caller that
		// trusts the return value instead of re-checking membership.
		for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
			expect(normalizeReactionKind(key)).toBe(key);
			expect(typeof normalizeReactionKind(key)).toBe("string");
		}
	});
});
