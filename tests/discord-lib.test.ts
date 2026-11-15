import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/index";
import {
	cardToMessage,
	discordEnabled,
	SNOWFLAKE_RE,
	verifyDiscordRequest,
} from "../src/lib/discord";
import { decodePayload } from "../src/lib/opbot/codec";
import { loadDiscordSettings, loadSettings } from "../src/lib/settings";

const toHex = (b: ArrayBuffer): string =>
	Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

const makeKeys = async () => {
	const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const pub = toHex((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	const sign = async (msg: string) =>
		toHex(
			await crypto.subtle.sign(
				{ name: "Ed25519" },
				kp.privateKey,
				new TextEncoder().encode(msg),
			),
		);
	return { pub, sign };
};

describe("verifyDiscordRequest", () => {
	const now = 1_700_000_000_000;
	const ts = String(now / 1000);
	const body = '{"type":1}';

	it("accepts a valid signature", async () => {
		const { pub, sign } = await makeKeys();
		const sig = await sign(`${ts}${body}`);
		expect(await verifyDiscordRequest(pub, sig, ts, body, now)).toBe(true);
	});

	it("rejects bad signature, missing headers, tampered body", async () => {
		const { pub, sign } = await makeKeys();
		const sig = await sign(`${ts}${body}`);
		const other = await makeKeys();
		expect(
			await verifyDiscordRequest(pub, await other.sign(`${ts}${body}`), ts, body, now),
		).toBe(false);
		expect(await verifyDiscordRequest(pub, undefined, ts, body, now)).toBe(false);
		expect(await verifyDiscordRequest(pub, sig, undefined, body, now)).toBe(false);
		expect(await verifyDiscordRequest(pub, sig, ts, `${body} `, now)).toBe(false);
		expect(await verifyDiscordRequest(pub, "zz", ts, body, now)).toBe(false);
		expect(await verifyDiscordRequest("nothex", sig, ts, body, now)).toBe(false);
	});

	it("rejects a timestamp more than 300 s from now", async () => {
		const { pub, sign } = await makeKeys();
		const old = String(now / 1000 - 301);
		expect(
			await verifyDiscordRequest(pub, await sign(`${old}${body}`), old, body, now),
		).toBe(false);
		const edge = String(now / 1000 - 300);
		expect(
			await verifyDiscordRequest(pub, await sign(`${edge}${body}`), edge, body, now),
		).toBe(true);
		const future = String(now / 1000 + 301);
		expect(
			await verifyDiscordRequest(pub, await sign(`${future}${body}`), future, body, now),
		).toBe(false);
		expect(
			await verifyDiscordRequest(pub, await sign(`abc${body}`), "abc", body, now),
		).toBe(false);
	});
});

describe("discordEnabled", () => {
	it("needs both env vars", () => {
		expect(discordEnabled({})).toBe(false);
		expect(discordEnabled({ DISCORD_BOT_TOKEN: "t" })).toBe(false);
		expect(discordEnabled({ DISCORD_PUBLIC_KEY: "k" })).toBe(false);
		expect(
			discordEnabled({ DISCORD_BOT_TOKEN: "t", DISCORD_PUBLIC_KEY: "k" }),
		).toBe(true);
	});
});

describe("cardToMessage", () => {
	const btn = (i: number) => ({
		action: "approve" as const,
		label: `b${i}`,
		style: "primary" as const,
	});
	it("renders embed, buttons and no mentions", () => {
		const msg = cardToMessage({
			title: "New comment",
			lines: ["a", "b"],
			snippet: "hi @everyone [x](http://e)",
			doneBy: "mod",
			commentId: "01ABC",
			buttons: [[btn(1), { ...btn(2), style: "danger" }]],
		}) as unknown as {
			embeds: { description: string; fields?: unknown[] }[];
			components: { type: number; components: { custom_id: string; style: number }[] }[];
			allowed_mentions: unknown;
		};
		expect(msg.allowed_mentions).toEqual({ parse: [] });
		expect(msg.embeds[0]?.description).not.toContain("@everyone");
		expect(msg.embeds[0]?.description).toContain("\\[x\\]");
		expect(msg.embeds[0]?.fields).toHaveLength(1);
		const row = msg.components[0] as NonNullable<(typeof msg.components)[0]>;
		expect(row.type).toBe(1);
		expect(row.components.map((c) => c.style)).toEqual([1, 4]);
		expect(decodePayload(row.components[0]?.custom_id as string)?.commentId).toBe("01ABC");
	});

	it("caps rows and buttons", () => {
		const row = Array.from({ length: 7 }, (_, i) => btn(i));
		const msg = cardToMessage({
			title: "t",
			lines: [],
			commentId: "c1",
			buttons: Array.from({ length: 7 }, () => row),
		}) as { components: { components: unknown[] }[] };
		expect(msg.components.length).toBeLessThanOrEqual(5);
		for (const r of msg.components) expect(r.components.length).toBeLessThanOrEqual(5);
	});
});

describe("discord settings group", () => {
	const mkEnv = (rows: Record<string, string>) =>
		({
			DB: {
				prepare: () => ({
					all: async () => ({
						results: Object.entries(rows).map(([key, value]) => ({ key, value })),
					}),
				}),
			},
			TREE_CACHE: { delete: async () => {} },
		}) as unknown as Bindings;

	it("defaults to empty strings", async () => {
		expect(await loadDiscordSettings(mkEnv({}))).toEqual({
			guildId: "",
			modRoleId: "",
			adminRoleId: "",
			digestChannelId: "",
		});
	});

	it("trims valid snowflakes and drops invalid ones", async () => {
		const env = mkEnv({
			discord_guild_id: " 111111111111111111 ",
			discord_mod_role_id: "222222222222222222",
			discord_admin_role_id: "not-a-snowflake",
			discord_digest_channel_id: "123",
		});
		expect((await loadSettings(env)).discord).toEqual({
			guildId: "111111111111111111",
			modRoleId: "222222222222222222",
			adminRoleId: "",
			digestChannelId: "",
		});
		expect(SNOWFLAKE_RE.test("111111111111111111")).toBe(true);
	});
});
