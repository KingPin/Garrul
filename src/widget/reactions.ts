/**
 * Reaction state merging.
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
