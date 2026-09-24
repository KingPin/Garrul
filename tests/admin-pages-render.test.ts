/**
 * Every admin HTML page renders against REAL SQLite (every migration applied).
 *
 * Each page's queries run against the real schema, so a column rename or a
 * broken JOIN turns into a failing request here instead of a 500 in prod.
 * A page that lists data must show the seeded row, to prove it read from the
 * database rather than rendering an empty shell; the rest must show their own
 * heading, since the shared nav already names every page.
 */
import { describe, it, expect } from "vitest";
import { ADMIN_ID, adminHarness } from "./helpers/admin-sqlite";

const USER_ID = "01HUSER00000000000000000US";

const seeded = () => {
	const h = adminHarness();
	const run = (sql: string, ...args: unknown[]) =>
		h.sqlite.prepare(sql).run(...(args as never[]));
	run(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'anon', NULL, 'Reader Rae', 0, 'user', 1)`,
		USER_ID,
	);
	run("INSERT INTO posts (slug, title, url, created_at) VALUES ('hello', 'Hello Post', NULL, 1)");
	run(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, ip_hash, user_agent, created_at, depth)
		 VALUES ('c1', 'hello', NULL, ?, 'first!', '<p>first comment body</p>', 1,
		         'pending', 'iphash', 'ua', 1, 1)`,
		USER_ID,
	);
	run(
		`INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirmed_at)
		 VALUES ('s1', 'hello', 'sub@example.com', 'tok', 1, 1)`,
	);
	run(
		`INSERT INTO webhook_endpoints (id, url, secret, events, adapter, enabled, created_at, updated_at)
		 VALUES ('w1', 'https://hooks.example.com/seeded', NULL, NULL, 'generic', 1, 1, 1)`,
	);
	run(
		`INSERT INTO saved_replies (id, owner_id, title, body_md, scope, created_at, updated_at)
		 VALUES ('r1', ?, 'Canned Thanks', 'Thanks!', 'private', 1, 1)`,
		ADMIN_ID,
	);
	run(
		`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id, created_at)
		 VALUES ('a1', ?, 'user.ban', 'user', ?, 1)`,
		ADMIN_ID,
		USER_ID,
	);
	return h;
};

// [path, seeded data or the page's own heading]
const PAGES: Array<[string, string]> = [
	["/admin/comments/c1", "first comment body"],
	["/admin/users", "Reader Rae"],
	[`/admin/users/${USER_ID}`, "Reader Rae"],
	["/admin/audit", "user.ban"],
	["/admin/subscriptions", "sub@example.com"],
	["/admin/operator", "<h1>Operator</h1>"],
	["/admin/telegram", "<h1>Telegram</h1>"],
	["/admin/settings", "<h1>Settings</h1>"],
	["/admin/about", "<h1>About</h1>"],
	["/admin/webhooks", "https://hooks.example.com/seeded"],
	["/admin/webhooks/new", "<h1>Add webhook</h1>"],
	["/admin/webhooks/w1", "https://hooks.example.com/seeded"],
	["/admin/usage", "CF_API_TOKEN"],
	["/admin/saved-replies", "Canned Thanks"],
	["/admin/saved-replies/new", "<h1>New saved reply</h1>"],
	["/admin/saved-replies/r1", "Canned Thanks"],
];

describe("admin HTML pages", () => {
	it.each(PAGES)("GET %s renders with seeded data", async (path, marker) => {
		const res = await seeded().request(path);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain(marker);
	});

	it.each([
		"/admin/comments/nope",
		`/admin/users/01HNOPE`,
		"/admin/webhooks/nope",
		"/admin/saved-replies/nope",
	])("GET %s is a 404 for an unknown id", async (path) => {
		expect((await seeded().request(path)).status).toBe(404);
	});
});
