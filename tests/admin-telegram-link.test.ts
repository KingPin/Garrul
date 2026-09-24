/**
 * /admin/api/telegram/{link,digest} against REAL SQLite.
 *
 * The link code is a bearer credential: it lands in OAUTH_STATE for the bot's
 * /start to redeem and must stay out of the audit trail. Unlink audits only
 * when a link existed; the digest toggle needs a link to act on.
 */
import { describe, it, expect } from "vitest";
import { upsertTelegramLink } from "../src/db/queries";
import { ADMIN_ID, MOD_SID, adminHarness, makeKv } from "./helpers/admin-sqlite";

const setup = () => {
	const kv = makeKv();
	const h = adminHarness({ OAUTH_STATE: kv });
	const audits = () =>
		h.sqlite.prepare("SELECT action, meta FROM audit_log ORDER BY rowid").all() as Array<{
			action: string;
			meta: string | null;
		}>;
	return { ...h, kv, audits };
};

describe("admin telegram link", () => {
	it("issues a one-time code, stored for the bot and kept out of the audit log", async () => {
		const { request, kv, audits } = setup();
		const res = await request("/admin/api/telegram/link", { method: "POST" });
		const { code } = (await res.json()) as { code: string };
		expect(code).toMatch(/^[0-9a-f]{48}$/);
		const [[key, value]] = [...kv.store];
		expect(key).toContain(code);
		expect(JSON.parse(value)).toMatchObject({ user_id: ADMIN_ID });
		expect(audits().map((a) => a.action)).toEqual(["telegram.link_code"]);
		expect(JSON.stringify(audits())).not.toContain(code);
	});

	it("toggles the digest and unlinks only an existing link", async () => {
		const { request, env, audits } = setup();
		const digest = (body: unknown) => request("/admin/api/telegram/digest", { method: "POST", body });

		expect((await digest({ digest: true })).status).toBe(404);
		expect(await (await request("/admin/api/telegram/link", { method: "DELETE" })).json()).toEqual({
			ok: true,
			removed: false,
		});
		expect(audits()).toEqual([]);

		await upsertTelegramLink(env.DB, { tg_user_id: "42", tg_chat_id: "555", user_id: ADMIN_ID });
		expect((await digest({ digest: "yes" })).status).toBe(400);
		expect(await (await digest({ digest: true })).json()).toEqual({ ok: true, digest: true });
		expect(await (await request("/admin/api/telegram/link", { method: "DELETE" })).json()).toEqual({
			ok: true,
			removed: true,
		});
		expect(audits().map((a) => a.action)).toEqual(["telegram.unlink"]);
	});

	it("is admin-only", async () => {
		const { request } = setup();
		expect((await request("/admin/api/telegram/link", { method: "POST", sid: MOD_SID })).status).toBe(403);
	});
});
