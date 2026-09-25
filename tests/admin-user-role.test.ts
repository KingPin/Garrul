/**
 * POST /admin/api/users/:id/role against REAL SQLite.
 *
 * Role changes are admin-only and audited with from/to only (no names). The
 * route refuses a change to the caller's own role and a demotion that would
 * leave the instance without an admin.
 */
import { describe, it, expect } from "vitest";
import { ADMIN_ID, MOD_ID, MOD_SID, adminHarness } from "./helpers/admin-sqlite";

const USER_ID = "01HUSER00000000000000000US";

const setup = () => {
	const h = adminHarness();
	h.sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'anon', NULL, 'Reader', 0, 'user', 1)`,
		)
		.run(USER_ID);
	const role = (id: string) =>
		(h.sqlite.prepare("SELECT role FROM users WHERE id = ?").get(id) as { role: string })
			.role;
	return { ...h, role };
};

describe("POST /admin/api/users/:id/role", () => {
	it("promotes a user and audits from/to without the name", async () => {
		const { request, sqlite, role } = setup();
		const res = await request(`/admin/api/users/${USER_ID}/role`, {
			method: "POST",
			body: { role: "mod", reason: "helpful" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id: USER_ID, role: "mod" });
		expect(role(USER_ID)).toBe("mod");
		const audit = sqlite
			.prepare("SELECT target_id, reason, meta FROM audit_log WHERE admin_id = ?")
			.get(ADMIN_ID) as { target_id: string; reason: string; meta: string };
		expect(audit.target_id).toBe(USER_ID);
		expect(audit.reason).toBe("helpful");
		expect(JSON.parse(audit.meta)).toEqual({ from: "user", to: "mod" });
	});

	it("rejects an unknown role, a self change, a missing user and a mod caller", async () => {
		const { request, role } = setup();
		const post = (id: string, body: unknown, sid?: string) =>
			request(`/admin/api/users/${id}/role`, { method: "POST", body, sid });
		expect((await post(USER_ID, { role: "root" })).status).toBe(400);
		const self = await post(ADMIN_ID, { role: "user" });
		expect(self.status).toBe(400);
		expect(await self.json()).toEqual({ error: "cannot_change_own_role" });
		expect((await post("01HNOPE", { role: "mod" })).status).toBe(404);
		expect((await post(USER_ID, { role: "mod" }, MOD_SID)).status).toBe(403);
		expect(role(USER_ID)).toBe("user");
		expect(role(ADMIN_ID)).toBe("admin");
	});

	it("demotes a peer admin, and answers an unchanged role without writing", async () => {
		// The last_admin refusal needs a target admin other than the caller, so
		// countAdmins is always >= 2 on a single request; only a race between two
		// admins demoting each other reaches it. This pins the path around it.
		const { request, sqlite, role } = setup();
		sqlite.prepare("UPDATE users SET role = 'admin', is_admin = 1 WHERE id = ?").run(MOD_ID);
		const demote = await request(`/admin/api/users/${MOD_ID}/role`, {
			method: "POST",
			body: { role: "user" },
		});
		expect(await demote.json()).toEqual({ ok: true, id: MOD_ID, role: "user" });
		expect(role(MOD_ID)).toBe("user");

		const same = await request(`/admin/api/users/${USER_ID}/role`, {
			method: "POST",
			body: { role: "user" },
		});
		expect(await same.json()).toEqual({ ok: true, id: USER_ID, role: "user" });
		const audits = sqlite.prepare("SELECT action FROM audit_log").all() as Array<{ action: string }>;
		expect(audits.map((a) => a.action)).toEqual(["role.revoke_admin"]);
	});
});
