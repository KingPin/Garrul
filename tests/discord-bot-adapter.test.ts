/**
 * The discord_bot webhook adapter, against REAL SQLite with a stubbed fetch:
 * rendered body, admin save validation, delivery request, token hygiene.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonsFor } from "../src/lib/opbot/cards";
import { dispatchWebhook, runWebhookRetries } from "../src/lib/webhook";
import { renderDiscordBotBody } from "../src/lib/webhook-adapters";
import { MOD_ID, adminHarness } from "./helpers/admin-sqlite";

const CHANNEL = "666666666666666666";
const GUILD = "777777777777777777";
const TOKEN = "fake-bot-token-xyz";
const POST_URL = `https://discord.com/api/v10/channels/${CHANNEL}/messages`;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const setup = () => {
	const h = adminHarness();
	const env = h.env as unknown as Record<string, unknown>;
	const enable = () => {
		env.DISCORD_BOT_TOKEN = TOKEN;
		env.DISCORD_PUBLIC_KEY = "ab".repeat(32);
		h.sqlite
			.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discord_guild_id', ?, 0)")
			.run(GUILD);
	};
	h.sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'Post', NULL, 1)").run();
	h.sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, ip_hash, user_agent, created_at, depth)
			 VALUES ('c1', 'p', NULL, ?, 'hello @everyone', '<p>hello</p>', 1, 'pending', NULL, NULL, 1, 1)`,
		)
		.run(MOD_ID);
	return { ...h, env, enable };
};

const PAYLOAD = {
	event: "comment.posted" as const,
	comment_id: "c1",
	post_slug: "p",
	user_id: MOD_ID,
	ts: 1,
};

const addEndpoint = (h: ReturnType<typeof setup>, adapter = "discord_bot") =>
	h.sqlite
		.prepare(
			`INSERT INTO webhook_endpoints (id, url, adapter, enabled, fail_count, created_at, updated_at)
			 VALUES ('e1', ?, ?, 1, 0, 1, 1)`,
		)
		.run(CHANNEL, adapter);

describe("renderDiscordBotBody", () => {
	it("is the embed plus moderation buttons and no mention parsing", async () => {
		const h = setup();
		const body = JSON.parse(await renderDiscordBotBody(h.env.DB as never, PAYLOAD, {}));
		expect(body.embeds).toHaveLength(1);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const expected = buttonsFor("pending", { reported: false, banLabel: "banr" });
		expect(body.components).toHaveLength(expected.length);
		const first = body.components[0];
		expect(first.type).toBe(1);
		expect(first.components[0]).toMatchObject({ type: 2 });
		expect(first.components[0].label).toBe(expected[0]?.[0]?.label);
		expect(first.components[0].custom_id).toContain("c1");
		expect(JSON.stringify(body)).not.toContain("hello @everyone");
	});
});

describe("saving a discord_bot endpoint", () => {
	const save = (h: ReturnType<typeof setup>, url: string) =>
		h.request("/admin/api/webhooks", { method: "POST", body: { url, adapter: "discord_bot" } });

	it("rejects a non-snowflake id and an unconfigured feature", async () => {
		const h = setup();
		const bad = await save(h, "not-an-id");
		expect(bad.status).toBe(400);
		const off = await save(h, CHANNEL);
		expect(off.status).toBe(400);
		expect(await off.json()).toEqual({ error: "discord_not_configured" });
	});

	it("maps channel validation failures and accepts a good channel", async () => {
		const h = setup();
		h.enable();
		const channel = (body: unknown, status = 200) =>
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(JSON.stringify(body), { status })),
			);
		channel({}, 404);
		expect(await (await save(h, CHANNEL)).json()).toEqual({ error: "channel_not_found" });
		channel({ type: 0, guild_id: "888888888888888888" });
		expect(await (await save(h, CHANNEL)).json()).toEqual({ error: "channel_wrong_guild" });
		channel({ type: 2, guild_id: GUILD });
		expect(await (await save(h, CHANNEL)).json()).toEqual({ error: "channel_wrong_type" });
		channel({ type: 0, guild_id: GUILD });
		const ok = await save(h, CHANNEL);
		expect(ok.status).toBe(200);
		expect(h.sqlite.prepare("SELECT adapter, url FROM webhook_endpoints").get()).toEqual({
			adapter: "discord_bot",
			url: CHANNEL,
		});
	});
});

describe("delivery", () => {
	it("posts with the bot token header and never stores the token", async () => {
		const h = setup();
		h.enable();
		addEndpoint(h);
		const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		await dispatchWebhook(h.env as never, PAYLOAD);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(POST_URL);
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bot ${TOKEN}`);
		expect(headers["x-garrul-signature"]).toBeUndefined();
		const row = h.sqlite.prepare("SELECT payload FROM webhook_deliveries").get() as { payload: string };
		expect(row.payload).not.toContain(TOKEN);
		expect(JSON.parse(row.payload).components).toBeDefined();
	});

	it("fails with discord:not_configured when the feature is off", async () => {
		const h = setup();
		addEndpoint(h);
		h.sqlite
			.prepare(
				`INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, status, attempts, next_attempt_at, created_at)
				 VALUES ('d1', 'e1', 'comment.posted', '{}', 'pending', 0, 1, 1)`,
			)
			.run();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await runWebhookRetries(h.env as never);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(h.sqlite.prepare("SELECT last_error FROM webhook_deliveries").get()).toEqual({
			last_error: "discord:not_configured",
		});
	});

	it("keeps the token out of logged error strings", async () => {
		const h = setup();
		h.enable();
		addEndpoint(h);
		const lines: string[] = [];
		const grab = (l: unknown) => lines.push(String(l));
		vi.spyOn(console, "log").mockImplementation(grab);
		vi.spyOn(console, "warn").mockImplementation(grab);
		vi.spyOn(console, "error").mockImplementation(grab);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(`boom Bot ${TOKEN}`);
			}),
		);
		await dispatchWebhook(h.env as never, PAYLOAD);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join("\n")).not.toContain(TOKEN);
	});
});
