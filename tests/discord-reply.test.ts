/**
 * POST /discord/interactions against REAL SQLite (every migration applied).
 * Requests are Ed25519-signed with a generated key pair. fireWebhook and the
 * global fetch are mocked: nothing in this route may reach the network.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/webhook", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/webhook")>()),
	fireWebhook: vi.fn(),
}));

import { insertComment, insertSavedReply } from "../src/db/queries";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import type { Bindings } from "../src/index";
import { loadDiscordSettings } from "../src/lib/settings";
import { discord } from "../src/routes/discord";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { makeD1, makeKv } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const GUILD = "100000000000000001";
const MOD_ROLE = "200000000000000001";
const ADMIN_ROLE = "200000000000000002";
const MOD_DC = "300000000000000001";
const NOBODY_DC = "300000000000000003";
const AUTHOR = "01HAUTHOR000000000000000AB";
const STAFF_AUTHOR = "01HSTAFF0000000000000000AB";
const EPHEMERAL = 64;
const MOD_USER = "01HMODUSER0000000000000AAA";
const OTHER_MOD = "01HOTHERMOD000000000000AAA";
const ALERT_MSG = "600000000000000001";
const ALERT_CH = "700000000000000001";

const hex = (b: ArrayBuffer) =>
	[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

let keys: CryptoKeyPair;
let publicHex: string;
let sqlite: DatabaseSync;
let kv: ReturnType<typeof makeKv>;
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;

const pending: Promise<unknown>[] = [];
const execCtx = {
	waitUntil(p: Promise<unknown>) {
		pending.push(p);
	},
	passThroughOnException() {},
} as unknown as ExecutionContext;
const settle = () => Promise.all(pending.splice(0));

const setting = (key: string, value: string) =>
	sqlite.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, 1)").run(key, value);

const addUser = (id: string, role: "user" | "mod" | "admin", name: string, provider = "github", banned = 0) =>
	sqlite
		.prepare(
			"INSERT INTO users (id, provider, provider_id, name, role, is_admin, is_banned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(id, provider, id, name, role, role === "admin" ? 1 : 0, banned, 1_700_000_000_000);

const seedComment = async (status: "pending" | "approved" = "pending", userId = AUTHOR) =>
	(
		await insertComment(env.DB, {
			post_slug: "hello",
			parent_id: null,
			user_id: userId,
			body_md: "a comment",
			body_html: "<p>a comment</p>",
			renderer_version: 1,
			status,
			ip_hash: null,
			user_agent: null,
			depth: 1,
		})
	).id;

const link = (dc: string, userId: string) =>
	sqlite
		.prepare("INSERT INTO discord_links (discord_user_id, user_id, linked_at) VALUES (?, ?, 1)")
		.run(dc, userId);

const signedRequest = async (body: unknown, opts: { ts?: number; sig?: string } = {}) => {
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
	const sig =
		opts.sig ??
		hex(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, new TextEncoder().encode(ts + raw)));
	return {
		method: "POST",
		headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts, "content-type": "application/json" },
		body: raw,
	};
};

const send = async (body: unknown, opts: { ts?: number; sig?: string; env?: Bindings } = {}) => {
	const app = new Hono<{ Bindings: Bindings }>().route("/discord", discord);
	const res = await app.request(
		"/discord/interactions",
		await signedRequest(body, opts),
		(opts.env ?? env) as unknown as Record<string, unknown>,
		execCtx,
	);
	return { status: res.status, json: (await res.json().catch(() => null)) as any };
};

const base = (dc: string, over: Record<string, unknown> = {}) => ({
	id: "400000000000000001",
	token: "tok",
	application_id: "500000000000000001",
	guild_id: GUILD,
	member: { user: { id: dc, username: "uname", global_name: "Display" }, roles: [] as string[] },
	...over,
});
const asMod = (over: Record<string, unknown> = {}) =>
	base(MOD_DC, { ...over, member: { user: { id: MOD_DC, username: "modu", global_name: "ModDisplay" }, roles: [MOD_ROLE] } });



beforeEach(async () => {
	keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	publicHex = hex((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
	sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	kv = makeKv();
	env = {
		DB: makeD1(sqlite),
		OAUTH_STATE: kv,
		SESSIONS: makeKv(),
		RATE_LIMITS: makeKv(),
		TREE_CACHE: makeKv(),
		ANALYTICS: { writeDataPoint() {} },
		IP_HASH_SECRET: "test-secret",
		ENV: "dev",
		PUBLIC_BASE_URL: "https://comments.example.com",
		DISCORD_BOT_TOKEN: "bot-token",
		DISCORD_PUBLIC_KEY: publicHex,
	} as unknown as Bindings;
	setting("discord_guild_id", GUILD);
	setting("discord_mod_role_id", MOD_ROLE);
	setting("discord_admin_role_id", ADMIN_ROLE);
	addUser(MOD_USER, "mod", "Mod One");
	addUser(OTHER_MOD, "mod", "Mod Two");
	link(MOD_DC, MOD_USER);
	addUser(AUTHOR, "user", "Author", "anon");
	addUser(STAFF_AUTHOR, "mod", "StaffAuthor");
	sqlite.prepare("INSERT INTO posts (slug, created_at) VALUES ('hello', 1)").run();
	installMockCaches();
	fetchMock = vi.fn(async () => {
		throw new Error("unexpected outbound fetch");
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	uninstallMockCaches();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});


const component = (who: (o: Record<string, unknown>) => any, custom_id: string) =>
	who({ type: 3, data: { custom_id }, message: { id: ALERT_MSG, channel_id: ALERT_CH, embeds: [{ title: "Alert" }] } });
const preset = (owner: string, title: string, body_md: string, scope: "private" | "shared" = "shared") =>
	insertSavedReply(env.DB, { owner_id: owner, title, body_md, scope });
const select = (who: (o: Record<string, unknown>) => any, custom_id: string, value: string) =>
	send(who({
		type: 3,
		channel_id: ALERT_CH,
		data: { custom_id, values: [value], component_type: 3 },
		message: { id: "800000000000000001", channel_id: ALERT_CH, flags: EPHEMERAL },
	}));
const submit = (who: (o: Record<string, unknown>) => any, custom_id: string, text: string) =>
	send(who({
		type: 5,
		channel_id: ALERT_CH,
		data: { custom_id, components: [{ components: [{ custom_id: "body", value: text }] }] },
		message: { id: "800000000000000001", channel_id: ALERT_CH, flags: EPHEMERAL },
	}));
const options = (r: any) => r.json.data.components[0].components[0].options as { label: string; value: string }[];
const replyCount = (parent: string) =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?").get(parent) as { n: number }).n;
const alertTap = (cid: string) =>
	send({
		...asMod({ type: 3, data: { custom_id: `g:reply:${cid}` } }),
		channel_id: ALERT_CH,
		message: { id: ALERT_MSG, channel_id: ALERT_CH, embeds: [{ title: "Alert" }] },
	});

describe("Discord reply flow", () => {
	it("alert Reply tap answers an ephemeral select with the alert message id as origin", async () => {
		const cid = await seedComment("approved");
		await preset(MOD_USER, "Thanks", "thanks {name}");
		const r = await alertTap(cid);
		expect(r.json.type).toBe(4);
		expect(r.json.data.flags).toBe(EPHEMERAL);
		expect(r.json.data.allowed_mentions).toEqual({ parse: [] });
		expect(r.json.data.components[0].components[0].custom_id).toBe(`g:pick:${cid}:${ALERT_MSG}:0`);
	});

	it("queue Reply tap updates the card in place with origin q", async () => {
		const cid = await seedComment("pending");
		const r = await send(await component(asMod, `g:reply:${cid}:q`));
		expect(r.json.type).toBe(7);
		expect(r.json.data.components[0].components[0].custom_id).toBe(`g:pick:${cid}:q:0`);
	});

	it("lists own private plus shared presets, never another mod's private, with long labels cut", async () => {
		const cid = await seedComment("approved");
		await preset(MOD_USER, "t".repeat(150), "x", "private");
		await preset(OTHER_MOD, "Theirs", "x", "private");
		await preset(OTHER_MOD, "Shared one", "x", "shared");
		const opts = options(await alertTap(cid));
		const labels = opts.map((o) => o.label);
		expect(labels).toContain("Shared one");
		expect(labels).not.toContain("Theirs");
		const cut = labels.find((l) => l.startsWith("ttt")) as string;
		expect(cut).toBe(`${"t".repeat(99)}…`);
		expect(opts.at(-1)).toEqual({ label: "✏️ Write custom", value: "custom" });
		expect(opts.some((o) => o.value === "more")).toBe(false);
	});

	it("pages 30 presets as 25 options then 8, More… moves the offset by 23 and opens no modal", async () => {
		const cid = await seedComment("approved");
		for (let n = 0; n < 30; n++) await preset(MOD_USER, `P${n}`, "x");
		const p0 = await alertTap(cid);
		const o0 = options(p0);
		expect(o0).toHaveLength(25);
		expect(o0.at(-2)).toEqual({ label: "✏️ Write custom", value: "custom" });
		expect(o0.at(-1)).toEqual({ label: "More…", value: "more" });
		const more = await select(asMod, `g:pick:${cid}:${ALERT_MSG}:0`, "more");
		expect(more.json.type).toBe(7);
		expect(more.json.data.components[0].components[0].custom_id).toBe(`g:pick:${cid}:${ALERT_MSG}:23`);
		const o1 = options(more);
		expect(o1).toHaveLength(8);
		expect(o1.at(-1)?.value).toBe("custom");
		const ids0 = new Set(o0.map((o) => o.value));
		expect(o1.some((o) => ids0.has(o.value) && o.value.length > 6)).toBe(false);
	});

	it("leaves out presets whose expanded body exceeds 4000 and says so", async () => {
		const cid = await seedComment("approved");
		await preset(MOD_USER, "Big", "{mod}".repeat(700));
		await preset(MOD_USER, "Small", "ok");
		const r = await alertTap(cid);
		const labels = options(r).map((o) => o.label);
		expect(labels).toContain("Small");
		expect(labels).not.toContain("Big");
		expect(r.json.data.content).toContain("Some saved replies are too long for Discord. Use the dashboard for those.");
	});

	it("preset pick opens a prefilled modal within 2 D1 reads and no writes; custom opens it empty", async () => {
		const cid = await seedComment("approved");
		const p = await preset(MOD_USER, "Hi", "Hi {name} on {post} from {mod}");
		await loadDiscordSettings(env); // settings are memoized, not part of the bound
		const prepare = vi.spyOn(env.DB, "prepare");
		const r = await select(asMod, `g:pick:${cid}:${ALERT_MSG}:0`, p.id);
		const sql = prepare.mock.calls.map((c) => String(c[0]).trim());
		expect(sql.length).toBeLessThanOrEqual(2);
		for (const s of sql) expect(s.toUpperCase().startsWith("SELECT")).toBe(true);
		expect(r.json.type).toBe(9);
		expect(r.json.data.custom_id).toBe(`g:rsub:${cid}:${ALERT_MSG}:${p.id}`);
		expect(r.json.data.title).toBe("Reply to comment");
		const input = r.json.data.components[0].components[0];
		expect(input).toMatchObject({ type: 4, custom_id: "body", style: 2, required: true, max_length: 4000 });
		expect(input.value).toBe("Hi Author on hello from Mod One");
		const c = await select(asMod, `g:pick:${cid}:${ALERT_MSG}:0`, "custom");
		expect(c.json.type).toBe(9);
		expect(c.json.data.custom_id).toBe(`g:rsub:${cid}:${ALERT_MSG}`);
		expect(c.json.data.components[0].components[0].value ?? "").toBe("");
	});

	it("modal open refuses another mod's private preset and non-staff with no modal", async () => {
		const cid = await seedComment("approved");
		const theirs = await preset(OTHER_MOD, "Secret", "secret body", "private");
		const r = await select(asMod, `g:pick:${cid}:${ALERT_MSG}:0`, theirs.id);
		expect(r.json.type).toBe(4);
		expect(JSON.stringify(r.json)).not.toContain("secret body");
		const nobody = await select(base.bind(null, NOBODY_DC) as any, `g:pick:${cid}:${ALERT_MSG}:0`, "custom");
		expect(nobody.json.type).toBe(4);
	});

	it("alert submit posts the reply, updates the picker and PATCHes the alert in waitUntil", async () => {
		const cid = await seedComment("pending");
		const p = await preset(MOD_USER, "Hi", "Hi");
		fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
		const r = await submit(asMod, `g:rsub:${cid}:${ALERT_MSG}:${p.id}`, "Thanks for the comment");
		expect(r.json.type).toBe(7);
		expect(r.json.data.content).toBe("Reply posted ✅");
		expect(r.json.data.components).toEqual([]);
		expect(r.json.data.allowed_mentions).toEqual({ parse: [] });
		expect(replyCount(cid)).toBe(1);
		const audit = sqlite.prepare("SELECT meta FROM audit_log WHERE action = 'comment.reply'").get() as { meta: string };
		expect(JSON.parse(audit.meta).saved_reply_id).toBe(p.id);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`https://discord.com/api/v10/channels/${ALERT_CH}/messages/${ALERT_MSG}`);
		expect(init.method).toBe("PATCH");
		expect((init.headers as Record<string, string>).authorization).toBe("Bot bot-token");
		const body = JSON.parse(init.body as string);
		expect(body.content).toContain("Reply posted by Mod One");
		expect("embeds" in body).toBe(false);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(JSON.stringify(body.components)).toContain(`g:banr:${cid}`);
		expect(JSON.stringify(body.components)).toContain(`g:approve:${cid}`);
	});

	it("a failed alert PATCH leaves the reply posted", async () => {
		const cid = await seedComment("approved");
		fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
		const r = await submit(asMod, `g:rsub:${cid}:${ALERT_MSG}`, "hello");
		expect(r.json.type).toBe(7);
		await settle();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(replyCount(cid)).toBe(1);
	});

	it("queue submit re-renders the queue card with done-by and Next and makes no PATCH", async () => {
		const cid = await seedComment("pending");
		const r = await submit(asMod, `g:rsub:${cid}:q`, "hello");
		expect(r.json.type).toBe(7);
		expect(JSON.stringify(r.json.data.embeds)).toContain("Reply posted by Mod One");
		expect(JSON.stringify(r.json.data.components)).toContain(`g:nx:${cid}:q`);
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(replyCount(cid)).toBe(1);
	});

	it("refusals answer an ephemeral plain message and post nothing", async () => {
		const deleted = await seedComment("approved");
		sqlite.prepare("UPDATE comments SET status = 'deleted' WHERE id = ?").run(deleted);
		const deep = await seedComment("approved");
		sqlite.prepare("UPDATE comments SET depth = ? WHERE id = ?").run(MAX_REPLY_DEPTH, deep);
		const ok = await seedComment("approved");
		const theirs = await preset(OTHER_MOD, "Secret", "s", "private");
		const cases: [string, string, string][] = [
			[`g:rsub:${deleted}:${ALERT_MSG}`, "hi", "That comment was deleted."],
			[`g:rsub:${deep}:${ALERT_MSG}`, "hi", "That thread is too deep to reply to. Reply higher up from the dashboard."],
			[`g:rsub:${ok}:${ALERT_MSG}`, "x".repeat(20000), "Reply too long (max "],
			[`g:rsub:${ok}:${ALERT_MSG}`, "   ", "Reply text is empty."],
			[`g:rsub:${ok}:${ALERT_MSG}:${theirs.id}`, "hi", "That saved reply isn't available here."],
			[`g:rsub:01HNOSUCHCOMMENT00000000AA:${ALERT_MSG}`, "hi", "That comment no longer exists."],
		];
		for (const [id, text, msg] of cases) {
			const r = await submit(asMod, id, text);
			expect(r.json.type).toBe(4);
			expect(r.json.data.flags).toBe(EPHEMERAL);
			expect(r.json.data.content).toContain(msg);
		}
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(replyCount(deleted) + replyCount(deep) + replyCount(ok)).toBe(0);
	});

	it("submit re-authorizes: a linked non-staff user cannot reply", async () => {
		const cid = await seedComment("approved");
		const r = await submit((o) => base(NOBODY_DC, o), `g:rsub:${cid}:${ALERT_MSG}`, "hi");
		expect(r.json.type).toBe(4);
		expect(replyCount(cid)).toBe(0);
	});
});

describe("interaction envelope guards", () => {
	it("400s a JSON body that is not an object", async () => {
		for (const raw of ["null", "42", '"x"']) {
			const r = await send(raw);
			expect(r.status).toBe(400);
		}
	});

	it("answers Unknown action for other interaction types before any D1 read", async () => {
		const prepare = vi.spyOn(env.DB, "prepare");
		const r = await send(asMod({ type: 4, data: { name: "x" } }));
		expect(r.json.data.content).toBe("Unknown action.");
		expect(prepare).not.toHaveBeenCalled();
	});
});
