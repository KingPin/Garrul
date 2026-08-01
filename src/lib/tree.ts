/**
 * Comment tree assembly.
 *
 * Input:  flat list of comments (with parent_id chains) + user map.
 * Output: serialized top-level thread nodes with nested replies, where:
 *   - Top-level threads are sorted by created_at ASC.
 *   - Replies under each parent are sorted by created_at ASC.
 *   - Depth is capped at MAX_DEPTH. Anything deeper renders FLAT under
 *     its level-(MAX_DEPTH-1) ancestor with a leading "@parent_name "
 *     prefix in `flatten_from`. The UI uses that to render the same
 *     visual indent regardless of true depth, but still attribute who
 *     was replied to.
 *   - A `deleted` comment is kept in the tree IFF it has at least one
 *     non-deleted descendant; otherwise it's pruned. body_html is
 *     replaced with the empty string for deleted nodes — the widget
 *     renders the [deleted] placeholder.
 *
 * Tree assembly is pure-CPU and runs server-side so the widget receives
 * exactly what it needs to paint and never has to chase parent_id chains
 * on the client.
 */

import type { Comment } from "../db/queries";

export type TreeAuthor = {
	id: string;
	name: string;
	provider: string;
	is_admin: boolean;
	avatar_svg: string | null;
	avatar_url: string | null;
};

export type ReactionCount = {
	kind: string;
	count: number;
	mine: boolean;
};

export type TreeNode = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: Comment["status"];
	edited_at: number | null;
	deleted_at: number | null;
	/** Who removed a deleted comment ('author' | 'moderator'), for the
	 *  placeholder wording. NULL when not deleted. */
	deleted_by: Comment["deleted_by"];
	created_at: number;
	author: TreeAuthor;
	depth: number;
	/** When non-null, this node was lifted out of its real parent (depth >
	 *  MAX_DEPTH) and the UI should show "@<flatten_from> ..." prefix. */
	flatten_from: string | null;
	reactions: ReactionCount[];
	score_up: number;
	score_down: number;
	/** -1 / 0 / 1; only meaningful for the requesting viewer. Anonymous
	 *  viewers always see 0 (and their list response is KV-cached). */
	my_vote: -1 | 0 | 1;
	replies: TreeNode[];
};

export const MAX_DEPTH = 4;

/**
 * Hard server-side cap on how deep a reply chain may go, enforced at insert
 * time against `comments.depth` (1-based: a top-level comment is 1).
 *
 * This is NOT the rendering threshold. MAX_DEPTH above is a *display* flatten
 * point — anything past it still renders, just un-indented — and the widget
 * already hides the reply button at `n.depth < MAX_DEPTH`, so no reachable UI
 * path creates a chain this long. The cap exists because nothing stopped a
 * scripted client from doing it: tree assembly is O(N^2) in chain length, so a
 * few hundred chained comments exceed the 10ms free-tier CPU budget and the
 * slug's comment list starts returning Error 1102 to every reader — and since
 * the response never completes, the edge cache never populates and it never
 * self-heals.
 *
 * 8 leaves headroom above the flatten point for imported threads (Disqus).
 */
export const MAX_REPLY_DEPTH = 8;

type ChildIndex = Map<string | null, Comment[]>;

const indexByParent = (rows: Comment[]): ChildIndex => {
	const idx: ChildIndex = new Map();
	for (const row of rows) {
		const list = idx.get(row.parent_id) ?? [];
		list.push(row);
		idx.set(row.parent_id, list);
	}
	for (const list of idx.values()) {
		list.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
	}
	return idx;
};

