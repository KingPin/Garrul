/**
 * Tree assembly tests — depth cap (4 levels deep, 5–6 flatten), deleted-
 * parent placeholder iff descendants are alive, and ordering by
 * created_at ASC.
 */
import { describe, it, expect } from "vitest";
import type { Comment } from "../src/db/queries";
import {
	buildTree,
	MAX_DEPTH,
	MAX_REPLY_DEPTH,
	type TreeAuthor,
	type TreeNode,
} from "../src/lib/tree";

const author = (id: string, name = id, provider = "anon"): TreeAuthor => ({
	id,
	name,
	provider,
	avatar_svg: null,
	avatar_url: null,
});

const usersById = (...authors: TreeAuthor[]): Map<string, TreeAuthor> => {
	const m = new Map<string, TreeAuthor>();
	for (const a of authors) m.set(a.id, a);
	return m;
};

const mk = (
	id: string,
	parent_id: string | null,
	created_at: number,
	user_id = "u1",
	status: Comment["status"] = "approved",
	deleted_by: Comment["deleted_by"] = status === "deleted" ? "author" : null,
	depth = 1,
): Comment => ({
	id,
	post_slug: "p",
	parent_id,
	user_id,
	body_md: `body of ${id}`,
	body_html: `<p>${id}</p>`,
	renderer_version: 1,
	status,
	edited_at: null,
	deleted_at: status === "deleted" ? created_at + 1 : null,
	deleted_by,
	ip_hash: null,
	user_agent: null,
	created_at,
	// Render depth still comes from the traversal, not from this column (a
	// re-parented import would otherwise report a depth that doesn't match where
	// it renders) — but `can_reply` is derived from it, because that is the
	// column the insert path caps against. Tests that assert on can_reply must
	// pass a realistic value; the rest can leave it at the top-level default.
	depth,
	score_up: 0,
	score_down: 0,
	pinned_at: null,
	as_staff: 0,
});

/** Chain of `n` comments, each a reply to the previous. Stored depth ascends
 *  with the chain, matching what the insert path would have written. */
const chain = (n: number): Comment[] =>
	Array.from({ length: n }, (_, i) =>
		mk(`c${i}`, i === 0 ? null : `c${i - 1}`, 1000 + i, "u1", "approved", null, i + 1),
	);

describe("buildTree — basic shape and order", () => {
	it("returns top-level threads sorted by created_at ASC", () => {
		const rows = [mk("b", null, 200), mk("a", null, 100), mk("c", null, 300)];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
	});

	it("nests replies under parents and sorts by created_at ASC", () => {
		const rows = [
			mk("root", null, 100),
			mk("r2", "root", 220),
			mk("r1", "root", 210),
		];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads).toHaveLength(1);
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
	});
});

