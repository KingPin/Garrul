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
 *     live descendant; otherwise it's pruned. A hidden comment (spam, or
 *     someone else's pending) follows the same rule, so approved replies
 *     under it stay reachable. Removed nodes (hidden, or deleted by a
 *     moderator) render in one anonymous shape — see `isRemoved` and `toNode`.
 *
 * Tree assembly is pure-CPU and runs server-side so the widget receives
 * exactly what it needs to paint and never has to chase parent_id chains
 * on the client.
 */

import type { Comment, TreeComment } from "../db/queries";
import { t } from "../i18n";

/**
 * Deliberately no `is_admin`/`role`: the tree is served to anonymous readers,
 * and a per-author privilege flag in it lets anyone enumerate which accounts
 * are worth attacking. `role` was already withheld; `is_admin` was the same
 * fact under an older name. Nothing in the widget rendered a badge from it.
 *
 * The one role signal the tree does carry is per *comment*: `staff: true` on a
 * TreeNode whose author chose to post it as staff (migration 0026). An
 * unmarked comment by an admin looks exactly like anyone else's.
 */
export type TreeAuthor = {
	id: string;
	name: string;
	provider: string;
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
	/** Whether this node is shallow enough to be replied to, mirroring the
	 *  insert-time depth rule in src/routes/api.comments.ts exactly. Derived from
	 *  the *stored* 1-based depth, deliberately not `depth` above: past the
	 *  flatten threshold every node reports `depth === MAX_DEPTH` regardless of
	 *  how deep it really is, so a client gating on the render depth cannot tell
	 *  a repliable node from one the server would 400.
	 *
	 *  Depth only. The other reasons a POST can be refused — thread closed,
	 *  parent deleted, spam, rate limit — are orthogonal and not folded in here;
	 *  `true` means "the cap leaves room", not "this reply will succeed". */
	can_reply: boolean;
	reactions: ReactionCount[];
	score_up: number;
	score_down: number;
	/** -1 / 0 / 1; only meaningful for the requesting viewer. Anonymous
	 *  viewers always see 0 (and their list response is KV-cached). */
	my_vote: -1 | 0 | 1;
	/** Present (always `true`) only on the post's pinned thread. Omitted rather
	 *  than `false` so an unpinned tree serializes exactly as before. */
	pinned?: true;
	/** Present (true) only when the author posted this as staff. */
	staff?: true;
	replies: TreeNode[];
};

export const MAX_DEPTH = 4;

/**
 * Hard server-side cap on how deep a reply chain may go, enforced at insert
 * time against `comments.depth` (1-based: a top-level comment is 1).
 *
 * This is NOT the rendering threshold. MAX_DEPTH above is a *display* flatten
 * point — anything past it still renders, just un-indented — and replying stays
 * available all the way to this cap: the widget hides its reply button on
 * `can_reply`, which is computed from this constant, so the UI dead-ends exactly
 * where the insert path does.
 *
 * The cap landed when tree assembly was O(N^2) in chain length: a few hundred
 * chained comments exceeded the 10ms free-tier CPU budget, so the slug's comment
 * list returned Error 1102 to every reader — and since the response never
 * completed, the edge cache never populated and it never self-healed. Assembly is
 * linear now (see `markAncestors` and the iterative builder below), so that
 * particular cliff is gone, but the cap stays: nothing else stops a scripted
 * client from chaining unbounded replies that every reader then pays to assemble
 * on each cache miss, and past the flatten point the whole tail renders on one
 * tier anyway, so the depth buys nothing.
 *
 * 8 leaves headroom above the flatten point for imported threads (Disqus).
 */
export const MAX_REPLY_DEPTH = 8;

type ChildIndex = Map<string | null, TreeComment[]>;

