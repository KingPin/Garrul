/**
 * Hidden-parent moderation on REAL SQLite: the direct-reply hint on hidden
 * comments, and the spam-thread cascade.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";
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