/**
 * Adds every strict ancestor of every seed id to `out`.
 *
 * O(N) in total across all seeds, not O(N * chain length): the walk up from a
 * seed stops at the first node already known to have its whole ancestor chain
 * in `out` (`closed`), so each parent edge is traversed at most once. The
 * previous implementation re-walked the full chain for every node, which is
 * O(N^2) in chain length — measured at 223ms for a 5,000-deep chain against a
 * 10ms free-tier CPU budget, i.e. a few hundred comments were already enough
 * to make a slug's comment list permanently un-renderable.
 *
 * The `path.length` bound is a cycle guard. `parent_id` cannot cycle today (a
 * comment can only reference one that already existed), but the failure mode
 * of being wrong about that is an infinite loop, not a bad render.
 */
const markAncestors = (
	seeds: Iterable<string>,
	parentOf: Map<string, string | null>,
	out: Set<string>,
) => {
	const closed = new Set<string>();
	for (const seed of seeds) {
		const path: string[] = [];
		let cur = parentOf.get(seed) ?? null;
		while (cur !== null && !closed.has(cur) && path.length <= parentOf.size) {
			out.add(cur);
			path.push(cur);
			cur = parentOf.get(cur) ?? null;
		}
		for (const p of path) closed.add(p);
		closed.add(seed);
	}
};

/**
 * Returns the set of comment IDs that should remain visible — every non-
 * deleted comment, plus every deleted ancestor that has a non-deleted
 * descendant. When `keepAllDeleted` is set (the show_deleted_placeholders
 * flag), every deleted comment is kept too, so leaf deletions surface as a
 * placeholder rather than being pruned.
 */
const keepableSet = (rows: Comment[], keepAllDeleted: boolean): Set<string> => {
	const parentOf = new Map<string, string | null>();
	for (const r of rows) parentOf.set(r.id, r.parent_id);

	// "Has a live descendant" is the same set as "is a strict ancestor of some
	// non-deleted comment", so it falls out of one upward pass instead of a
	// recursive descent per node (which was also stack-overflowable).
	const hasLiveDescendant = new Set<string>();
	markAncestors(
		rows.filter((r) => r.status !== "deleted").map((r) => r.id),
		parentOf,
		hasLiveDescendant,
	);

	const keep = new Set<string>();
	for (const r of rows) {
		if (r.status !== "deleted") {
			keep.add(r.id);
		} else if (keepAllDeleted || hasLiveDescendant.has(r.id)) {
			keep.add(r.id);
		}
	}
	// Also keep any ancestor of a kept node so the chain stays intact. Snapshot
	// the seeds: the walk grows `keep` as it goes.
	markAncestors([...keep], parentOf, keep);
	return keep;
};

const buildAuthor = (
	usersById: Map<string, TreeAuthor>,
	user_id: string,
): TreeAuthor =>
	usersById.get(user_id) ?? {
		id: user_id,
		name: "unknown",
		provider: "anon",
		is_admin: false,
		avatar_svg: null,
		avatar_url: null,
	};

const toNode = (
	row: Comment,
	depth: number,
	flatten_from: string | null,
	usersById: Map<string, TreeAuthor>,
	reactionsById: Map<string, ReactionCount[]>,
	myVotes: Map<string, -1 | 1>,
): TreeNode => ({
	id: row.id,
	parent_id: row.parent_id,
	body_html: row.status === "deleted" ? "" : row.body_html,
	status: row.status,
	edited_at: row.edited_at,
	deleted_at: row.deleted_at,
	deleted_by: row.status === "deleted" ? row.deleted_by : null,
	created_at: row.created_at,
	author: buildAuthor(usersById, row.user_id),
	depth,
	flatten_from,
	reactions: reactionsById.get(row.id) ?? [],
	score_up: row.score_up ?? 0,
	score_down: row.score_down ?? 0,
	my_vote: myVotes.get(row.id) ?? 0,
	replies: [],
});

