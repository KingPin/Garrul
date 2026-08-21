/**
 * The shape the comment renderer draws, and how to build one of those from the
 * 201 echo of `POST /api/v1/comments` instead of from a second round trip.
 *
 * Lives outside embed.ts for the same reason boot.ts does: the interesting part
 * is arithmetic — what depth a new reply renders at, whether it gets a flatten
 * prefix, which list it belongs in — and embed.ts needs a DOM to load, so none
 * of it would otherwise be reachable from the `node` test pool.
 *
 * Unlike boot.ts this module *does* know the renderer's node shape. That is not
 * an inconsistency: boot.ts refuses to know it (see the comment on
 * `BootstrapResponse.comments`) because it only has to recognize a tree well
 * enough to decide whether to fall back, whereas this module has to *produce*
 * one that the renderer will accept.
 */
import type { SortKey } from "./boot";
import type { ReactionCount } from "./reactions";

/**
 * Mirrors lib/tree.ts's TreeAuthor. No `is_admin`: the API stopped sending it
 * (it let anyone enumerate privileged accounts) and nothing here rendered it.
 */
export type TreeAuthor = {
	id: string;
	name: string;
	provider: string;
	avatar_svg: string | null;
	avatar_url: string | null;
};

export type TreeNode = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: "approved" | "pending" | "spam" | "deleted";
	edited_at: number | null;
	deleted_at: number | null;
	deleted_by: "author" | "moderator" | null;
	created_at: number;
	author: TreeAuthor;
	depth: number;
	flatten_from: string | null;
	/** Optional on purpose: the list response is edge-cached, so payloads
	 *  predating this field keep being served for up to TREE_CACHE_TTL after a
	 *  deploy. Read it through the `n.depth < 4` fallback in embed.ts, never
	 *  bare. `synthesizePosted` leans on that same fallback deliberately — see
	 *  its note on why it omits the field rather than computing it. */
	can_reply?: boolean;
	reactions: ReactionCount[];
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
	replies: TreeNode[];
};

/**
 * Display flatten threshold: anything nested deeper renders un-indented on this
 * tier with an "@parent" prefix instead.
 *
 * Mirror of `MAX_DEPTH` in src/lib/tree.ts. Duplicated rather than imported
 * because tsconfig.widget.json includes only `src/widget/**`, so the widget
 * bundle cannot reach server modules — the same reason embed.ts keeps its own
 * copy of the OAuth provider union.
 */
export const MAX_DEPTH = 4;

/**
 * The comment `POST /api/v1/comments` echoes back on 201 — the fields of
 * `serializeComment` (src/routes/api.comments.ts) that the renderer needs.
 *
 * `post_slug` is in the real payload and deliberately absent here: nothing in
 * the render path reads it.
 */
export type PostedEcho = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: TreeNode["status"];
	edited_at: number | null;
	deleted_at: number | null;
	deleted_by: TreeNode["deleted_by"];
	created_at: number;
	author: TreeAuthor;
};

