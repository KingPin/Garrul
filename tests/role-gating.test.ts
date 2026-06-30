/**
 * Pure-logic and render tests for the moderator-role feature.
 *
 * D1-routed gating (requireMod vs requireAdmin on actual HTTP routes) is
 * not exercised here — that needs the Workers pool + Miniflare. What is
 * covered:
 *   - roleAuditAction produces the right audit verb for every transition.
 *   - renderUserDetail shows the role-management UI only when the viewer
 *     is an admin and not viewing themselves.
 *   - renderUsers renders the new "mod" pill alongside the existing
 *     "admin" pill, and no pill for role='user'.
 *   - The admin layout hides admin-only nav links from non-admin viewers.
 */
import { describe, it, expect } from "vitest";
import { roleAuditAction } from "../src/routes/admin";
import { renderUserDetail } from "../src/admin-ui/pages/user-detail";
import { renderUsers } from "../src/admin-ui/pages/users";
import { layout } from "../src/admin-ui/layout";
import { countAdmins } from "../src/db/queries";
import type {
	AdminUserDetail,
	User,
	UserRole,
} from "../src/db/queries";

const makeUser = (over: Partial<User> = {}): User => ({
	id: "01HUSR000000000000000000A",
	provider: "github",
	provider_id: "u1",
	name: "Test User",
	email: null,
	avatar_url: null,
	is_admin: false,
	is_banned: false,
	role: "user",
	created_at: 1_700_000_000_000,
	...over,
});

const makeDetail = (user: User): AdminUserDetail => ({
	user,
	comments: [],
	next_cursor: null,
	reactions_received: 0,
	audit: [],
});

describe("roleAuditAction", () => {
	it("returns null on a no-op transition", () => {
		const cases: UserRole[] = ["user", "mod", "admin"];
		for (const r of cases) {
			expect(roleAuditAction(r, r)).toBeNull();
		}
	});

	it("classifies promotions correctly", () => {
		expect(roleAuditAction("user", "mod")).toBe("role.grant_mod");
		expect(roleAuditAction("user", "admin")).toBe("role.grant_admin");
		expect(roleAuditAction("mod", "admin")).toBe("role.grant_admin");
	});

	it("classifies demotions correctly", () => {
		expect(roleAuditAction("admin", "mod")).toBe("role.revoke_admin");
		expect(roleAuditAction("admin", "user")).toBe("role.revoke_admin");
		expect(roleAuditAction("mod", "user")).toBe("role.revoke_mod");
	});
});