describe("buildTree — depth cap", () => {
	it("keeps levels 0..MAX_DEPTH-1 nested", () => {
		const rows: Comment[] = [];
		// Chain length = MAX_DEPTH levels of nesting (depths 0..MAX_DEPTH-1).
		let prev: string | null = null;
		for (let d = 0; d < MAX_DEPTH; d++) {
			const id = `d${d}`;
			rows.push(mk(id, prev, 100 + d));
			prev = id;
		}
		const { threads } = buildTree(rows, usersById(author("u1")));
		let node = threads[0];
		for (let d = 0; d < MAX_DEPTH; d++) {
			expect(node?.depth).toBe(d);
			node = node?.replies[0];
		}
	});

	it("flattens nodes deeper than MAX_DEPTH with flatten_from set", () => {
		const rows: Comment[] = [];
		// MAX_DEPTH + 2 levels: last two should land flat under the
		// depth-(MAX_DEPTH-1) ancestor with flatten_from pointing to parent name.
		let prev: string | null = null;
		for (let d = 0; d < MAX_DEPTH + 2; d++) {
			rows.push(mk(`d${d}`, prev, 100 + d, `u${d}`, "approved", null, d + 1));
			prev = `d${d}`;
		}
		const authors = Array.from({ length: MAX_DEPTH + 2 }, (_, i) =>
			author(`u${i}`, `user-${i}`),
		);
		const { threads } = buildTree(rows, usersById(...authors));

		// Walk to the depth-(MAX_DEPTH-1) ancestor.
		let node = threads[0];
		for (let d = 0; d < MAX_DEPTH - 1; d++) node = node?.replies[0];
		expect(node?.depth).toBe(MAX_DEPTH - 1);

		// All lifted nodes are rendered at depth=MAX_DEPTH with flatten_from
		// pointing to their real parent's display name.
		const lifted = node?.replies ?? [];
		expect(lifted).toHaveLength(2);
		expect(lifted[0]!.depth).toBe(MAX_DEPTH);
		expect(lifted[0]!.flatten_from).toBe(`user-${MAX_DEPTH - 1}`);
		expect(lifted[1]!.depth).toBe(MAX_DEPTH);
		expect(lifted[1]!.flatten_from).toBe(`user-${MAX_DEPTH}`);
	});

	it("keeps flattened descendants in DFS pre-order when a branch forks past the cap", () => {
		// Branching past the flatten threshold is where an iterative builder can
		// silently reorder: every lifted node lands in the *same* array, so a
		// breadth-first pop would interleave sibling subtrees. Each lifted node
		// must still sit directly after the node it was lifted out of.
		const rows = [
			...Array.from({ length: MAX_DEPTH + 1 }, (_, d) =>
				mk(`d${d}`, d === 0 ? null : `d${d - 1}`, 100 + d, `u${d}`),
			),
			mk("forkA", `d${MAX_DEPTH}`, 200, "ua"),
			mk("forkB", `d${MAX_DEPTH}`, 300, "ub"),
			mk("leafA", "forkA", 400, "ul"),
		];
		const authors = [
			...Array.from({ length: MAX_DEPTH + 1 }, (_, i) => author(`u${i}`, `user-${i}`)),
			author("ua", "user-a"),
			author("ub", "user-b"),
			author("ul", "user-l"),
		];
		const { threads } = buildTree(rows, usersById(...authors));

		let node = threads[0];
		for (let d = 0; d < MAX_DEPTH - 1; d++) node = node?.replies[0];
		const lifted = node?.replies ?? [];
		expect(lifted.map((n) => n.id)).toEqual([
			`d${MAX_DEPTH}`,
			"forkA",
			"leafA",
			"forkB",
		]);
		expect(lifted.every((n) => n.depth === MAX_DEPTH)).toBe(true);
		// flatten_from always names the *real* parent, not the node above it in
		// the flattened list.
		expect(lifted.map((n) => n.flatten_from)).toEqual([
			`user-${MAX_DEPTH - 1}`,
			`user-${MAX_DEPTH}`,
			"user-a",
			`user-${MAX_DEPTH}`,
		]);
	});
});

describe("buildTree — can_reply", () => {
	/** Every node in the tree, nested or lifted. */
	const allNodes = (nodes: TreeNode[]): TreeNode[] =>
		nodes.flatMap((n) => [n, ...allNodes(n.replies)]);

	it("mirrors the insert cap, not the render depth", () => {
		// chain() writes ascending stored depths, so c0..c7 sit at depth 1..8. The
		// last one is exactly the node POST /comments refuses to accept a reply to.
		const { threads } = buildTree(chain(MAX_REPLY_DEPTH), usersById(author("u1")));
		const canReply = new Map(allNodes(threads).map((n) => [n.id, n.can_reply]));
		expect(canReply.get(`c${MAX_REPLY_DEPTH - 2}`)).toBe(true);
		expect(canReply.get(`c${MAX_REPLY_DEPTH - 1}`)).toBe(false);
	});

	it("keeps flattened nodes repliable while their stored depth is under the cap", () => {
		// The regression this field exists for. Past the flatten threshold every
		// node reports depth === MAX_DEPTH, so a client gating on render depth
		// dead-ends a thread MAX_REPLY_DEPTH - MAX_DEPTH levels early.
		const rows = Array.from({ length: MAX_DEPTH + 2 }, (_, d) =>
			mk(`d${d}`, d === 0 ? null : `d${d - 1}`, 100 + d, "u1", "approved", null, d + 1),
		);
		const { threads } = buildTree(rows, usersById(author("u1")));
		const lifted = allNodes(threads).filter((n) => n.flatten_from !== null);
		expect(lifted).toHaveLength(2);
		expect(lifted.every((n) => n.depth === MAX_DEPTH)).toBe(true);
		expect(lifted.every((n) => n.can_reply)).toBe(true);
	});

	it("refuses replies on a legacy row parked at the backfill sentinel", () => {
		// Migration 0015 backfills rows its recursion never reaches (orphans, chains
		// past the guard) to depth 1000 so they fail closed. They still render.
		const { threads } = buildTree(
			[mk("legacy", null, 100, "u1", "approved", null, 1000)],
			usersById(author("u1")),
		);
		expect(threads[0]!.depth).toBe(0);
		expect(threads[0]!.can_reply).toBe(false);
	});
});

