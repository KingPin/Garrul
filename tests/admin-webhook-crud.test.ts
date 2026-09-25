/**
 * POST /admin/api/webhooks and DELETE /admin/api/webhooks/:id against REAL
 * SQLite. (PATCH and the write-only secret live in admin-webhook-secret.test.ts.)
 *
 * Create runs every URL through the SSRF guard, keeps the secret out of the
 * audit log, and stores "every event selected" as NULL so receivers pick up
 * events added later.
 */
import { describe, it, expect } from "vitest";
import { MOD_SID, adminHarness } from "./helpers/admin-sqlite";

const ALL_EVENTS = [
	"comment.posted",
	"comment.edited",
	"comment.deleted",
	"comment.approved",
	"comment.spam",
	"comment.reported",
];

const create = (h: ReturnType<typeof adminHarness>, body: unknown, sid?: string) =>
	h.request("/admin/api/webhooks", { method: "POST", body, sid });

describe("POST/DELETE /admin/api/webhooks", () => {
	it("creates a signed endpoint, audits without the secret, then deletes it", async () => {
		const h = adminHarness();
		const secret = "s".repeat(32);
		const res = await create(h, {
			url: "https://hooks.example.com/garrul",
			secret,
			events: ["comment.posted", "comment.spam"],
		});
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };
		const row = h.sqlite
			.prepare("SELECT url, secret, events, adapter, enabled FROM webhook_endpoints WHERE id = ?")
			.get(id) as Record<string, unknown>;
		expect(row).toMatchObject({
			url: "https://hooks.example.com/garrul",
			secret,
			adapter: "generic",
			enabled: 1,
		});
		expect(row.events).toBe("comment.posted,comment.spam");

		const del = await h.request(`/admin/api/webhooks/${id}`, { method: "DELETE" });
		expect(await del.json()).toEqual({ ok: true, id });
		expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").get()).toEqual({ n: 0 });

		const audits = h.sqlite
			.prepare("SELECT action, meta FROM audit_log ORDER BY rowid")
			.all() as Array<{ action: string; meta: string }>;
		expect(audits.map((a) => a.action)).toEqual(["webhook.create", "webhook.delete"]);
		expect(audits[0]?.meta).not.toContain(secret);
		expect(JSON.parse(String(audits[0]?.meta))).toMatchObject({ has_secret: true, enabled: true });
		expect((await h.request(`/admin/api/webhooks/${id}`, { method: "DELETE" })).status).toBe(404);
	});

	it("stores every-event as NULL and accepts a telegram chat id in place of a URL", async () => {
		const h = adminHarness();
		const all = await create(h, {
			url: "https://hooks.example.com/all",
			events: ALL_EVENTS,
			enabled: false,
		});
		const tg = await create(h, { url: "-1001234567890", adapter: "telegram" });
		const rows = h.sqlite
			.prepare("SELECT id, events, adapter, enabled, secret FROM webhook_endpoints")
			.all() as Array<Record<string, unknown>>;
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(((await all.json()) as { id: string }).id)).toMatchObject({
			events: null,
			enabled: 0,
		});
		expect(byId.get(((await tg.json()) as { id: string }).id)).toMatchObject({
			adapter: "telegram",
			secret: null,
		});
	});

	it("refuses unsafe URLs and malformed fields before writing", async () => {
		const h = adminHarness();
		const error = async (body: unknown) => {
			const res = await create(h, body);
			expect(res.status).toBe(400);
			return ((await res.json()) as { error: string }).error;
		};
		const url = "https://hooks.example.com/x";
		expect(await error({})).toBe("url_required");
		expect(await error({ url: "https://10.0.0.1/x" })).toBe("url:private_ipv4");
		expect(await error({ url: "http://hooks.example.com/x" })).toMatch(/^url:/);
		expect(await error({ url, adapter: "carrier-pigeon" })).toBe("adapter_invalid");
		expect(await error({ url: "not a chat", adapter: "telegram" })).toBe("chat_id_invalid");
		expect(await error({ url, secret: 12345 })).toBe("secret_invalid");
		expect(await error({ url, secret: "short" })).toBe("secret_too_short");
		expect(await error({ url, secret: "x".repeat(257) })).toBe("secret_too_long");
		expect(await error({ url, events: "comment.posted" })).toBe("events_invalid");
		expect(await error({ url, events: ["comment.posted", "user.created"] })).toBe(
			"events_unknown",
		);
		expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_endpoints").get()).toEqual({ n: 0 });
	});

	it("is admin-only", async () => {
		const h = adminHarness();
		expect((await create(h, { url: "https://hooks.example.com/x" }, MOD_SID)).status).toBe(403);
	});
});