describe("renderUserDetail role controls", () => {
	const admin = makeUser({
		id: "01HADMIN000000000000000001",
		role: "admin",
		is_admin: true,
		name: "Admin",
	});
	const mod = makeUser({
		id: "01HMOD0000000000000000001",
		role: "mod",
		name: "Mod",
	});
	const plainUser = makeUser({
		id: "01HPLAIN0000000000000000A",
		role: "user",
		name: "Plain",
	});

	it("shows promote/demote buttons when admin views another user", () => {
		const html = renderUserDetail(makeDetail(plainUser), admin);
		expect(html).toContain(">Make mod<");
		expect(html).toContain(">Make admin<");
		expect(html).toContain(">Demote to user<");
		expect(html).toContain("/admin/api/users/01HPLAIN0000000000000000A/role");
	});

	it("hides role controls when admin views their own page", () => {
		const html = renderUserDetail(makeDetail(admin), admin);
		expect(html).not.toContain(">Make mod<");
		expect(html).not.toContain(">Make admin<");
		expect(html).not.toContain(">Demote to user<");
	});

	it("hides role controls when a mod views any user", () => {
		const html = renderUserDetail(makeDetail(plainUser), mod);
		expect(html).not.toContain(">Make mod<");
		expect(html).not.toContain(">Make admin<");
		expect(html).not.toContain(">Demote to user<");
	});

	it("renders the mod pill in the user header for role='mod'", () => {
		const html = renderUserDetail(makeDetail(mod), admin);
		expect(html).toContain('pill mod">mod</span>');
		expect(html).not.toContain('pill admin">admin</span>');
	});

	it("renders the admin pill in the user header for role='admin'", () => {
		const html = renderUserDetail(makeDetail(admin), admin);
		expect(html).toContain('pill admin">admin</span>');
		expect(html).not.toContain('pill mod">mod</span>');
	});

	it("renders no role pill for role='user'", () => {
		const html = renderUserDetail(makeDetail(plainUser), admin);
		expect(html).not.toContain('pill admin">admin</span>');
		expect(html).not.toContain('pill mod">mod</span>');
	});

	// Regression: u.role was JSON.stringified directly into x-data="...",
	// so the leading " of the JSON string closed the attribute and
	// silently broke the Alpine state, leaving the role buttons inert.
	// Fix wraps with escapeHtml so the literal stays inside the attribute.
	it("HTML-escapes the role literal inside the x-data attribute", () => {
		const html = renderUserDetail(makeDetail(plainUser), admin);
		expect(html).not.toMatch(/role: "/);
		expect(html).toContain("role: &quot;user&quot;");
	});
});

describe("renderUsers role pills", () => {
	it("emits the right pill per role and links the name to detail", () => {
		const users: User[] = [
			makeUser({ id: "01HU00000000000000000000A", name: "Plain", role: "user" }),
			makeUser({ id: "01HU00000000000000000000B", name: "Modder", role: "mod" }),
			makeUser({
				id: "01HU00000000000000000000C",
				name: "Operator",
				role: "admin",
				is_admin: true,
			}),
		];
		const html = renderUsers(users, "", null);
		expect(html).toContain('pill mod">mod</span>');
		expect(html).toContain('pill admin">admin</span>');
		expect(html).toContain('href="/admin/users/01HU00000000000000000000A"');
		expect(html).toContain('href="/admin/users/01HU00000000000000000000B"');
	});
});

describe("admin layout role-aware nav", () => {
	const adminLinks = [
		"/admin/users",
		"/admin/audit",
		"/admin/subscriptions",
		"/admin/operator",
		"/admin/telegram",
		"/admin/settings",
	];

	it("hides admin-only nav links from a mod viewer", () => {
		const mod = makeUser({ role: "mod", name: "Mod" });
		const html = layout("test", "<p>x</p>", mod, null);
		for (const link of adminLinks) {
			expect(html).not.toContain(`href="${link}"`);
		}
		// Mod still sees the queue + about.
		expect(html).toContain('href="/admin/queue"');
		expect(html).toContain('href="/admin/about"');
		expect(html).toContain('pill mod">mod</span>');
	});

	it("shows admin-only nav links to an admin viewer", () => {
		const admin = makeUser({ role: "admin", is_admin: true, name: "Admin" });
		const html = layout("test", "<p>x</p>", admin, null);
		for (const link of adminLinks) {
			expect(html).toContain(`href="${link}"`);
		}
		expect(html).toContain('pill admin">admin</span>');
	});

	it("renders no role pill for a plain user that somehow reaches the layout", () => {
		// The route guards prevent this in practice, but the layout should
		// degrade gracefully rather than emit a stray admin pill.
		const plain = makeUser({ role: "user" });
		const html = layout("test", "<p>x</p>", plain, null);
		expect(html).not.toContain('pill admin">admin</span>');
		expect(html).not.toContain('pill mod">mod</span>');
	});
});

describe("admin layout active-link highlighting", () => {
	const admin = makeUser({ role: "admin", is_admin: true, name: "Admin" });

	// Read the class attribute of the *nav* anchor for an exact href. Plain
	// string scanning (not a regex built from the href, which would need
	// metacharacter escaping): the `"` after href and the ` class="` that
	// immediately follows make the match exact (so `/admin` won't also match
	// `/admin/users`), and requiring the class to start with `nav-link` skips
	// the brand/logo anchor, which also points at `/admin`.
	const navLinkClass = (html: string, href: string): string => {
		const marker = `href="${href}" class="`;
		for (let at = html.indexOf(marker); at !== -1; at = html.indexOf(marker, at + 1)) {
			const start = at + marker.length;
			const cls = html.slice(start, html.indexOf('"', start));
			if (cls.startsWith("nav-link")) return cls;
		}
		throw new Error(`no nav link for ${href}`);
	};
	const isActive = (html: string, href: string): boolean =>
		navLinkClass(html, href).split(/\s+/).includes("active");

	it("does not mark any link active without an activePath", () => {
		const html = layout("test", "<p>x</p>", admin, null);
		expect(isActive(html, "/admin")).toBe(false);
		expect(isActive(html, "/admin/users")).toBe(false);
	});

	it("matches the dashboard root exactly, not as a prefix", () => {
		// "/admin" is a prefix of every admin path, so it must NOT light up on
		// sub-pages — otherwise Dashboard would always look active.
		const onSub = layout("test", "<p>x</p>", admin, null, {
			activePath: "/admin/users",
		});
		expect(isActive(onSub, "/admin")).toBe(false);
		expect(isActive(onSub, "/admin/users")).toBe(true);

		const onRoot = layout("test", "<p>x</p>", admin, null, {
			activePath: "/admin",
		});
		expect(isActive(onRoot, "/admin")).toBe(true);
		expect(isActive(onRoot, "/admin/users")).toBe(false);
	});

	it("keeps a section active on its sub-pages (prefix match)", () => {
		const html = layout("test", "<p>x</p>", admin, null, {
			activePath: "/admin/users/01HU00000000000000000000A",
		});
		expect(isActive(html, "/admin/users")).toBe(true);
		expect(isActive(html, "/admin/queue")).toBe(false);
	});

	it("requires a slash boundary so sibling prefixes don't spuriously match", () => {
		// "/admin/queuexyz" shares a string prefix with "/admin/queue" but is a
		// different route; the `${href}/` guard must keep Queue inactive.
		const html = layout("test", "<p>x</p>", admin, null, {
			activePath: "/admin/queuexyz",
		});
		expect(isActive(html, "/admin/queue")).toBe(false);
	});
});

describe("countAdmins", () => {
	it("counts users WHERE role = 'admin' (not is_admin)", async () => {
		let captured: { sql: string; binds: unknown[] } | null = null;
		const db = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						captured = { sql, binds: args };
						return this;
					},
					async first() {
						captured = captured ?? { sql, binds: [] };
						return { n: 2 };
					},
				};
			},
		};
		const n = await countAdmins(db as unknown as D1Database);
		expect(n).toBe(2);
		expect(captured).not.toBeNull();
		expect(captured!.sql).toContain("FROM users WHERE role = 'admin'");
	});

	it("returns 0 when no row comes back (defensive default)", async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind() {
						return this;
					},
					async first() {
						return null;
					},
				};
			},
		};
		const n = await countAdmins(db as unknown as D1Database);
		expect(n).toBe(0);
	});
});
