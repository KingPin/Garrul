/**
 * runDiscordDigest and the shared digest data, against REAL SQLite with a
 * stubbed global fetch that answers Discord and Telegram by host.
 *
 * Each transport gates on its own settings key: the Discord path must never
 * write tg_digest_last_sent_at, and the Telegram path must never write
 * dc_digest_last_sent_at.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTelegramDigest, upsertTelegramLink } from "../src/db/queries";
import { runDiscordDigest } from "../src/lib/discord-digest";
import { log } from "../src/lib/log";
import { runTelegramDigest } from "../src/lib/telegram-digest";
import { ADMIN_ID, MOD_ID, adminHarness } from "./helpers/admin-sqlite";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const CHANNEL = "555555555555555555";
const DISCORD_URL = `https://discord.com/api/v10/channels/${CHANNEL}/messages`;
const FAKE_PUBLIC_KEY = "ab".repeat(32);

type Call = { url: string; body: Record<string, unknown>; auth?: string | undefined };

const setup = (opts: { discordStatus?: number; telegramStatus?: number } = {}) => {
	const h = adminHarness();
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			const headers = init.headers as Record<string, string> | undefined;
			calls.push({ url, body, auth: headers?.authorization });
			if (url.startsWith("https://discord.com/")) {
				const status = opts.discordStatus ?? 200;
				return new Response(JSON.stringify({ id: "1" }), { status });
			}
			const status = opts.telegramStatus ?? 200;
			return new Response(JSON.stringify({ ok: status === 200 }), { status });
		}),
	);
	const discordEnv = {
		DB: h.env.DB,
		DISCORD_BOT_TOKEN: "fake-bot-token",
		DISCORD_PUBLIC_KEY: FAKE_PUBLIC_KEY,
		PUBLIC_BASE_URL: "https://comments.example.com/",
	};
	const telegramEnv = {
		DB: h.env.DB,
		TELEGRAM_BOT_TOKEN: "123:ABC",
		PUBLIC_BASE_URL: "https://comments.example.com/",
	};
	const bothEnv = { ...discordEnv, TELEGRAM_BOT_TOKEN: "123:ABC" };
	const setting = (key: string) =>
		(h.sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
			| { value: string }
			| undefined)?.value;
	const discordCalls = () => calls.filter((c) => c.url === DISCORD_URL);
	const telegramCalls = () => calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
	const setChannel = (id: string) =>
		h.sqlite
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('discord_digest_channel_id', ?, 0)")
			.run(id);
	const addTelegramOperator = async () => {
		await upsertTelegramLink(h.env.DB, { tg_user_id: "1", tg_chat_id: "555", user_id: ADMIN_ID });
		await setTelegramDigest(h.env.DB, ADMIN_ID, true);
	};
	const addOpenReport = () => {
		h.sqlite
			.prepare(
				`INSERT INTO posts (slug, title, url, created_at) VALUES ('hot-post', 'Hot', NULL, 1)`,
			)
			.run();
		h.sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
				                       renderer_version, status, ip_hash, user_agent, created_at, depth)
				 VALUES ('c1', 'hot-post', NULL, ?, 'secret body', '<p>secret body</p>', 1, 'pending', NULL, NULL, ?, 1)`,
			)
			.run(MOD_ID, NOW - 3 * 3600 * 1000);
		h.sqlite
			.prepare("INSERT INTO reports (id, comment_id, reporter_user_id, reason, created_at) VALUES ('r1', 'c1', ?, 'spam', 1)")
			.run(ADMIN_ID);
	};
	return {
		...h,
		discordEnv,
		telegramEnv,
		bothEnv,
		calls,
		setting,
		discordCalls,
		telegramCalls,
		setChannel,
		addTelegramOperator,
		addOpenReport,
	};
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("runDiscordDigest gate", () => {
	it("does nothing when the bot token is missing", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		const { DISCORD_BOT_TOKEN: _token, ...noToken } = t.discordEnv;
		await runDiscordDigest(noToken as never, NOW);
		expect(t.discordCalls()).toEqual([]);
		expect(t.setting("dc_digest_last_sent_at")).toBeUndefined();
	});

	it("does nothing when the public key is missing", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		const { DISCORD_PUBLIC_KEY: _key, ...noKey } = t.discordEnv;
		await runDiscordDigest(noKey as never, NOW);
		expect(t.discordCalls()).toEqual([]);
		expect(t.setting("dc_digest_last_sent_at")).toBeUndefined();
	});

	it("does nothing and does not stamp the clock when no channel is set", async () => {
		const t = setup();
		await runDiscordDigest(t.discordEnv as never, NOW);
		expect(t.discordCalls()).toEqual([]);
		expect(t.setting("dc_digest_last_sent_at")).toBeUndefined();
	});
});

describe("runDiscordDigest send", () => {
	it("posts once to the digest channel with the bot token, then holds for 23 h", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		t.addOpenReport();
		await runDiscordDigest(t.discordEnv as never, NOW);
		expect(t.discordCalls()).toHaveLength(1);
		const call = t.discordCalls()[0] as Call;
		expect(call.auth).toBe("Bot fake-bot-token");
		expect(call.body.allowed_mentions).toEqual({ parse: [] });
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));

		await runDiscordDigest(t.discordEnv as never, NOW + 22 * 3600 * 1000);
		expect(t.discordCalls()).toHaveLength(1);
		await runDiscordDigest(t.discordEnv as never, NOW + DAY);
		expect(t.discordCalls()).toHaveLength(2);
	});

	it("carries the same counts as the Telegram digest and the queue link, never bodies", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		t.addOpenReport();
		await runDiscordDigest(t.discordEnv as never, NOW);
		const content = (t.discordCalls()[0]?.body.content ?? "") as string;
		expect(content).toContain("Pending: **1**");
		expect(content).toContain("most on `hot-post` (1)");
		expect(content).toContain("Spam (7d)");
		expect(content).toContain("Banned users: **0**");
		expect(content).toContain("Oldest pending: **3h** old");
		expect(content).toContain("[Open moderation queue](https://comments.example.com/admin/queue)");
		expect(content).not.toContain("secret body");
	});

	it("omits the queue link when PUBLIC_BASE_URL is unset", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		const { PUBLIC_BASE_URL: _base, ...noBase } = t.discordEnv;
		await runDiscordDigest(noBase as never, NOW);
		const content = (t.discordCalls()[0]?.body.content ?? "") as string;
		expect(content).not.toContain("Open moderation queue");
		expect(content).toContain("Pending:");
	});

	it("logs a warning with status only and still stamps the clock when the post fails", async () => {
		const t = setup({ discordStatus: 500 });
		t.setChannel(CHANNEL);
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		await runDiscordDigest(t.discordEnv as never, NOW);
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));
		const digestWarns = warn.mock.calls.filter(([event]) => event === "discord.digest.failed");
		expect(digestWarns).toEqual([["discord.digest.failed", { status: 500 }]]);
		await runDiscordDigest(t.discordEnv as never, NOW + DAY);
		expect(t.discordCalls()).toHaveLength(2);
	});
});

describe("independent digest gates", () => {
	it("Discord only: stamps the Discord key and never the Telegram key", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		await runDiscordDigest(t.discordEnv as never, NOW);
		await runTelegramDigest(t.bothEnv, NOW);
		expect(t.discordCalls()).toHaveLength(1);
		expect(t.telegramCalls()).toEqual([]);
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));
		expect(t.setting("tg_digest_last_sent_at")).toBeUndefined();
	});

	it("Telegram only: stamps the Telegram key and never the Discord key", async () => {
		const t = setup();
		await t.addTelegramOperator();
		await runDiscordDigest(t.discordEnv as never, NOW);
		await runTelegramDigest(t.telegramEnv, NOW);
		expect(t.discordCalls()).toEqual([]);
		expect(t.telegramCalls()).toHaveLength(1);
		expect(t.setting("tg_digest_last_sent_at")).toBe(String(NOW));
		expect(t.setting("dc_digest_last_sent_at")).toBeUndefined();
	});

	it("both transports send: each stamps its own key", async () => {
		const t = setup();
		t.setChannel(CHANNEL);
		await t.addTelegramOperator();
		await runDiscordDigest(t.discordEnv as never, NOW);
		await runTelegramDigest(t.bothEnv, NOW);
		expect(t.discordCalls()).toHaveLength(1);
		expect(t.telegramCalls()).toHaveLength(1);
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));
		expect(t.setting("tg_digest_last_sent_at")).toBe(String(NOW));
	});

	it("Discord fails while Telegram sends: Telegram stamps, Discord stamps only on its own pass", async () => {
		const t = setup({ discordStatus: 500 });
		t.setChannel(CHANNEL);
		await t.addTelegramOperator();
		await runDiscordDigest(t.discordEnv as never, NOW);
		await runTelegramDigest(t.bothEnv, NOW);
		expect(t.telegramCalls()).toHaveLength(1);
		expect(t.setting("tg_digest_last_sent_at")).toBe(String(NOW));
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));
	});

	it("Telegram fails while Discord sends: Discord stamps, Telegram stamps on its own pass", async () => {
		const t = setup({ telegramStatus: 500 });
		t.setChannel(CHANNEL);
		await t.addTelegramOperator();
		await runTelegramDigest(t.bothEnv, NOW);
		await runDiscordDigest(t.discordEnv as never, NOW);
		expect(t.discordCalls()).toHaveLength(1);
		expect(t.setting("dc_digest_last_sent_at")).toBe(String(NOW));
		expect(t.setting("tg_digest_last_sent_at")).toBe(String(NOW));
	});
});
