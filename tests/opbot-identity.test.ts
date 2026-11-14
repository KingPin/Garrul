/** Actor resolution + shared link tokens, against REAL SQLite. Spec §2. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { upsertDiscordLink, upsertTelegramLink } from "../src/db/queries";
import { resolveDiscordActor, resolveTelegramActor } from "../src/lib/opbot/identity";
import { consumeLinkToken, issueLinkToken } from "../src/lib/opbot/link-token";
import { makeD1, makeKv } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const GUILD = "222222222222222222";
const MOD_ROLE = "333333333333333333";
const ADMIN_ROLE = "444444444444444444";
const cfg = { guildId: GUILD, modRoleId: MOD_ROLE, adminRoleId: ADMIN_ROLE };
const DID = "111111111111111111";
const DID2 = "555555555555555555";

const setup = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	const user = (id: string, provider: string, pid: string | null, role: string, extra: { banned?: boolean; erased?: boolean; avatar?: string } = {}) =>
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, avatar_url, is_admin, is_banned, role, created_at, erased_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			)
			.run(id, provider, pid, `name-${id}`, extra.avatar ?? null, role === "admin" ? 1 : 0, extra.banned ? 1 : 0, role, extra.erased ? 5 : null);
	return { sqlite, db: makeD1(sqlite), user };
};

const ask = (db: unknown, over: Partial<{ guildId: string | undefined; roles: string[]; discordUserId: string }> = {}) =>
	resolveDiscordActor(db as never, cfg, {
		guildId: GUILD,
		discordUserId: DID,
		displayName: "Disp",
		roles: [],
		...over,
	});

describe("resolveDiscordActor", () => {
	it("link only: linked user's role", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod");
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		const r = await ask(db);
		expect(r).toMatchObject({ ok: true, actor: { role: "mod", adminViaDiscordRole: false } });
	});

	it("OAuth only: provider row counts as linked", async () => {
		const { db, user } = setup();
		user("uB", "discord", DID, "admin");
		const r = await ask(db);
		expect(r).toMatchObject({ ok: true, actor: { role: "admin", adminViaDiscordRole: false } });
		if (r.ok) expect(r.actor.user.id).toBe("uB");
	});

	it("role only: creates a discord row with null email and avatar", async () => {
		const { db, sqlite } = setup();
		const r = await ask(db, { roles: [MOD_ROLE] });
		expect(r).toMatchObject({ ok: true, actor: { role: "mod", adminViaDiscordRole: false } });
		const row = sqlite.prepare("SELECT * FROM users WHERE provider='discord' AND provider_id=?").get(DID) as Record<string, unknown>;
		expect(row.email).toBeNull();
		expect(row.avatar_url).toBeNull();
		expect(row.role).toBe("user");
	});

	it("role-derived admin is flagged adminViaDiscordRole and role is not persisted", async () => {
		const { db, sqlite } = setup();
		const r = await ask(db, { roles: [ADMIN_ROLE] });
		expect(r).toMatchObject({ ok: true, actor: { role: "admin", adminViaDiscordRole: true } });
		expect((sqlite.prepare("SELECT role FROM users WHERE provider_id=?").get(DID) as { role: string }).role).toBe("user");
	});

	it("link + role: higher role wins", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod");
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		const r = await ask(db, { roles: [ADMIN_ROLE] });
		expect(r).toMatchObject({ ok: true, actor: { role: "admin", adminViaDiscordRole: true } });
		const r2 = await ask(db, { roles: [MOD_ROLE] });
		expect(r2).toMatchObject({ ok: true, actor: { role: "mod" } });
	});

	it("link->A and OAuth->B: A is the actor", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod");
		user("uB", "discord", DID, "admin");
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		const r = await ask(db);
		expect(r.ok && r.actor.user.id).toBe("uA");
		expect(r.ok && r.actor.role).toBe("mod");
	});

	it("A banned -> banned, never falls back to B", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod", { banned: true });
		user("uB", "discord", DID, "admin");
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		expect(await ask(db)).toEqual({ ok: false, reason: "banned" });
	});

	it("B banned -> banned even when A is fine", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod");
		user("uB", "discord", DID, "user", { banned: true });
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		expect(await ask(db)).toEqual({ ok: false, reason: "banned" });
	});

	it("banned mod role holder -> banned", async () => {
		const { db, user } = setup();
		user("uB", "discord", DID, "user", { banned: true });
		expect(await ask(db, { roles: [MOD_ROLE] })).toEqual({ ok: false, reason: "banned" });
	});

	it("erased rows are never the actor", async () => {
		const { db, user, sqlite } = setup();
		user("uB", "discord", DID, "admin", { erased: true });
		expect(await ask(db)).toEqual({ ok: false, reason: "not_linked" });
		// Defensive: a stale key on an erased row still never yields an actor.
		expect(await ask(db, { roles: [MOD_ROLE] })).toEqual({ ok: false, reason: "not_linked" });
		// Real erasure nulls provider_id; a role holder then acts through a NEW row.
		sqlite.prepare("UPDATE users SET provider_id = NULL WHERE id='uB'").run();
		const r = await ask(db, { roles: [MOD_ROLE] });
		expect(r.ok && r.actor.user.id).not.toBe("uB");
		expect((sqlite.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(2);
	});

	it("erased link target is ignored", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "admin", { erased: true });
		await upsertDiscordLink(db, { discord_user_id: DID, user_id: "uA" });
		expect(await ask(db)).toEqual({ ok: false, reason: "not_linked" });
	});

	it("wrong guild and DM -> wrong_guild", async () => {
		const { db, user } = setup();
		user("uB", "discord", DID, "admin");
		expect(await ask(db, { guildId: "999999999999999999" })).toEqual({ ok: false, reason: "wrong_guild" });
		expect(await ask(db, { guildId: undefined })).toEqual({ ok: false, reason: "wrong_guild" });
	});

	it("role removed -> not_authorized for a plain user", async () => {
		const { db, user } = setup();
		user("uB", "discord", DID, "user");
		expect(await ask(db, { roles: [] })).toEqual({ ok: false, reason: "not_authorized" });
	});

	it("member.roles absent -> no role", async () => {
		const { db } = setup();
		const r = await resolveDiscordActor(db as never, cfg, { guildId: GUILD, discordUserId: DID, displayName: "D" });
		expect(r).toEqual({ ok: false, reason: "not_linked" });
	});

	it("unknown user without a role -> not_linked and no row created", async () => {
		const { db, sqlite } = setup();
		expect(await ask(db)).toEqual({ ok: false, reason: "not_linked" });
		expect((sqlite.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
	});

	it("existing discord-sign-in row is reused: avatar untouched, no new row", async () => {
		const { db, user, sqlite } = setup();
		user("uB", "discord", DID, "user", { avatar: "https://cdn.example/a.png" });
		const r = await ask(db, { roles: [MOD_ROLE] });
		expect(r.ok && r.actor.user.id).toBe("uB");
		const row = sqlite.prepare("SELECT avatar_url, name FROM users WHERE id='uB'").get() as { avatar_url: string; name: string };
		expect(row.avatar_url).toBe("https://cdn.example/a.png");
		expect(row.name).toBe("name-uB");
		expect((sqlite.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(1);
	});

	it("existing link row is reused for a role holder: no extra row", async () => {
		const { db, user, sqlite } = setup();
		user("uA", "github", "1", "user");
		await upsertDiscordLink(db, { discord_user_id: DID2, user_id: "uA" });
		const r = await ask(db, { discordUserId: DID2, roles: [MOD_ROLE] });
		expect(r.ok && r.actor.user.id).toBe("uA");
		expect((sqlite.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(1);
	});
});

describe("resolveTelegramActor", () => {
	it("link only; role from users.role", async () => {
		const { db, user } = setup();
		user("uA", "github", "1", "mod");
		await upsertTelegramLink(db, { tg_user_id: "tg1", tg_chat_id: "c1", user_id: "uA" });
		expect(await resolveTelegramActor(db, "tg1")).toMatchObject({ ok: true, actor: { role: "mod", adminViaDiscordRole: false } });
	});
	it("unlinked -> not_linked; plain user -> not_authorized; banned -> banned; erased -> not_linked", async () => {
		const { db, user } = setup();
		expect(await resolveTelegramActor(db, "nope")).toEqual({ ok: false, reason: "not_linked" });
		user("u1", "github", "1", "user");
		user("u2", "github", "2", "admin", { banned: true });
		user("u3", "github", "3", "admin", { erased: true });
		await upsertTelegramLink(db, { tg_user_id: "t1", tg_chat_id: "c", user_id: "u1" });
		await upsertTelegramLink(db, { tg_user_id: "t2", tg_chat_id: "c", user_id: "u2" });
		await upsertTelegramLink(db, { tg_user_id: "t3", tg_chat_id: "c", user_id: "u3" });
		expect(await resolveTelegramActor(db, "t1")).toEqual({ ok: false, reason: "not_authorized" });
		expect(await resolveTelegramActor(db, "t2")).toEqual({ ok: false, reason: "banned" });
		expect(await resolveTelegramActor(db, "t3")).toEqual({ ok: false, reason: "not_linked" });
	});
});

describe("link tokens", () => {
	it("round-trips and is one-time", async () => {
		const kv = makeKv() as unknown as KVNamespace;
		const t = await issueLinkToken(kv, "dc", "u1");
		expect(await consumeLinkToken(kv, "dc", t)).toBe("u1");
		expect(await consumeLinkToken(kv, "dc", t)).toBeNull();
	});
	it("prefixes are not interchangeable", async () => {
		const kv = makeKv() as unknown as KVNamespace;
		const tg = await issueLinkToken(kv, "tg", "u1");
		const dc = await issueLinkToken(kv, "dc", "u2");
		expect(await consumeLinkToken(kv, "dc", tg)).toBeNull();
		expect(await consumeLinkToken(kv, "tg", dc)).toBeNull();
		expect(await consumeLinkToken(kv, "tg", tg)).toBe("u1");
	});
});
