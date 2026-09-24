/**
 * GET /admin/comments/:id with every context section populated, on REAL
 * SQLite: parent, replies, IP-hash siblings, the author's other comments,
 * spam verdicts, open reports and the comment's audit trail.
 *
 * admin-pages-render.test.ts only proves the bare page renders; this pins that
 * each section reads its own rows and that a banned author gets no Ban button.
 */
import { describe, it, expect } from "vitest";
import { ADMIN_ID, MOD_SID, adminHarness } from "./helpers/admin-sqlite";

const AUTHOR = "01HAUTHOR000000000000000AU";
const OTHER = "01HOTHER0000000000000000OT";

const seeded = (authorBanned: number) => {
	const h = adminHarness();
	const run = (sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).run(...(args as never[]));
	const user = `INSERT INTO users (id, provider, provider_id, name, is_admin, role, is_banned, created_at)
	              VALUES (?, 'anon', NULL, ?, 0, 'user', ?, 1)`;
	run(user, AUTHOR, "Author Ann", authorBanned);
	run(user, OTHER, "Other Oli", 0);
	run("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', 'https://blog.example/p', 1)");
	const comment = `INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
	                   renderer_version, status, ip_hash, user_agent, created_at, depth)
	                 VALUES (?, 'p', ?, ?, 'md', ?, 3, 'pending', ?, 'ua', ?, ?)`;
	run(comment, "parent", null, OTHER, "<p>parent body</p>", "other-ip", 1, 0);
	run(comment, "c1", "parent", AUTHOR, "<p>target body</p>", "shared-ip", 2, 1);
	run(comment, "reply", "c1", OTHER, "<p>reply body</p>", "other-ip", 3, 2);
	run(comment, "sibling", null, OTHER, "<p>sibling body</p>", "shared-ip", 4, 0);
	run(comment, "recent", null, AUTHOR, "<p>recent body</p>", "elsewhere-ip", 5, 0);
	run(
		`INSERT INTO spam_verdicts (id, comment_id, source, verdict, score, raw, created_at)
		 VALUES ('v1', 'c1', 'akismet', 'spam', 0.875, NULL, 1), ('v2', 'c1', 'heuristics', 'uncertain', NULL, NULL, 2)`,
	);
	run(
		`INSERT INTO reports (id, comment_id, reporter_user_id, reason, status, created_at)
		 VALUES ('r1', 'c1', ?, 'rude words', 'open', 1)`,
		OTHER,
	);
	run(
		`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id, reason, created_at)
		 VALUES ('a1', ?, 'comment.spam', 'comment', 'c1', 'obvious', 1)`,
		ADMIN_ID,
	);
	return h;
};

describe("GET /admin/comments/:id context sections", () => {
	it("shows every related row and the ban action for a live author", async () => {
		const html = await (await seeded(0).request("/admin/comments/c1")).text();
		for (const marker of [
			"target body",
			"parent body",
			"Replies (1)",
			"reply body",
			"IP-hash siblings (1)",
			"sibling body",
			"Other comments by this author",
			"recent body",
			"akismet: spam 0.88",
			"heuristics: uncertain",
			"rude words",
			"comment.spam",
			"obvious",
			"Ban author",
		]) {
			expect(html, marker).toContain(marker);
		}
	});

	it("says a banned author is already banned instead of offering the button", async () => {
		const html = await (await seeded(1).request("/admin/comments/c1")).text();
		expect(html).toContain("Author is already banned.");
		expect(html).not.toContain("Ban author");
	});

	it("hides the ban action from a moderator", async () => {
		const html = await (await seeded(0).request("/admin/comments/c1", { sid: MOD_SID })).text();
		expect(html).toContain("target body");
		expect(html).not.toContain("Ban author");
		expect(html).not.toContain("already banned");
	});
});