describe("buildTree — bounded complexity and malformed input", () => {
	it("assembles a 20,000-deep chain without recursing or going quadratic", () => {
		// The old builder recursed once per level *including past the flatten
		// threshold*, so a chain this long threw RangeError, and keepableSet
		// re-walked the full ancestor chain per node — O(N^2), measured at 223ms
		// for 5,000 against a 10ms CPU budget. Linear work here is tens of ms;
		// the quadratic version needs seconds at this size.
		const rows = chain(20_000);
		const started = performance.now();
		const { threads } = buildTree(rows, usersById(author("u1")));
		const elapsed = performance.now() - started;

		const count = (n: (typeof threads)[number]): number =>
			1 + n.replies.reduce((sum, r) => sum + count(r), 0);
		expect(threads).toHaveLength(1);
		expect(count(threads[0]!)).toBe(20_000); // nothing dropped
		expect(elapsed).toBeLessThan(1000);
	});

	it("terminates on a malformed parent_id cycle instead of looping forever", () => {
		// parent_id cannot cycle today (a reply can only point at a comment that
		// already existed), but the failure mode of being wrong about that is a
		// hung request, not a bad render.
		const rows = [mk("root", null, 50), mk("a", "b", 100), mk("b", "a", 200)];
		const { threads } = buildTree(rows, usersById(author("u1")));
		// A cycle is unreachable from a top-level thread, so it simply renders
		// nothing — the point is that we get here at all.
		expect(threads.map((t) => t.id)).toEqual(["root"]);
		expect(threads[0]!.replies).toEqual([]);
	});

	it("emits a duplicated row only once", () => {
		const rows = [mk("root", null, 50), mk("dup", "root", 100), mk("dup", "root", 100)];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["dup"]);
	});
});

describe("buildTree — reactions", () => {
	it("attaches reaction counts + mine flag to the matching node", () => {
		const rows = [mk("root", null, 100), mk("child", "root", 200)];
		const reactionsById = new Map<string, { kind: string; count: number; mine: boolean }[]>();
		reactionsById.set("root", [
			{ kind: "fire", count: 3, mine: true },
			{ kind: "love", count: 1, mine: false },
		]);
		reactionsById.set("child", [{ kind: "laugh", count: 2, mine: false }]);
		const { threads } = buildTree(
			rows,
			usersById(author("u1")),
			reactionsById,
		);
		expect(threads[0]!.reactions).toEqual([
			{ kind: "fire", count: 3, mine: true },
			{ kind: "love", count: 1, mine: false },
		]);
		expect(threads[0]!.replies[0]!.reactions).toEqual([
			{ kind: "laugh", count: 2, mine: false },
		]);
	});

	it("defaults reactions to empty when the map is omitted", () => {
		const rows = [mk("root", null, 100)];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads[0]!.reactions).toEqual([]);
	});
});

describe("buildTree — deleted-parent semantics", () => {
	it("keeps a deleted parent as placeholder when a live reply exists", () => {
		const rows = [
			mk("root", null, 100, "u1", "deleted"),
			mk("live", "root", 200, "u2", "approved"),
		];
		const { threads } = buildTree(
			rows,
			usersById(author("u1"), author("u2")),
		);
		expect(threads).toHaveLength(1);
		expect(threads[0]!.status).toBe("deleted");
		expect(threads[0]!.body_html).toBe(""); // widget renders [deleted]
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["live"]);
	});

	it("prunes a deleted parent when all descendants are also deleted", () => {
		const rows = [
			mk("root", null, 100, "u1", "deleted"),
			mk("childdel", "root", 200, "u1", "deleted"),
		];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads).toHaveLength(0);
	});

	it("prunes a deleted leaf with no children", () => {
		const rows = [
			mk("root", null, 100),
			mk("dead", "root", 200, "u1", "deleted"),
		];
		const { threads } = buildTree(rows, usersById(author("u1")));
		expect(threads[0]!.replies).toEqual([]);
	});
});

