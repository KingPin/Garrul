/**
 * Keyset pagination on the admin list pages, against REAL SQLite.
 *
 * Each page fetches limit+1 rows and, when there are more, links a
 * `before=<created_at>|<id>` cursor. Following that link must land on the
 * older rows only; a malformed cursor falls back to the first page.
 */
import { describe, it, expect } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";

const N = 55;
const AUTHOR = "01HPAGEAUTHOR0000000000000";
const pad = (i: number) => String(i).padStart(2, "0");

const seeded = () => {
	const h = adminHarness();
	const run = (sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).run(...(args as never[]));
	run("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)");
	run(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'anon', NULL, 'Author', 0, 'user', 1)`,
		AUTHOR,
	);
	for (let i = 1; i <= N; i++) {
		const n = pad(i);
		// Rows 25 and 26 share a created_at (a genuine tie, away from the
		// page-boundary), forcing the id-DESC secondary sort to actually run.
		const ts = 1_000 + (i === 26 ? 25 : i);
		run(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'anon', NULL, ?, 0, 'user', ?)`,
			`01HPAGEUSER00000000000000${n}`.slice(-26),
			`pager-user-${n}`,
			ts,
		);
		run(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, ip_hash, user_agent, created_at, depth)
			 VALUES (?, 'p', NULL, ?, 'x', ?, 1, 'pending', NULL, NULL, ?, 1)`,
			`c${n}`,
			AUTHOR,
			`<p>pager-comment-${n}</p>`,
			ts,
		);
		run(
			`INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirmed_at)
			 VALUES (?, 'p', ?, ?, ?, 1)`,
			`s${n}`,
			`pager-sub-${n}@example.com`,
			`tok${n}`,
			ts,
		);
		run(
			`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id, created_at)
			 SELECT ?, id, 'comment.approve', 'comment', ?, ? FROM users WHERE role = 'admin'`,
			`a${n}`,
			`pager-target-${n}`,
			ts,
		);
	}
	return h;
};

// [page, row marker prefix]; the newest row is ${prefix}55, the oldest ${prefix}01.
const LISTS: Array<[string, string]> = [
	["/admin/users", "pager-user-"],
	["/admin/queue", "pager-comment-"],
	[`/admin/users/${AUTHOR}`, "pager-comment-"],
	["/admin/subscriptions", "pager-sub-"],
	["/admin/audit", "pager-target-"],
];

const markersIn = (html: string, prefix: string) =>
	new Set([...html.matchAll(new RegExp(`${prefix}(\\d\\d)`, "g"))].map((m) => m[1]));

describe("admin list pagination", () => {
	it.each(LISTS)("%s pages to older rows via its before cursor", async (path, prefix) => {
		const h = seeded();
		const first = await (await h.request(path)).text();
		const href = first.match(/href="([^"]*before=[^"]+)"/)?.[1];
		expect(href).toBeDefined();
		const second = await (await h.request((href as string).replace(/&amp;/g, "&"))).text();

		const firstMarkers = markersIn(first, prefix);
		const secondMarkers = markersIn(second, prefix);
		expect(firstMarkers.has("55")).toBe(true);
		expect(secondMarkers.has("01")).toBe(true);
		// No row appears on both pages...
		for (const m of firstMarkers) expect(secondMarkers.has(m)).toBe(false);
		// ...and none go missing, including the two tied at row 25/26.
		expect(new Set([...firstMarkers, ...secondMarkers])).toEqual(
			new Set(Array.from({ length: N }, (_, i) => pad(i + 1))),
		);
	});

	it.each(LISTS)("%s ignores a malformed cursor", async (path, prefix) => {
		const h = seeded();
		const sep = path.includes("?") ? "&" : "?";
		for (const bad of ["garbage", "abc|c01", "|"]) {
			const body = await (await h.request(`${path}${sep}before=${encodeURIComponent(bad)}`)).text();
			expect(body).toContain(`${prefix}55`);
		}
	});
});