/**
 * Iterative build with depth flattening. Anything past MAX_DEPTH is appended
 * to the depth-MAX_DEPTH ancestor's `replies`, with `depth = MAX_DEPTH` and
 * `flatten_from` set to the immediate parent's author name.
 *
 * Iterative rather than recursive on purpose: the old version recursed once
 * per level *including past the flatten threshold*, so a long enough reply
 * chain blew the stack regardless of the O(N^2) cost. MAX_REPLY_DEPTH caps new
 * chains, but rows predating it — and Disqus imports — can still be arbitrarily
 * deep, and a RangeError here 500s the whole comment list.
 *
 * Frames are pushed in reverse sibling order so popping yields DFS pre-order,
 * which is what keeps flattened descendants sitting directly after the node
 * they were lifted out of.
 *
 * `depth` here is the *render* depth from the traversal, deliberately not
 * `row.depth`: a re-parented import or a legacy over-deep row would report a
 * stored depth that doesn't match where it actually renders.
 */
type Frame = {
	row: Comment;
	parentId: string;
	/** Depth this node renders at, before flatten clamping. */
	depth: number;
	/** Array this node is appended to — a parent's `replies`, or, once past the
	 *  flatten threshold, the shared array of the level it was lifted to. */
	out: TreeNode[];
};

const buildSubtree = (
	parentId: string,
	depth: number,
	children: ChildIndex,
	keep: Set<string>,
	usersById: Map<string, TreeAuthor>,
	byId: Map<string, Comment>,
	reactionsById: Map<string, ReactionCount[]>,
	myVotes: Map<string, -1 | 1>,
): TreeNode[] => {
	const top: TreeNode[] = [];
	const kids = (children.get(parentId) ?? []).filter((k) => keep.has(k.id));
	if (kids.length === 0) return top;

	const stack: Frame[] = [];
	const push = (pid: string, d: number, out: TreeNode[]) => {
		const list = (children.get(pid) ?? []).filter((k) => keep.has(k.id));
		for (let i = list.length - 1; i >= 0; i--) {
			stack.push({ row: list[i]!, parentId: pid, depth: d, out });
		}
	};
	push(parentId, depth, top);

	// Cycle backstop: in a forest no id is reachable twice, so this only ever
	// fires on a malformed parent_id cycle — where the alternative is an
	// infinite loop.
	const emitted = new Set<string>();

	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (emitted.has(frame.row.id)) continue;
		emitted.add(frame.row.id);

		if (frame.depth < MAX_DEPTH) {
			const node = toNode(
				frame.row,
				frame.depth,
				null,
				usersById,
				reactionsById,
				myVotes,
			);
			frame.out.push(node);
			push(frame.row.id, frame.depth + 1, node.replies);
		} else {
			// At-or-beyond the flatten threshold: lift to the current level with
			// flatten_from pointing at the immediate parent's author name, and keep
			// chasing descendants into the same array so nothing is dropped.
			const parentRow = byId.get(frame.parentId);
			const parentAuthorName =
				parentRow != null ? buildAuthor(usersById, parentRow.user_id).name : null;
			frame.out.push(
				toNode(
					frame.row,
					MAX_DEPTH,
					parentAuthorName,
					usersById,
					reactionsById,
					myVotes,
				),
			);
			push(frame.row.id, frame.depth + 1, frame.out);
		}
	}
	return top;
};

export type BuildResult = {
	threads: TreeNode[];
};

export const buildTree = (
	rows: Comment[],
	usersById: Map<string, TreeAuthor>,
	reactionsById: Map<string, ReactionCount[]> = new Map(),
	myVotes: Map<string, -1 | 1> = new Map(),
	opts: { keepAllDeleted?: boolean } = {},
): BuildResult => {
	const byId = new Map<string, Comment>();
	for (const r of rows) byId.set(r.id, r);
	const children = indexByParent(rows);
	const keep = keepableSet(rows, opts.keepAllDeleted ?? false);

	const tops = (children.get(null) ?? []).filter((t) => keep.has(t.id));
	const threads: TreeNode[] = [];
	for (const t of tops) {
		const node = toNode(t, 0, null, usersById, reactionsById, myVotes);
		node.replies = buildSubtree(t.id, 1, children, keep, usersById, byId, reactionsById, myVotes);
		threads.push(node);
	}
	return { threads };
};
