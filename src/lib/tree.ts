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
 * Returns the set of comment IDs that should remain visible — every non-
 * deleted comment, plus every deleted ancestor that has a non-deleted
 * descendant.
 */
const keepableSet = (rows: Comment[], children: ChildIndex): Set<string> => {
	const byId = new Map<string, Comment>();
	for (const r of rows) byId.set(r.id, r);

	const hasLiveDescendant = new Map<string, boolean>();
	const visit = (id: string): boolean => {
		const cached = hasLiveDescendant.get(id);
		if (cached !== undefined) return cached;
		const kids = children.get(id) ?? [];
		let live = false;
		for (const k of kids) {
			if (k.status !== "deleted") live = true;
			if (visit(k.id)) live = true;
		}
		hasLiveDescendant.set(id, live);
		return live;
	};

	const keep = new Set<string>();
	for (const r of rows) {
		if (r.status !== "deleted") {
			keep.add(r.id);
		} else if (visit(r.id)) {
			keep.add(r.id);
		}
	}
	// Also keep any ancestor of a kept node so the chain stays intact.
	const ancestors = (id: string) => {
		let cur = byId.get(id)?.parent_id ?? null;
		while (cur) {
			keep.add(cur);
			cur = byId.get(cur)?.parent_id ?? null;
		}
	};
	for (const id of [...keep]) ancestors(id);
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
 * Recursive build with depth flattening. Anything past MAX_DEPTH is
 * appended to the depth-MAX_DEPTH ancestor's `replies`, with `depth =
 * MAX_DEPTH` and `flatten_from` set to the immediate parent's author name.
 */
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
	const kids = (children.get(parentId) ?? []).filter((k) => keep.has(k.id));
	if (kids.length === 0) return [];
	const out: TreeNode[] = [];
	for (const k of kids) {
		if (depth < MAX_DEPTH) {
			const node = toNode(k, depth, null, usersById, reactionsById, myVotes);
			node.replies = buildSubtree(
				k.id,
				depth + 1,
				children,
				keep,
				usersById,
				byId,
				reactionsById,
				myVotes,
			);
			out.push(node);
		} else {
			// At-or-beyond depth cap: lift to current level with flatten_from
			// pointing to the immediate-parent author's name.
			const parentRow = byId.get(parentId);
			const parentAuthorName =
				parentRow != null
					? buildAuthor(usersById, parentRow.user_id).name
					: null;
			const node = toNode(k, MAX_DEPTH, parentAuthorName, usersById, reactionsById, myVotes);
			out.push(node);
			// Continue chasing the flattened descendants so nothing is dropped.
			const descendants = buildSubtree(
				k.id,
				depth + 1,
				children,
				keep,
				usersById,
				byId,
				reactionsById,
				myVotes,
			);
			for (const d of descendants) out.push(d);
		}
	}
	return out;
};

export type BuildResult = {
	threads: TreeNode[];
};

export const buildTree = (
	rows: Comment[],
	usersById: Map<string, TreeAuthor>,
	reactionsById: Map<string, ReactionCount[]> = new Map(),
	myVotes: Map<string, -1 | 1> = new Map(),
): BuildResult => {
	const byId = new Map<string, Comment>();
	for (const r of rows) byId.set(r.id, r);
	const children = indexByParent(rows);
	const keep = keepableSet(rows, children);

	const tops = (children.get(null) ?? []).filter((t) => keep.has(t.id));
	const threads: TreeNode[] = [];
	for (const t of tops) {
		const node = toNode(t, 0, null, usersById, reactionsById, myVotes);
		node.replies = buildSubtree(t.id, 1, children, keep, usersById, byId, reactionsById, myVotes);
		threads.push(node);
	}
	return { threads };
};
