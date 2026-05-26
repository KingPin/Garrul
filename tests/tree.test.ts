/**
 * Tree assembly tests — depth cap (4 levels deep, 5–6 flatten), deleted-
 * parent placeholder iff descendants are alive, and ordering by
 * created_at ASC.
 */
import { describe, it, expect } from "vitest";
import type { Comment } from "../src/db/queries";
import { buildTree, MAX_DEPTH, type TreeAuthor } from "../src/lib/tree";

const author = (id: string, name = id, provider = "anon"): TreeAuthor => ({
	id,
	name,
	provider,
	is_admin: false,
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
	ip_hash: null,
	user_agent: null,
	created_at,
	score_up: 0,
	score_down: 0,
});

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
			rows.push(mk(`d${d}`, prev, 100 + d, `u${d}`));
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
});

describe("buildTree — reactions", () => {
	it("attaches reaction counts + mine flag to the matching node", () => {
		const rows = [mk("root", null, 100), mk("child", "root", 200)];
		const reactionsById = new Map<string, { kind: string; count: number; mine: boolean }[]>();
		reactionsById.set("root", [
			{ kind: "like", count: 3, mine: true },
			{ kind: "love", count: 1, mine: false },
		]);
		reactionsById.set("child", [{ kind: "laugh", count: 2, mine: false }]);
		const { threads } = buildTree(
			rows,
			usersById(author("u1")),
			reactionsById,
		);
		expect(threads[0]!.reactions).toEqual([
			{ kind: "like", count: 3, mine: true },
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
