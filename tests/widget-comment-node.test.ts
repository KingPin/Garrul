/**
 * Building a renderable comment from the 201 echo of `POST /api/v1/comments`
 * (src/widget/comment-node.ts).
 *
 * The point of the module is that a successful post no longer costs a second
 * request, which means the widget now computes for itself three things the list
 * endpoint used to hand it: what depth the new comment renders at, whether it
 * carries a flatten prefix, and which list it joins. Those have to agree with
 * `buildSubtree` in src/lib/tree.ts or a reply will render on the wrong tier
 * until the next load — so the flatten cases here are checked against that
 * function's rule, not against what looks plausible.
 *
 * `readPostedEcho` is covered for the same reason boot.ts's fallback is: the
 * degraded answer has to be "take the old path", never "render a blank
 * comment".
 */
import { describe, expect, it } from "vitest";
import {
	MAX_DEPTH,
	type PostedEcho,
	type TreeNode,
	readPostedEcho,
	replySlot,
	synthesizePosted,
	topLevelPlacement,
} from "../src/widget/comment-node";

const author = {
	id: "u1",
	name: "Ada",
	provider: "github",
	avatar_svg: null,
	avatar_url: "https://example.com/a.png",
};

const echo = (over: Partial<PostedEcho> = {}): PostedEcho => ({
	id: "c1",
	parent_id: null,
	body_html: "<p>hi</p>",
	status: "approved",
	edited_at: null,
	deleted_at: null,
	deleted_by: null,
	created_at: 1_700_000_000_000,
	author,
	...over,
});

/** A rendered parent node, only the fields the slot rules read. */
const parentAt = (depth: number, name = "Grace"): TreeNode => ({
	id: `p${depth}`,
	parent_id: null,
	body_html: "",
	status: "approved",
	edited_at: null,
	deleted_at: null,
	deleted_by: null,
	created_at: 0,
	author: { ...author, id: "u2", name },
	depth,
	flatten_from: depth >= MAX_DEPTH ? "Someone" : null,
	reactions: [],
	score_up: 0,
	score_down: 0,
	my_vote: 0,
	replies: [],
});

describe("synthesizePosted", () => {
	it("renders a top-level comment at depth 0 with no flatten prefix", () => {
		const { node, slot } = synthesizePosted(echo(), null);
		expect(slot).toBeNull();
		expect(node.depth).toBe(0);
		expect(node.flatten_from).toBeNull();
	});

	it("carries the echo's own id, body, status and timestamp through", () => {
		const { node } = synthesizePosted(
			echo({ id: "abc", status: "pending", created_at: 42 }),
			null,
		);
		expect(node.id).toBe("abc");
		expect(node.body_html).toBe("<p>hi</p>");
		// The badge the renderer draws off this is the whole reason the echo is
		// used rather than a guess: whether a comment is held for moderation is a
		// server verdict (muted words, Akismet, Workers AI, first-comment hold).
		expect(node.status).toBe("pending");
		expect(node.created_at).toBe(42);
		expect(node.author).toEqual(author);
	});

	it("starts with no reactions, no votes and no replies", () => {
		const { node } = synthesizePosted(echo(), null);
		expect(node.reactions).toEqual([]);
		expect(node.score_up).toBe(0);
		expect(node.score_down).toBe(0);
		expect(node.my_vote).toBe(0);
		expect(node.replies).toEqual([]);
	});

	it("leaves can_reply unset so the renderer's depth fallback decides", () => {
		// Not `false`, and not a computed guess: stored depth is unrecoverable
		// from a flattened node, so the field's absence is the honest answer and
		// embed.ts's `?? n.depth < 4` is the same rule it already applies to an
		// edge-cached payload that predates the field.
		const { node } = synthesizePosted(echo(), null);
		expect("can_reply" in node).toBe(false);
	});

	it("nests a reply one level under its parent", () => {
		const { node, slot } = synthesizePosted(
			echo({ parent_id: "p1" }),
			parentAt(1),
		);
		expect(node.depth).toBe(2);
		expect(node.flatten_from).toBeNull();
		expect(slot).toEqual({ into: "replies", depth: 2, flatten_from: null });
	});
});

