/**
 * Hidden-parent moderation on REAL SQLite: the direct-reply hint on hidden
 * comments, and the spam-thread cascade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminHarness, MOD_SID } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

beforeEach(() => installMockCaches());
afterEach(() => uninstallMockCaches());

const seeded = () => {
	const h = adminHarness();
	h.sqlite.exec(
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'Ann', 1)",
	);
	h.sqlite.exec("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)");
	const ins = h.sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, status, created_at, depth)
		 VALUES (?, 'p', ?, 'u1', 'x', '<p>x</p>', ?, ?, ?)`,
	);
	let ts = 1;
	const add = (id: string, parent: string | null, status: string) =>
		ins.run(id, parent, status, ts++, parent ? 2 : 1);
	const statusOf = (id: string) =>
		(h.sqlite.prepare("SELECT status FROM comments WHERE id = ?").get(id) as { status: string })
			.status;
	const act = (id: string, action: string, sid?: string) =>
		h.request(`/admin/api/comments/${id}`, { method: "POST", body: { action }, sid });
	return { h, add, statusOf, act };
};

describe("admin — direct reply hint", () => {
	it("labels spam and pending rows that have replies, and nothing else", async () => {
		const { h, add } = seeded();
		add("s", null, "spam");
		add("s1", "s", "approved");
		add("s2", "s", "spam");
		add("q", null, "pending");
		add("q1", "q", "approved");
		add("a", null, "approved");
		add("a1", "a", "approved");
		add("lone", null, "spam");
		const html = await (await h.request("/admin/queue?status=all")).text();
		expect(html).toContain("↳ 2 direct replies");
		expect(html).toContain("↳ 1 direct reply");
		expect(html.match(/direct repl/g)).toHaveLength(2);
		expect(html).not.toContain("still visible");
	});

	it("shows the hint on the detail page", async () => {
		const { h, add } = seeded();
		add("s", null, "spam");
		add("s1", "s", "approved");
		const html = await (await h.request("/admin/comments/s")).text();
		expect(html).toContain("↳ 1 direct reply");
	});
});

describe("POST /admin/api/comments/:id — spam_thread", () => {
	const audits = (h: ReturnType<typeof seeded>["h"]) =>
		(h.sqlite
			.prepare("SELECT target_id, meta FROM audit_log WHERE action = 'thread.spam' ORDER BY target_id")
			.all() as { target_id: string; meta: string }[]).map((r) => ({
			target_id: r.target_id,
			meta: JSON.parse(r.meta),
		}));

	it("spams the root and its descendants, skips already-spam rows, audits each", async () => {
		const { h, add, statusOf, act } = seeded();
		add("r", null, "approved");
		add("a", "r", "approved");
		add("b", "a", "pending");
		add("s", "r", "spam");
		add("x", null, "approved");
		const res = await act("r", "spam_thread");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id: "r", touched: 3 });
		for (const id of ["r", "a", "b", "s"]) expect(statusOf(id)).toBe("spam");
		expect(statusOf("x")).toBe("approved");
		expect(audits(h)).toEqual([
			{ target_id: "a", meta: { root_id: "r", prev_status: "approved", batch_size: 3 } },
			{ target_id: "b", meta: { root_id: "r", prev_status: "pending", batch_size: 3 } },
			{ target_id: "r", meta: { root_id: "r", prev_status: "approved", batch_size: 3 } },
		]);
	});

	it("handles a 100-row subtree and refuses 101 with nothing changed", async () => {
		const ok = seeded();
		ok.add("r", null, "approved");
		for (let i = 0; i < 99; i++) ok.add(`c${i}`, "r", "approved");
		const res = await ok.act("r", "spam_thread");
		expect(res.status).toBe(200);
		expect(((await res.json()) as { touched: number }).touched).toBe(100);

		const big = seeded();
		big.add("r", null, "approved");
		for (let i = 0; i < 100; i++) big.add(`c${i}`, "r", "approved");
		const refused = await big.act("r", "spam_thread");
		expect(refused.status).toBe(400);
		expect(await refused.json()).toEqual({ error: "too_many" });
		expect(big.statusOf("r")).toBe("approved");
		expect(big.statusOf("c99")).toBe("approved");
	});

	// D1 runs a batch as one transaction. A trigger makes one of the two
	// writes fail; neither may land, and the retry must still work (an
	// unaudited half-commit would be filtered out as "already spam").
	for (const [table, trigger] of [
		["audit_log", "CREATE TRIGGER boom BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'boom'); END"],
		["comments", "CREATE TRIGGER boom BEFORE UPDATE OF status ON comments BEGIN SELECT RAISE(ABORT, 'boom'); END"],
	] as const) {
		it(`rolls back both writes when the ${table} write fails`, async () => {
			const { h, add, statusOf, act } = seeded();
			add("r", null, "approved");
			add("a", "r", "approved");
			h.sqlite.exec(trigger);
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				expect((await act("r", "spam_thread")).status).toBe(500);
			} finally {
				spy.mockRestore();
			}
			expect(statusOf("r")).toBe("approved");
			expect(statusOf("a")).toBe("approved");
			expect(audits(h)).toEqual([]);
			h.sqlite.exec("DROP TRIGGER boom");
			expect(await (await act("r", "spam_thread")).json()).toEqual({ ok: true, id: "r", touched: 2 });
			expect(audits(h).map((a) => a.target_id)).toEqual(["a", "r"]);
		});
	}

	it("404s a missing root and lets a mod run it", async () => {
		const { add, statusOf, act } = seeded();
		expect((await act("nope", "spam_thread")).status).toBe(404);
		add("r", null, "approved");
		add("a", "r", "approved");
		expect((await act("r", "spam_thread", MOD_SID)).status).toBe(200);
		expect(statusOf("a")).toBe("spam");
	});

	it("offers the button only on a comment with replies", async () => {
		const { h, add } = seeded();
		add("r", null, "approved");
		add("a", "r", "approved");
		expect(await (await h.request("/admin/comments/r")).text()).toContain("act('spam_thread')");
		expect(await (await h.request("/admin/comments/a")).text()).not.toContain("act('spam_thread')");
	});
});