const indexByParent = (rows: TreeComment[]): ChildIndex => {
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
 * How a row renders for one viewer. `live` rows render as themselves. `masked`
 * rows (spam, or someone else's pending) and `deleted` rows render only as
 * placeholders, and only where keepableSet keeps them.
 */
type Kind = "live" | "masked" | "deleted";

const kindOf = (r: TreeComment, viewerId: string | null): Kind => {
	if (r.status === "deleted") return "deleted";
	if (r.status === "approved") return "live";
	if (r.status === "pending" && viewerId !== null && r.user_id === viewerId) return "live";
	return "masked";
};

/** Hidden rows and moderator deletions share one public shape. */
const isRemoved = (row: TreeComment, kind: Kind): boolean =>
	kind === "masked" || (kind === "deleted" && row.deleted_by === "moderator");

/**
 * The author shown on every removed node. English on purpose, like the
 * placeholder eraseUser writes: the tree cache key carries no locale, so a
 * per-request translation would be served to every locale from one entry.
 */
const REMOVED_AUTHOR: TreeAuthor = {
	id: "",
	name: t("ui.deleted"),
	provider: "anon",
	avatar_svg: null,
	avatar_url: null,
};

/**
 * Returns the set of comment IDs that should remain visible: every live
 * comment, plus every hidden or deleted ancestor that has a live descendant.
 * When `keepAllDeleted` is set (the show_deleted_placeholders flag), deleted
 * comments are kept too — but only where no hidden row sits between them and
 * their nearest live ancestor. Otherwise a kept deleted leaf would pull its
 * spam parent back in through the ancestor pass, rendering a placeholder that
 * preserves no live discussion. listCommentsForThreads applies the same rule
 * in SQL; this copy keeps the builder correct on its own.
 */
const keepableSet = (
	rows: TreeComment[],
	kind: Map<string, Kind>,
	keepAllDeleted: boolean,
): Set<string> => {
	const parentOf = new Map<string, string | null>();
	for (const r of rows) parentOf.set(r.id, r.parent_id);

	// "Has a live descendant" is the same set as "is a strict ancestor of some
	// live comment", so it falls out of one upward pass instead of a recursive
	// descent per node (which was also stack-overflowable).
	const hasLiveDescendant = new Set<string>();
	markAncestors(
		rows.filter((r) => kind.get(r.id) === "live").map((r) => r.id),
		parentOf,
		hasLiveDescendant,
	);

	// Whether a masked row sits on the walk from `id` up to its nearest live
	// ancestor (inclusive of `id`). Memoized along each walk so the total stays
	// O(N), for the same reason as markAncestors; the path bound is its cycle
	// guard.
	const taint = new Map<string, boolean>();
	const isTainted = (id: string): boolean => {
		const path: string[] = [];
		let cur: string | null = id;
		let result = false;
		while (cur !== null && path.length <= parentOf.size) {
			const known = taint.get(cur);
			if (known !== undefined) {
				result = known;
				break;
			}
			const k = kind.get(cur);
			if (k === undefined || k === "live") break;
			path.push(cur);
			if (k === "masked") {
				result = true;
				break;
			}
			cur = parentOf.get(cur) ?? null;
		}
		for (const p of path) taint.set(p, result);
		return result;
	};

	const keep = new Set<string>();
	for (const r of rows) {
		const k = kind.get(r.id);
		if (k === "live" || hasLiveDescendant.has(r.id)) {
			keep.add(r.id);
		} else if (k === "deleted" && keepAllDeleted && !isTainted(r.id)) {
			keep.add(r.id);
		}
	}
	// Also keep any ancestor of a kept node so the chain stays intact. After
	// the rule above this only adds rows it already allows. Snapshot the seeds:
	// the walk grows `keep` as it goes.
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
		avatar_svg: null,
		avatar_url: null,
	};

const toNode = (
	row: TreeComment,
	kind: Kind,
	depth: number,
	flatten_from: string | null,
	usersById: Map<string, TreeAuthor>,
	reactionsById: Map<string, ReactionCount[]>,
	myVotes: Map<string, -1 | 1>,
): TreeNode => {
	if (isRemoved(row, kind)) {
		// Spam, someone else's pending and a moderator delete must be
		// indistinguishable to a reader: no author, no votes, no reactions, no
		// timestamps beyond the one sibling order needs. A real deleted_at next to
		// a null one would tell them apart, so neither carries one.
		return {
			id: row.id,
			parent_id: row.parent_id,
			body_html: "",
			status: "deleted",
			edited_at: null,
			deleted_at: null,
			deleted_by: "moderator",
			created_at: row.created_at,
			author: REMOVED_AUTHOR,
			depth,
			flatten_from,
			can_reply: row.depth < MAX_REPLY_DEPTH,
			reactions: [],
			score_up: 0,
			score_down: 0,
			my_vote: 0,
			replies: [],
		};
	}
	// Votes are public only on live nodes; listThreadRefsForPost sorts a
	// non-approved root as 0 for the same reason.
	const live = kind === "live";
	return {
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
		can_reply: row.depth < MAX_REPLY_DEPTH,
		reactions: reactionsById.get(row.id) ?? [],
		score_up: live ? (row.score_up ?? 0) : 0,
		score_down: live ? (row.score_down ?? 0) : 0,
		my_vote: myVotes.get(row.id) ?? 0,
		// A dormant pin (the row left `approved`) pages normally and is not flagged,
		// matching getPinnedThreadRef.
		...(row.pinned_at != null && row.status === "approved"
			? { pinned: true as const }
			: {}),
		// A tombstone keeps no badge: the author and body are gone, so a staff
		// mark would be a role claim about nothing.
		...(row.as_staff === 1 && row.status !== "deleted" ? { staff: true as const } : {}),
		replies: [],
	};
};

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
	row: TreeComment;
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
	kind: Map<string, Kind>,
	usersById: Map<string, TreeAuthor>,
	byId: Map<string, TreeComment>,
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
				kind.get(frame.row.id)!,
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
			// Through the removed check, so a hidden parent's name never leaks
			// via the "@name" prefix of a flattened reply.
			const parentAuthorName =
				parentRow == null
					? null
					: isRemoved(parentRow, kind.get(parentRow.id)!)
						? REMOVED_AUTHOR.name
						: buildAuthor(usersById, parentRow.user_id).name;
			frame.out.push(
				toNode(
					frame.row,
					kind.get(frame.row.id)!,
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
	rows: TreeComment[],
	usersById: Map<string, TreeAuthor>,
	reactionsById: Map<string, ReactionCount[]> = new Map(),
	myVotes: Map<string, -1 | 1> = new Map(),
	opts: { keepAllDeleted?: boolean; viewerId?: string | null } = {},
): BuildResult => {
	const byId = new Map<string, TreeComment>();
	for (const r of rows) byId.set(r.id, r);
	const kind = new Map<string, Kind>();
	for (const r of rows) kind.set(r.id, kindOf(r, opts.viewerId ?? null));
	const children = indexByParent(rows);
	const keep = keepableSet(rows, kind, opts.keepAllDeleted ?? false);

	const tops = (children.get(null) ?? []).filter((t) => keep.has(t.id));
	const threads: TreeNode[] = [];
	for (const t of tops) {
		const node = toNode(t, kind.get(t.id)!, 0, null, usersById, reactionsById, myVotes);
		node.replies = buildSubtree(
			t.id,
			1,
			children,
			keep,
			kind,
			usersById,
			byId,
			reactionsById,
			myVotes,
		);
		threads.push(node);
	}
	return { threads };
};
