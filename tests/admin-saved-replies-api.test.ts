/**
 * Saved-reply JSON API (/admin/api/saved-replies) against REAL SQLite.
 *
 * The query layer is covered in saved-replies.test.ts; this drives the routes:
 * a mod creates, lists, edits and deletes their own replies, sees a peer's
 * shared reply but can't change it, and every write is audited.
 */
import { describe, it, expect } from "vitest";
import { ADMIN_SID, MOD_SID, adminHarness } from "./helpers/admin-sqlite";

type Reply = { id: string; title: string; scope: string };

describe("/admin/api/saved-replies", () => {
	it("runs create → list → update → delete for the owner, auditing each write", async () => {
		const { request, sqlite } = adminHarness();
		const created = await request("/admin/api/saved-replies", {
			method: "POST",
			body: { title: "Thanks", body_md: "Thanks for the report.", scope: "private" },
			sid: MOD_SID,
		});
		expect(created.status).toBe(200);
		const { id } = (await created.json()) as { id: string };

		const list = await request("/admin/api/saved-replies", { sid: MOD_SID });
		const { replies } = (await list.json()) as { replies: Reply[] };
		expect(replies.map((r) => [r.id, r.title, r.scope])).toEqual([[id, "Thanks", "private"]]);

		const updated = await request(`/admin/api/saved-replies/${id}`, {
			method: "PATCH",
			body: { title: "Thank you", body_md: "Thanks!", scope: "shared" },
			sid: MOD_SID,
		});
		expect(await updated.json()).toEqual({ ok: true, id });
		expect(sqlite.prepare("SELECT title, body_md, scope FROM saved_replies WHERE id = ?").get(id)).toEqual({
			title: "Thank you",
			body_md: "Thanks!",
			scope: "shared",
		});

		const deleted = await request(`/admin/api/saved-replies/${id}`, {
			method: "DELETE",
			sid: MOD_SID,
		});
		expect(await deleted.json()).toEqual({ ok: true, id });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM saved_replies").get()).toEqual({ n: 0 });

		const audits = sqlite
			.prepare("SELECT action, meta FROM audit_log ORDER BY rowid")
			.all() as Array<{ action: string; meta: string }>;
		expect(audits.map((a) => a.action)).toEqual([
			"saved_reply.create",
			"saved_reply.update",
			"saved_reply.delete",
		]);
		expect(JSON.parse(String(audits[1]?.meta))).toMatchObject({ scope: "shared", scope_changed: true });
	});

	it("shows a shared reply to a peer but refuses their edit and delete", async () => {
		const { request } = adminHarness();
		const created = await request("/admin/api/saved-replies", {
			method: "POST",
			body: { title: "Welcome", body_md: "Welcome aboard.", scope: "shared" },
			sid: MOD_SID,
		});
		const { id } = (await created.json()) as { id: string };

		const peerList = await request("/admin/api/saved-replies", { sid: ADMIN_SID });
		expect(((await peerList.json()) as { replies: Reply[] }).replies.map((r) => r.id)).toEqual([
			id,
		]);

		const edit = await request(`/admin/api/saved-replies/${id}`, {
			method: "PATCH",
			body: { title: "Hijacked", body_md: "x", scope: "shared" },
		});
		expect(edit.status).toBe(403);
		expect(await edit.json()).toEqual({ error: "not_owner" });
		const del = await request(`/admin/api/saved-replies/${id}`, { method: "DELETE" });
		expect(del.status).toBe(403);

		const missing = await request("/admin/api/saved-replies/01HNOPE", { method: "DELETE" });
		expect(missing.status).toBe(404);
	});

	it("rejects a body that fails validation", async () => {
		const { request, sqlite } = adminHarness();
		const res = await request("/admin/api/saved-replies", {
			method: "POST",
			body: { title: "", body_md: "x", scope: "private" },
			sid: MOD_SID,
		});
		expect(res.status).toBe(400);
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM saved_replies").get()).toEqual({ n: 0 });
	});
});
