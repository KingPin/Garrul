/**
 * /admin/discord page and /admin/api/discord/* against REAL SQLite.
 * Discord's REST API is a mocked global fetch; ids are fake snowflakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertDiscordLink } from "../src/db/queries";
import { bustSettingsCache } from "../src/lib/settings";
import { ADMIN_ID, MOD_SID, adminHarness, makeKv } from "./helpers/admin-sqlite";

const GUILD = "111111111111111111";
const CHAN = "222222222222222222";
const ROLE = "333333333333333333";

const setup = (extra: Record<string, unknown> = {}) => {
	const kv = makeKv();
	const h = adminHarness({
		OAUTH_STATE: kv,
		DISCORD_BOT_TOKEN: "bot-token",
		DISCORD_PUBLIC_KEY: "ab".repeat(32),
		DISCORD_CLIENT_ID: "444444444444444444",
		PUBLIC_BASE_URL: "https://c.example.test",
		...extra,
	});
	const audits = () =>
		h.sqlite.prepare("SELECT action, meta FROM audit_log ORDER BY rowid").all() as Array<{
			action: string;
			meta: string | null;
		}>;
	const settings = () =>
		Object.fromEntries(
			(h.sqlite.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>).map(
				(r) => [r.key, r.value],
			),
		);
	const setGuild = async () => {
		h.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('discord_guild_id', ?, 0)").run(GUILD);
		await bustSettingsCache(h.env);
	};
	return { ...h, kv, audits, settings, setGuild };
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GET /admin/discord", () => {
	it("shows state, endpoint URL, settings, link controls and the register button", async () => {
		const { request, setGuild } = setup();
		await setGuild();
		const html = await (await request("/admin/discord")).text();
		expect(html).toContain("https://c.example.test/discord/interactions");
		expect(html).toContain(GUILD);
		expect(html).toContain("Generate link code");
		expect(html).toContain("Register commands");
		expect(html).toContain("DISCORD_BOT_TOKEN");
	});

	it("notes an unset PUBLIC_BASE_URL and shows linked state", async () => {
		const { request, env } = setup({ PUBLIC_BASE_URL: "" });
		await upsertDiscordLink(env.DB, { discord_user_id: "555555555555555555", user_id: ADMIN_ID });
		const html = await (await request("/admin/discord")).text();
		expect(html).toContain("PUBLIC_BASE_URL");
		expect(html).not.toContain("/discord/interactions</code>");
		expect(html).toContain("Unlink Discord");
	});

	it("is admin-only", async () => {
		const { request } = setup();
		expect((await request("/admin/discord", { sid: MOD_SID })).status).toBe(403);
	});
});

describe("POST /admin/api/discord/settings", () => {
	const save = (request: ReturnType<typeof setup>["request"], body: unknown, sid?: string) =>
		request("/admin/api/discord/settings", { method: "POST", body, sid });

	it("rejects a malformed id", async () => {
		const { request, settings } = setup();
		const res = await save(request, { guild_id: "abc" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_id:guild_id" });
		expect(settings()).toEqual({});
	});

	it("saves ids, deletes empty ones, and audits field names only", async () => {
		const { request, settings, audits } = setup();
		const res = await save(request, { guild_id: GUILD, mod_role_id: ROLE, admin_role_id: "", digest_channel_id: "" });
		expect(res.status).toBe(200);
		expect(settings()).toEqual({ discord_guild_id: GUILD, discord_mod_role_id: ROLE });
		const [a] = audits();
		expect(a?.action).toBe("discord.settings");
		expect(a?.meta ?? "").not.toContain(GUILD);
		expect(a?.meta ?? "").not.toContain(ROLE);
		expect(a?.meta ?? "").toContain("guild_id");

		await save(request, { guild_id: "", mod_role_id: ROLE, admin_role_id: "", digest_channel_id: "" });
		expect(settings()).toEqual({ discord_mod_role_id: ROLE });
	});

	it("validates a digest channel against Discord", async () => {
		const { request, settings } = setup();
		fetchMock.mockResolvedValueOnce(jsonRes({ type: 0, guild_id: "999999999999999999" }));
		const bad = await save(request, { guild_id: GUILD, digest_channel_id: CHAN });
		expect(bad.status).toBe(400);
		expect(await bad.json()).toEqual({ error: "channel_wrong_guild" });
		expect(settings()).toEqual({});

		fetchMock.mockResolvedValueOnce(jsonRes({ type: 0, guild_id: GUILD }));
		const ok = await save(request, { guild_id: GUILD, digest_channel_id: CHAN });
		expect(ok.status).toBe(200);
		expect(settings().discord_digest_channel_id).toBe(CHAN);
	});

	it("refuses a digest channel when the feature is off or no guild is set", async () => {
		const off = setup({ DISCORD_BOT_TOKEN: undefined });
		const r1 = await save(off.request, { guild_id: GUILD, digest_channel_id: CHAN });
		expect(await r1.json()).toEqual({ error: "discord_not_configured" });
		const noGuild = setup();
		const r2 = await save(noGuild.request, { digest_channel_id: CHAN });
		expect(r2.status).toBe(400);
		expect(await r2.json()).toEqual({ error: "discord_not_configured" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is admin-only and rejects a cross-origin POST", async () => {
		const { request } = setup();
		expect((await save(request, { guild_id: GUILD }, MOD_SID)).status).toBe(403);
		const res = await request("/admin/api/discord/settings", {
			method: "POST",
			body: { guild_id: GUILD },
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});
});

describe("discord link", () => {
	it("issues a dc: code, audits without the code, and unlinks", async () => {
		const { request, kv, audits, env } = setup();
		const res = await request("/admin/api/discord/link", { method: "POST" });
		const { ok, code } = (await res.json()) as { ok: boolean; code: string };
		expect(ok).toBe(true);
		expect([...kv.store.keys()][0]).toBe(`dc:link:${code}`);
		expect(JSON.stringify(audits())).not.toContain(code);

		await upsertDiscordLink(env.DB, { discord_user_id: "555555555555555555", user_id: ADMIN_ID });
		const del = await request("/admin/api/discord/link", { method: "DELETE" });
		expect(await del.json()).toEqual({ ok: true, removed: true });
		expect(audits().map((a) => a.action)).toEqual(["discord.link_code", "discord.unlink"]);
	});

	it("is admin-only and rejects a cross-origin DELETE", async () => {
		const { request } = setup();
		expect((await request("/admin/api/discord/link", { method: "POST", sid: MOD_SID })).status).toBe(403);
		const res = await request("/admin/api/discord/link", {
			method: "DELETE",
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});
});

describe("POST /admin/api/discord/commands", () => {
	const reg = (request: ReturnType<typeof setup>["request"], sid?: string) =>
		request("/admin/api/discord/commands", { method: "POST", sid });

	it("PUTs the six guild commands", async () => {
		const { request, setGuild, audits } = setup();
		await setGuild();
		fetchMock.mockResolvedValueOnce(jsonRes([]));
		const res = await reg(request);
		expect(res.status).toBe(200);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`https://discord.com/api/v10/applications/444444444444444444/guilds/${GUILD}/commands`);
		expect(init.method).toBe("PUT");
		const cmds = JSON.parse(init.body as string) as Array<{
			name: string;
			description: string;
			options?: Array<{ name: string; type: number; required: boolean }>;
		}>;
		expect(cmds.map((c) => c.name)).toEqual(["queue", "stats", "comment", "user", "unban", "link"]);
		expect(cmds[0]?.options).toBeUndefined();
		expect(cmds[2]?.options).toEqual([expect.objectContaining({ name: "id", type: 3, required: true })]);
		expect(cmds[5]?.options).toEqual([expect.objectContaining({ name: "code", type: 3, required: true })]);
		expect(audits().map((a) => a.action)).toEqual(["discord.commands"]);
	});

	it("400s without a guild or when the feature is off", async () => {
		const a = setup();
		const r1 = await reg(a.request);
		expect(r1.status).toBe(400);
		expect(await r1.json()).toEqual({ error: "guild_not_set" });
		const b = setup({ DISCORD_BOT_TOKEN: undefined });
		const r2 = await reg(b.request);
		expect(r2.status).toBe(400);
		expect(await r2.json()).toEqual({ error: "discord_not_configured" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("maps a Discord failure to 502 with the status", async () => {
		const { request, setGuild } = setup();
		await setGuild();
		fetchMock.mockResolvedValueOnce(jsonRes({ message: "nope" }, 403));
		const res = await reg(request);
		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({ error: "discord_error", status: 403 });
	});

	it("is admin-only and rejects a cross-origin POST", async () => {
		const { request } = setup();
		expect((await reg(request, MOD_SID)).status).toBe(403);
		const res = await request("/admin/api/discord/commands", {
			method: "POST",
			headers: { origin: "https://evil.example" },
		});
		expect(res.status).toBe(403);
	});
});