describe("replySlot", () => {
	it("keeps replies nested while they stay under the flatten threshold", () => {
		for (const depth of [0, 1, 2]) {
			expect(replySlot(parentAt(depth))).toEqual({
				into: "replies",
				depth: depth + 1,
				flatten_from: null,
			});
		}
	});

	it("flattens a reply that would cross the threshold, keeping it in the parent's list", () => {
		// buildSubtree emits the child of a depth-(MAX_DEPTH-1) frame into that
		// node's own `replies` — clamped to MAX_DEPTH and labelled — so the reply
		// is still nested one level, it just renders un-indented.
		expect(replySlot(parentAt(MAX_DEPTH - 1, "Grace"))).toEqual({
			into: "replies",
			depth: MAX_DEPTH,
			flatten_from: "Grace",
		});
	});

	it("makes a reply to an already-flattened comment its sibling", () => {
		// Past the threshold buildSubtree pushes descendants into `frame.out` —
		// the array the parent itself sits in — so the reply joins the same tier
		// rather than nesting under a node that is already un-indented.
		expect(replySlot(parentAt(MAX_DEPTH, "Grace"))).toEqual({
			into: "siblings",
			depth: MAX_DEPTH,
			flatten_from: "Grace",
		});
	});

	it("never renders deeper than the flatten threshold", () => {
		// Imported threads (Disqus) can be nested past MAX_DEPTH, so the parent on
		// screen can report the clamped depth with real nesting far below it.
		for (const depth of [MAX_DEPTH, MAX_DEPTH + 3]) {
			expect(replySlot(parentAt(depth)).depth).toBe(MAX_DEPTH);
		}
	});

	it("labels the flatten prefix with the immediate parent, not an ancestor", () => {
		expect(replySlot(parentAt(MAX_DEPTH, "Immediate")).flatten_from).toBe(
			"Immediate",
		);
	});
});

describe("topLevelPlacement", () => {
	it("puts a new comment first under the newest-first orders", () => {
		expect(topLevelPlacement("new")).toBe("prepend");
		// `top` ranks by score, which a comment nobody has voted on does not have.
		// First is where the reader is looking, and the caller marks it as theirs.
		expect(topLevelPlacement("top")).toBe("prepend");
	});

	it("puts a new comment last under oldest-first", () => {
		// Where issue #94 bit: `ctx.reload()` re-fetched page 1, and under `old` a
		// new top-level comment belongs on the *last* page, so on a thread past
		// comments_per_page the reader's own comment was nowhere on screen.
		expect(topLevelPlacement("old")).toBe("append");
	});
});

describe("readPostedEcho", () => {
	const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
		id: "c1",
		post_slug: "hello",
		parent_id: null,
		body_html: "<p>hi</p>",
		status: "approved",
		edited_at: null,
		deleted_at: null,
		deleted_by: null,
		created_at: 1_700_000_000_000,
		author: { ...author },
		...over,
	});

	it("accepts the real serializeComment payload", () => {
		const read = readPostedEcho(body());
		expect(read?.id).toBe("c1");
		expect(read?.author.name).toBe("Ada");
	});

	it("ignores post_slug, which nothing in the render path reads", () => {
		expect(readPostedEcho(body())).not.toHaveProperty("post_slug");
	});

	it("keeps a pending status rather than normalizing it", () => {
		expect(readPostedEcho(body({ status: "pending" }))?.status).toBe("pending");
	});

	it("rejects a body missing any field the renderer needs", () => {
		for (const missing of ["id", "body_html", "created_at", "status", "author"]) {
			expect(readPostedEcho(body({ [missing]: undefined }))).toBeNull();
		}
	});

	it("rejects a status it does not know how to render", () => {
		expect(readPostedEcho(body({ status: "quarantined" }))).toBeNull();
	});

	it("rejects an author missing its identity fields", () => {
		for (const missing of ["id", "name", "provider"]) {
			const a: Record<string, unknown> = { ...author };
			delete a[missing];
			expect(readPostedEcho(body({ author: a }))).toBeNull();
		}
	});

	it("rejects a non-object body, including the absent one", () => {
		for (const v of [undefined, null, "c1", 7, []]) {
			expect(readPostedEcho(v)).toBeNull();
		}
	});

	it("tolerates an absent avatar on either side", () => {
		const read = readPostedEcho(
			body({ author: { ...author, avatar_svg: undefined, avatar_url: undefined } }),
		);
		expect(read?.author.avatar_svg).toBeNull();
		expect(read?.author.avatar_url).toBeNull();
	});

	it("drops a deleted_by it does not recognize", () => {
		expect(readPostedEcho(body({ deleted_by: "somebody" }))?.deleted_by).toBeNull();
		expect(readPostedEcho(body({ deleted_by: "author" }))?.deleted_by).toBe("author");
	});
});