describe("buildTree — keepAllDeleted (show_deleted_placeholders)", () => {
	it("keeps a deleted leaf reply as a placeholder when set", () => {
		const rows = [
			mk("root", null, 100),
			mk("dead", "root", 200, "u1", "deleted"),
		];
		const { threads } = buildTree(
			rows,
			usersById(author("u1")),
			undefined,
			undefined,
			{ keepAllDeleted: true },
		);
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["dead"]);
		expect(threads[0]!.replies[0]!.status).toBe("deleted");
	});

	it("keeps a deleted top-level thread with no live descendants when set", () => {
		const rows = [mk("solo", null, 100, "u1", "deleted")];
		const { threads } = buildTree(
			rows,
			usersById(author("u1")),
			undefined,
			undefined,
			{ keepAllDeleted: true },
		);
		expect(threads.map((t) => t.id)).toEqual(["solo"]);
	});

	it("propagates deleted_by onto the node for placeholder wording", () => {
		const rows = [
			mk("root", null, 100),
			mk("byMod", "root", 200, "u1", "deleted", "moderator"),
			mk("byAuthor", "root", 300, "u1", "deleted", "author"),
		];
		const { threads } = buildTree(
			rows,
			usersById(author("u1")),
			undefined,
			undefined,
			{ keepAllDeleted: true },
		);
		const byId = new Map(threads[0]!.replies.map((r) => [r.id, r]));
		expect(byId.get("byMod")!.deleted_by).toBe("moderator");
		expect(byId.get("byAuthor")!.deleted_by).toBe("author");
	});
});

describe("buildTree — staff flag", () => {
	it("marks only an opted-in comment, and never on the author", () => {
		const { threads } = buildTree(
			[{ ...mk("s", null, 100), as_staff: 1 }, mk("p", null, 200)],
			usersById(author("u1")),
		);
		expect(threads[0]!.staff).toBe(true);
		expect(threads[0]!.author).not.toHaveProperty("role");
		expect(threads[1]).not.toHaveProperty("staff");
	});

	it("drops the badge from a tombstone kept for its live reply", () => {
		const { threads } = buildTree(
			[{ ...mk("s", null, 100, "u1", "deleted"), as_staff: 1 }, mk("r", "s", 200)],
			usersById(author("u1")),
		);
		expect(threads[0]!.status).toBe("deleted");
		expect(threads[0]).not.toHaveProperty("staff");
	});
});