const STATUSES: ReadonlySet<string> = new Set([
	"approved",
	"pending",
	"spam",
	"deleted",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

const nullableNumber = (v: unknown): number | null =>
	typeof v === "number" ? v : null;

const nullableString = (v: unknown): string | null =>
	typeof v === "string" ? v : null;

/**
 * Narrow a `{ comment: … }` body to something renderable, or `null`.
 *
 * `null` is not an error — it is the signal to take the old post-then-reload
 * path. A widget bundle can outlive the Worker it talks to (the same premise
 * behind boot.ts's bootstrap fallback), and a Worker whose echo predates a
 * field the renderer needs would otherwise produce a comment with a blank body
 * or a missing avatar. Validating here means the degraded case costs one extra
 * request rather than one broken comment.
 */
export const readPostedEcho = (body: unknown): PostedEcho | null => {
	if (!isRecord(body)) return null;
	const author = body.author;
	if (
		typeof body.id !== "string" ||
		typeof body.body_html !== "string" ||
		typeof body.created_at !== "number" ||
		typeof body.status !== "string" ||
		!STATUSES.has(body.status) ||
		!isRecord(author) ||
		typeof author.id !== "string" ||
		typeof author.name !== "string" ||
		typeof author.provider !== "string"
	) {
		return null;
	}
	const deletedBy = body.deleted_by;
	return {
		id: body.id,
		parent_id: nullableString(body.parent_id),
		body_html: body.body_html,
		status: body.status as TreeNode["status"],
		edited_at: nullableNumber(body.edited_at),
		deleted_at: nullableNumber(body.deleted_at),
		deleted_by:
			deletedBy === "author" || deletedBy === "moderator" ? deletedBy : null,
		created_at: body.created_at,
		author: {
			id: author.id,
			name: author.name,
			provider: author.provider,
			avatar_svg: nullableString(author.avatar_svg),
			avatar_url: nullableString(author.avatar_url),
		},
	};
};

/**
 * Which list a new reply joins, and how it renders once it is there.
 *
 * `into` distinguishes the two cases the server's tree builder produces: a
 * normal reply is appended to its parent's own `replies`, but a reply to a node
 * that has *already* been flattened is lifted to the parent's own tier and
 * becomes its sibling, because that is where buildSubtree pushes descendants
 * once past the threshold (it keeps chasing them into `frame.out`).
 */
export type ReplySlot = {
	into: "replies" | "siblings";
	depth: number;
	flatten_from: string | null;
};

/**
 * Mirror of the flatten rule in `buildSubtree` (src/lib/tree.ts), stated in
 * terms of the parent node the widget already has on screen rather than the
 * traversal frame the server has.
 *
 * The `flatten_from` label is the *immediate* parent's author name in both
 * flattened cases, which is what makes them collapse into one branch here.
 */
export const replySlot = (parent: TreeNode): ReplySlot => {
	const depth = parent.depth + 1;
	if (depth < MAX_DEPTH) {
		return { into: "replies", depth, flatten_from: null };
	}
	return {
		into: parent.depth >= MAX_DEPTH ? "siblings" : "replies",
		depth: MAX_DEPTH,
		flatten_from: parent.author.name,
	};
};

/**
 * Where a brand-new *top-level* comment goes in the page already rendered.
 *
 * Replies need no such decision: the server orders every reply list
 * `created_at ASC` regardless of `?sort=` (see `listCommentsForThreads` in
 * src/db/queries.ts), so the newest reply is genuinely last in its parent's
 * list and appending it is the truth.
 *
 * Top-level order is the sort key, and only `new` puts a fresh comment
 * somewhere this page can honestly claim. Under `old` it belongs after every
 * comment on every page, including pages not loaded yet; under `top` its
 * position depends on scores it does not have. Both get the end and the start
 * of the rendered page respectively — near where the reader is looking — and
 * the caller marks the node as theirs so it reads as "here is what you posted"
 * rather than as a claim about thread order. The next real load puts it where
 * it actually belongs.
 */
export const topLevelPlacement = (sort: SortKey): "prepend" | "append" =>
	sort === "old" ? "append" : "prepend";

/**
 * Build the node to render from the echo, given the parent it was a reply to
 * (`null` for a top-level comment).
 *
 * Everything the echo does not carry is what a comment nobody has seen yet must
 * be: no reactions, no votes, no replies.
 *
 * `can_reply` is deliberately left unset rather than computed. The server
 * derives it from the *stored* depth against `MAX_REPLY_DEPTH` (8), and stored
 * depth is not recoverable from a flattened node — every node on the threshold
 * tier reports `depth === MAX_DEPTH` whatever its real nesting. Leaving the
 * field absent hands the decision to embed.ts's documented `?? n.depth < 4`
 * fallback, which is the same answer the widget already gives for an
 * edge-cached payload that predates the field. The cost is that a reply to a
 * freshly posted comment on the flattened tier is unavailable until the next
 * load; the alternative is a second depth model in the widget that would be
 * wrong in the other direction.
 */
export const synthesizePosted = (
	echo: PostedEcho,
	parent: TreeNode | null,
): { node: TreeNode; slot: ReplySlot | null } => {
	const slot = parent ? replySlot(parent) : null;
	return {
		node: {
			id: echo.id,
			parent_id: echo.parent_id,
			body_html: echo.body_html,
			status: echo.status,
			edited_at: echo.edited_at,
			deleted_at: echo.deleted_at,
			deleted_by: echo.deleted_by,
			created_at: echo.created_at,
			author: echo.author,
			depth: slot ? slot.depth : 0,
			flatten_from: slot ? slot.flatten_from : null,
			reactions: [],
			score_up: 0,
			score_down: 0,
			my_vote: 0,
			replies: [],
		},
		slot,
	};
};
