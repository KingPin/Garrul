/**
 * The reaction vocabulary, and reaction state merging.
 *
 * The vocabulary lives here because three places need to agree on it: the
 * widget renders it, `POST /api/v1/reactions` validates against it, and so
 * does `POST /api/v1/page-engagement/reactions`. It used to be spelled out
 * three times — a hardcoded list in the widget and a hand-maintained
 * `ALLOWED_KINDS` set in each route — so adding a kind meant remembering all
 * three, and forgetting the routes meant a button that 400s.
 *
 * The *widget* side is the one that has to hold it. `tsconfig.widget.json`
 * compiles only `src/widget/**`, so the widget cannot import from `src/lib/`;
 * the server has no such restriction and already imports from here (same
 * inversion as `EN` in `./strings`). This file stays DOM-free and
 * dependency-free precisely so the Worker can import it.
 *
 * Tapping an emoji used to call `ctx.reload()`, which runs
 * `root.replaceChildren()` and rebuilds the entire shadow tree — losing scroll
 * position, open reply composers and typed drafts, on the single most frequent
 * interaction the widget has. Votes never did this; they patch in place from
 * the totals their POST returns. This is the same idea for reactions.
 *
 * The merge is pure and lives here rather than inline in embed.ts so the
 * bookkeeping — whose `mine` survives, which kinds disappear — can be tested
 * without a DOM.
 */

export type ReactionCount = { kind: string; count: number; mine: boolean };

export type ReactionKind = { kind: string; emoji: string };

/**
 * Every reaction a reader can leave, in render order.
 *
 * `kind` is the stored value — it goes in the `reactions.kind` /
 * `page_reactions.kind` column and travels the wire, so renaming one is a
 * migration, not an edit. `emoji` is presentation and can change freely.
 */
export const REACTION_KINDS: readonly ReactionKind[] = [
	{ kind: "like", emoji: "👍" },
	{ kind: "love", emoji: "❤️" },
	{ kind: "laugh", emoji: "😂" },
	{ kind: "hmm", emoji: "🤔" },
	{ kind: "cry", emoji: "😢" },
];

/** Membership test for the routes, derived so it cannot drift from the list. */
export const REACTION_KIND_SET: ReadonlySet<string> = new Set(
	REACTION_KINDS.map((r) => r.kind),
);

/**
 * Fold a toggle response back into a comment's reaction list.
 *
 * `totals` is authoritative for counts (it is a fresh aggregate over the
 * table, so it also picks up reactions other readers added since the thread
 * was fetched); `added` is authoritative for the caller's own `mine` on the
 * kind they just clicked. Every other kind keeps the `mine` it already had —
 * the server has no reason to re-send it and we have no reason to forget it.
 */
export const mergeReactionTotals = (
	prev: ReactionCount[],
	totals: Record<string, number>,
	toggled: string,
	added: boolean,
): ReactionCount[] => {
	const mine = new Map(prev.map((r) => [r.kind, r.mine]));
	mine.set(toggled, added);
	const out: ReactionCount[] = [];
	for (const [kind, count] of Object.entries(totals)) {
		// Zero-count kinds are absent from the tree payload too (the aggregate
		// GROUP BYs existing rows), so dropping them here keeps one shape.
		if (count > 0) out.push({ kind, count, mine: mine.get(kind) ?? false });
	}
	return out;
};