describe("buildTree — hidden parents", () => {
	const spammer = author("spam-user", "Buy Cheap Pills");
	const users = () => usersById(author("u1"), author("u2", "Other"), spammer);
	const placeholderShape = {
		status: "deleted",
		deleted_by: "moderator",
		deleted_at: null,
		edited_at: null,
		body_html: "",
		author: { id: "", name: "[deleted]", provider: "anon", avatar_svg: null, avatar_url: null },
		score_up: 0,
		score_down: 0,
		reactions: [],
		my_vote: 0,
	};

	it("keeps a spam root as a placeholder above its approved reply", () => {
		const rows = [mk("s", null, 100, "spam-user", "spam"), mk("r", "s", 200)];
		const { threads } = buildTree(rows, users());
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject(placeholderShape);
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["r"]);
		expect(threads[0]!.replies[0]!.status).toBe("approved");
	});

	it("keeps a spam reply in place so its approved replies stay reachable", () => {
		const rows = [
			mk("root", null, 100),
			mk("s", "root", 200, "spam-user", "spam"),
			mk("g", "s", 300),
		];
		const { threads } = buildTree(rows, users());
		const s = threads[0]!.replies[0]!;
		expect(s).toMatchObject({ id: "s", ...placeholderShape });
		expect(s.replies.map((r) => r.id)).toEqual(["g"]);
	});

	for (const keepAllDeleted of [false, true]) {
		it(`prunes a spam leaf (keepAllDeleted=${keepAllDeleted})`, () => {
			const rows = [mk("root", null, 100), mk("s", "root", 200, "spam-user", "spam")];
			const { threads } = buildTree(rows, users(), undefined, undefined, { keepAllDeleted });
			expect(threads[0]!.replies).toEqual([]);
		});

		it(`a deleted leaf cannot resurrect its spam parent (keepAllDeleted=${keepAllDeleted})`, () => {
			const rows = [
				mk("root", null, 100),
				mk("s", "root", 200, "spam-user", "spam"),
				mk("d", "s", 300, "u1", "deleted"),
			];
			const { threads } = buildTree(rows, users(), undefined, undefined, { keepAllDeleted });
			expect(threads.map((t) => t.id)).toEqual(["root"]);
			expect(threads[0]!.replies).toEqual([]);
		});
	}

	it("still keeps a deleted-only chain under a live root when keepAllDeleted is set", () => {
		const rows = [
			mk("root", null, 100),
			mk("d1", "root", 200, "u1", "deleted"),
			mk("d2", "d1", 300, "u1", "deleted"),
		];
		const { threads } = buildTree(rows, users(), undefined, undefined, { keepAllDeleted: true });
		expect(threads[0]!.replies.map((r) => r.id)).toEqual(["d1"]);
		expect(threads[0]!.replies[0]!.replies.map((r) => r.id)).toEqual(["d2"]);
	});

	it("keeps two stacked hidden levels above an approved reply", () => {
		const rows = [
			mk("root", null, 100),
			mk("s", "root", 200, "spam-user", "spam"),
			mk("p", "s", 300, "u2", "pending"),
			mk("a", "p", 400),
		];
		const { threads } = buildTree(rows, users());
		const s = threads[0]!.replies[0]!;
		expect(s).toMatchObject({ id: "s", ...placeholderShape });
		expect(s.replies[0]).toMatchObject({ id: "p", ...placeholderShape });
		expect(s.replies[0]!.replies.map((r) => r.id)).toEqual(["a"]);
	});

	it("masks someone else's pending parent but shows the viewer their own", () => {
		const rows = [
			mk("theirs", null, 100, "u2", "pending"),
			mk("r1", "theirs", 200),
			mk("mine", null, 300, "u1", "pending"),
			mk("r2", "mine", 400),
		];
		const { threads } = buildTree(rows, users(), undefined, undefined, { viewerId: "u1" });
		const byId = new Map(threads.map((t) => [t.id, t]));
		expect(byId.get("theirs")).toMatchObject(placeholderShape);
		expect(byId.get("mine")).toMatchObject({ status: "pending", body_html: "<p>mine</p>" });
		expect(byId.get("mine")!.author.id).toBe("u1");
	});

	it("never serializes a hidden author, including the flatten prefix past MAX_DEPTH", () => {
		// c0..c3 nest normally; c4 (spam) and c5 render flattened. c5's
		// flatten_from names its immediate parent, which is the hidden c4.
		const rows = chain(MAX_DEPTH + 2).map((r) =>
			r.id === `c${MAX_DEPTH}` ? { ...r, user_id: "spam-user", status: "spam" as const } : r,
		);
		const json = JSON.stringify(buildTree(rows, users()).threads);
		expect(json).not.toContain("Buy Cheap Pills");
		expect(json).not.toContain("spam-user");
		expect(json).toContain(`"flatten_from":"[deleted]"`);
	});

	it("masks a moderator-deleted node and keeps an author-deleted node's author", () => {
		const rows = [
			mk("root", null, 100),
			{ ...mk("byMod", "root", 200, "u2", "deleted", "moderator"), score_up: 5 },
			mk("byModChild", "byMod", 250),
			{ ...mk("byAuthor", "root", 300, "u2", "deleted", "author"), score_up: 7 },
			mk("byAuthorChild", "byAuthor", 350),
		];
		const { threads } = buildTree(rows, users());
		const byId = new Map(threads[0]!.replies.map((r) => [r.id, r]));
		expect(byId.get("byMod")).toMatchObject(placeholderShape);
		expect(byId.get("byAuthor")!.author.name).toBe("Other");
		expect(byId.get("byAuthor")!.deleted_by).toBe("author");
		expect(byId.get("byAuthor")!.score_up).toBe(0);
	});
});
