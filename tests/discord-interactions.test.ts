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

import { insertComment } from "../src/db/queries";
import type { Bindings } from "../src/index";
import { loadDiscordSettings } from "../src/lib/settings";
import { feedCacheKey } from "../src/lib/tree-cache";
import { discord } from "../src/routes/discord";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import { makeD1, makeKv } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const GUILD = "100000000000000001";
const MOD_ROLE = "200000000000000001";
const ADMIN_ROLE = "200000000000000002";
const MOD_DC = "300000000000000001";
const ADMIN_DC = "300000000000000002";
const NOBODY_DC = "300000000000000003";
const AUTHOR = "01HAUTHOR000000000000000AB";
const STAFF_AUTHOR = "01HSTAFF0000000000000000AB";
const EPHEMERAL = 64;

const hex = (b: ArrayBuffer) =>
	[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

let keys: CryptoKeyPair;
let publicHex: string;
let sqlite: DatabaseSync;
let kv: ReturnType<typeof makeKv>;
let env: Bindings;
let fetchMock: ReturnType<typeof vi.fn>;

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

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
	member: { user: { id: dc, username: "testuser", global_name: "Display" }, roles: [] as string[] },
	...over,
});
const asMod = (over: Record<string, unknown> = {}) =>
	base(MOD_DC, { ...over, member: { user: { id: MOD_DC, username: "testmod", global_name: "ModDisplay" }, roles: [MOD_ROLE] } });
const asAdmin = (over: Record<string, unknown> = {}) =>
	base(ADMIN_DC, { ...over, member: { user: { id: ADMIN_DC, username: "testadmin", global_name: null }, roles: [ADMIN_ROLE] } });

const command = (who: (o: Record<string, unknown>) => any, name: string, value?: string, optName = "id") =>
	who({ type: 2, data: { name, options: value === undefined ? [] : [{ name: optName, value }] } });
const component = (who: (o: Record<string, unknown>) => any, custom_id: string, message?: unknown) =>
	who({ type: 3, data: { custom_id }, message: message ?? { id: "600000000000000001", channel_id: "700000000000000001", embeds: [{ title: "Alert" }] } });
const modal = (who: (o: Record<string, unknown>) => any, custom_id: string, reason: string) =>
	who({
		type: 5,
		data: { custom_id, components: [{ components: [{ custom_id: "reason", value: reason }] }] },
		message: { id: "600000000000000001", channel_id: "700000000000000001", embeds: [{ title: "Alert" }] },
	});

const commentStatus = (id: string) =>
	(sqlite.prepare("SELECT status FROM comments WHERE id = ?").get(id) as { status: string }).status;
const auditCount = (action: string) =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
const isBanned = (id: string) =>
	(sqlite.prepare("SELECT is_banned FROM users WHERE id = ?").get(id) as { is_banned: number }).is_banned;

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

describe("POST /discord/interactions", () => {
	it("404s when either env var is missing", async () => {
		const a = await send({ type: 1 }, { env: { ...env, DISCORD_PUBLIC_KEY: undefined } as unknown as Bindings });
		const b = await send({ type: 1 }, { env: { ...env, DISCORD_BOT_TOKEN: undefined } as unknown as Bindings });
		expect([a.status, b.status]).toEqual([404, 404]);
	});

	it("401s a bad signature or stale timestamp with zero D1 and KV calls", async () => {
		const prepare = vi.spyOn(env.DB, "prepare");
		const kvSpies = (["get", "put", "delete"] as const).map((m) => vi.spyOn(env.OAUTH_STATE, m as never));
		const rlSpies = (["get", "put", "delete"] as const).map((m) => vi.spyOn(env.RATE_LIMITS, m as never));
		const bad = await send({ type: 1 }, { sig: "00".repeat(64) });
		const stale = await send({ type: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 });
		expect([bad.status, stale.status]).toEqual([401, 401]);
		expect(prepare).not.toHaveBeenCalled();
		for (const s of [...kvSpies, ...rlSpies]) expect(s).not.toHaveBeenCalled();
	});

	it("answers PING with type 1", async () => {
		const r = await send({ type: 1 });
		expect(r.json).toEqual({ type: 1 });
	});

	it("rate limits per discord user with an ephemeral refusal", async () => {
		addUser("01HMODUSER00000000000000AB", "mod", "ModUser");
		link(MOD_DC, "01HMODUSER00000000000000AB");
		let last: any;
		for (let i = 0; i < 11; i++) last = await send(command(asMod, "stats"));
		expect(last.json.data.content).toBe("Slow down — too many actions. Try again in a moment.");
		expect(last.json.data.flags).toBe(EPHEMERAL);
		// A different user is unaffected.
		const other = await send(command(asAdmin, "stats"));
		expect(other.json.data.content).not.toContain("Slow down");
	});

	it("refuses wrong guild, DM, banned and unlinked users", async () => {
		const wrong = await send({ ...command(asMod, "stats"), guild_id: "100000000000000099" });
		expect(wrong.json.data.content).toBe("This bot only works in its configured server.");
		const dmBody = { ...command(asMod, "stats"), guild_id: undefined, member: undefined, user: { id: MOD_DC } };
		expect((await send(dmBody)).json.data.content).toBe("This bot only works in its configured server.");

		addUser("01HBANNED0000000000000000AB", "mod", "Banned", "github", 1);
		link(NOBODY_DC, "01HBANNED0000000000000000AB");
		const banned = await send(await command((o) => base(NOBODY_DC, o), "stats"));
		expect(banned.json.data.content).toBe("Your account doesn't have moderation access.");

		const unlinked = await send(await command((o) => base("300000000000000009", o), "stats"));
		expect(unlinked.json.data.content).toBe("Link your account first with /link, or ask an admin for the mod role.");
	});

	it("/link redeems a dc: token without any role and writes discord_links", async () => {
		addUser("01HLINKME0000000000000000AB", "mod", "Linked <@123456789012345678>");
		const code = "ab".repeat(24);
		kv.store.set(`dc:link:${code}`, JSON.stringify({ user_id: "01HLINKME0000000000000000AB", created_at: 1 }));
		const spy = vi.spyOn(kv, "get");
		const r = await send(await command((o) => base(NOBODY_DC, o), "link", code, "code"));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(r.json.data.flags).toBe(EPHEMERAL);
		expect(r.json.data.content).toMatch(/^Linked to Linked/);
		expect(r.json.data.content).not.toContain("<@123456789012345678>");
		const row = sqlite.prepare("SELECT user_id FROM discord_links WHERE discord_user_id = ?").get(NOBODY_DC) as any;
		expect(row.user_id).toBe("01HLINKME0000000000000000AB");
		const bad = await send(await command((o) => base(NOBODY_DC, o), "link", "cd".repeat(24), "code"));
		expect(bad.json.data.content).toBe("That link code is invalid or expired.");
	});

	it("/queue /stats /comment /user answer ephemeral type 4", async () => {
		const cid = await seedComment("pending");
		const q = await send(await command(asMod, "queue"));
		expect(q.json.type).toBe(4);
		expect(q.json.data.flags).toBe(EPHEMERAL);
		expect(q.json.data.allowed_mentions).toEqual({ parse: [] });
		expect(JSON.stringify(q.json.data.components)).toContain("g:rv:-:q");
		expect(JSON.stringify(q.json.data.components)).toContain("Review ▶");
		for (const [name, val] of [["stats"], ["comment", cid], ["user", AUTHOR]] as const) {
			const r = await send(await command(asMod, name, val));
			expect(r.json.type).toBe(4);
			expect(r.json.data.flags).toBe(EPHEMERAL);
		}
		const gone = await send(await command(asMod, "comment", "01HNOPE"));
		expect(gone.json.data.content).toBe("That comment no longer exists.");
		const u = await send(await command(asMod, "user", AUTHOR));
		expect(u.json.data.content).toContain("Not banned");
		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(AUTHOR);
		const purged = await send(await command(asMod, "user", AUTHOR));
		expect(purged.json.data.content).toContain("Banned — reason no longer available");
	});

	it("/unban: admin unbans with audit, role admin cannot touch staff, mod is refused", async () => {
		addUser("01HBANNEDU000000000000000A", "user", "Bad", "anon", 1);
		const ok = await send(await command(asAdmin, "unban", "01HBANNEDU000000000000000A"));
		expect(ok.json.data.flags).toBe(EPHEMERAL);
		expect(isBanned("01HBANNEDU000000000000000A")).toBe(0);
		expect(auditCount("unban")).toBe(1);

		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(STAFF_AUTHOR);
		const staff = await send(await command(asAdmin, "unban", STAFF_AUTHOR));
		expect(staff.json.data.content).toBe("You can't unban a moderator or admin with a Discord role grant.");
		expect(isBanned(STAFF_AUTHOR)).toBe(1);

		const mod = await send(await command(asMod, "unban", "01HBANNEDU000000000000000A"));
		expect(mod.json.data.content).toBe("Your account doesn't have moderation access.");
	});

	it("alert buttons answer type 7 echoing embeds with doneBy and new components", async () => {
		const cid = await seedComment("pending");
		const r = await send(await component(asMod, `g:approve:${cid}`));
		expect(r.json.type).toBe(7);
		expect(r.json.data.embeds).toEqual([{ title: "Alert" }]);
		expect(r.json.data.content).toBe("Approved by ModDisplay");
		expect(commentStatus(cid)).toBe("approved");
		const ids = JSON.stringify(r.json.data.components);
		expect(ids).toContain(`g:spam:${cid}`);
		expect(ids).toContain(`g:banr:${cid}`);
		expect(ids).not.toContain(`g:approve:${cid}`);
		expect(r.json.data.allowed_mentions).toEqual({ parse: [] });
		const sp = await send(await component(asMod, `g:spam:${cid}`));
		expect(commentStatus(cid)).toBe("spam");
		expect(JSON.stringify(sp.json.data.components)).toContain(`g:restore:${cid}`);
		await send(await component(asMod, `g:restore:${cid}`));
		await send(await component(asMod, `g:delete:${cid}`));
		expect(commentStatus(cid)).toBe("deleted");
	});

	// Sends one interaction whose every D1 result waits until the defer timer has fired,
	// then lets the work finish and returns the response plus the late webhook calls.
	const sendSlow = async (body: unknown) => {
		let open!: () => void;
		const gate = new Promise<void>((r) => {
			open = r;
		});
		const slow = <T extends object>(o: T): T =>
			new Proxy(o, {
				get(t, k) {
					const v = Reflect.get(t, k);
					if (typeof v !== "function") return v;
					return (...a: unknown[]) => {
						const r = v.apply(t, a);
						if (r instanceof Promise) return gate.then(() => r);
						return r && typeof r === "object" ? slow(r) : r;
					};
				},
			});
		const waits: Promise<unknown>[] = [];
		vi.spyOn(execCtx, "waitUntil").mockImplementation((p: Promise<unknown>) => void waits.push(p));
		fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let res: Awaited<ReturnType<typeof send>> | undefined;
			const p = send(body, { env: { ...env, DB: slow(env.DB) } as Bindings }).then((r) => {
				res = r;
			});
			// Signature verification (crypto.subtle) settles on the real event loop, not on
			// fake timers, so yield real turns too or the gate can open before the defer
			// timer exists.
			const deadline = Date.now() + 5000;
			while (!res && Date.now() < deadline) {
				await vi.advanceTimersByTimeAsync(500);
				await new Promise((r) => setImmediate(r));
			}
			open();
			await p;
			await Promise.all(waits);
			return { json: res?.json, calls: fetchMock.mock.calls as [string, RequestInit][] };
		} finally {
			open();
			vi.useRealTimers();
		}
	};

	it("a slow button defers with type 6 and edits the clicked message through the interaction webhook", async () => {
		const cid = await seedComment("pending");
		const { json, calls } = await sendSlow(await component(asMod, `g:approve:${cid}`));
		expect(json).toEqual({ type: 6 });
		expect(commentStatus(cid)).toBe("approved");
		expect(calls).toHaveLength(1);
		const [url, init] = calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/v10/webhooks/500000000000000001/tok/messages/@original");
		expect(init.method).toBe("PATCH");
		expect(new Headers(init.headers).has("authorization")).toBe(false);
		expect(JSON.parse(init.body as string).content).toBe("Approved by ModDisplay");
	});

	it("a slow command defers as ephemeral and edits that response with the result", async () => {
		const { json, calls } = await sendSlow(await command(asMod, "stats"));
		expect(json).toEqual({ type: 5, data: { flags: EPHEMERAL } });
		const [url, init] = calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/v10/webhooks/500000000000000001/tok/messages/@original");
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body as string).content).toContain("**Stats**");
	});

	it("a slow ephemeral notice on a button goes out as a follow-up", async () => {
		const { json, calls } = await sendSlow(await component(asMod, "g:approve:01HNOPE0000000000000000000"));
		expect(json).toEqual({ type: 6 });
		const [url, init] = calls[0] as [string, RequestInit];
		expect(url).toBe("https://discord.com/api/v10/webhooks/500000000000000001/tok");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string).flags).toBe(EPHEMERAL);
	});

	it("banr opens a type 9 modal with at most 2 D1 reads and no writes", async () => {
		const cid = await seedComment("pending");
		await loadDiscordSettings(env); // settings are memoized per isolate
		const prepare = vi.spyOn(env.DB, "prepare");
		const r = await send(await component(asAdmin, `g:banr:${cid}:q`));
		expect(r.json.type).toBe(9);
		expect(r.json.data.custom_id).toBe(`g:bsub:${cid}:q`);
		expect(r.json.data.title).toBe("Ban author");
		const input = r.json.data.components[0].components[0];
		expect(input).toMatchObject({ type: 4, style: 2, custom_id: "reason", required: false, max_length: 500 });
		const sqls = prepare.mock.calls.map((c) => String(c[0]));
		expect(sqls.length).toBeLessThanOrEqual(2);
		expect(sqls.every((s) => /^\s*SELECT/i.test(s))).toBe(true);
		const mod = await send(await component(asMod, `g:banr:${cid}`));
		expect(mod.json.data.content).toBe("Your account doesn't have moderation access.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("banr: a Discord-sign-in admin (no link, no role grant) opens the modal; a banned one is refused", async () => {
		const cid = await seedComment("pending");
		const OAUTH_DC = "300000000000000009";
		const asOauth = (over: Record<string, unknown> = {}) =>
			base(OAUTH_DC, { ...over, member: { user: { id: OAUTH_DC, username: "testoauth" }, roles: [] as string[] } });
		sqlite
			.prepare(
				"INSERT INTO users (id, provider, provider_id, name, role, is_admin, is_banned, created_at) VALUES ('01HOAUTHADMIN000000000000A', 'discord', ?, 'OA', 'admin', 1, 0, 1)",
			)
			.run(OAUTH_DC);
		const ok = await send(await component(asOauth, `g:banr:${cid}`));
		expect(ok.json.type).toBe(9);
		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = '01HOAUTHADMIN000000000000A'").run();
		const banned = await send(await component(asOauth, `g:banr:${cid}`));
		expect(banned.json.type).toBe(4);
	});

	it("approve busts the cache key of the request origin when PUBLIC_BASE_URL is unset", async () => {
		const cid = await seedComment("pending");
		const key = feedCacheKey("http://localhost/discord/interactions", "hello");
		const cache = (globalThis as unknown as { caches: { default: { put(k: Request, r: Response): Promise<void>; store: Map<string, Response> } } }).caches.default;
		await cache.put(key, new Response("stale"));
		expect(cache.store.has(key.url)).toBe(true);
		const noBase = { ...env, PUBLIC_BASE_URL: undefined } as unknown as Bindings;
		const r = await send(await component(asMod, `g:approve:${cid}`), { env: noBase });
		expect(r.json.type).toBe(7);
		expect(cache.store.has(key.url)).toBe(false);
	});

	it("bsub bans with the reason and answers type 7; staff guard refuses with type 4", async () => {
		const cid = await seedComment("pending");
		const r = await send(await modal(asAdmin, `g:bsub:${cid}`, "spammer"));
		expect(r.json.type).toBe(7);
		expect(r.json.data.content).toBe("Banned by testadmin");
		expect(isBanned(AUTHOR)).toBe(1);
		const row = sqlite.prepare("SELECT reason FROM audit_log WHERE action = 'ban'").get() as any;
		expect(row.reason).toBe("spammer");

		const staffCid = await seedComment("pending", STAFF_AUTHOR);
		const g = await send(await modal(asAdmin, `g:bsub:${staffCid}`, ""));
		expect(g.json.type).toBe(4);
		expect(g.json.data.flags).toBe(EPHEMERAL);
		expect(isBanned(STAFF_AUTHOR)).toBe(0);
	});

	it("rv and nx walk the queue with type 7 queue cards and end on an empty message", async () => {
		const c1 = await seedComment("pending");
		const c2 = await seedComment("pending");
		const first = await send(await component(asMod, "g:rv:-:q"));
		expect(first.json.type).toBe(7);
		expect(first.json.data.embeds[0].title).toBe("Pending comment");
		const ids = JSON.stringify(first.json.data.components);
		expect(ids).toContain(`g:approve:${c1}:q`);
		expect(ids).toContain(`g:nx:${c1}:q`);
		expect(ids).toContain(`g:banr:${c1}:q`);
		const next = await send(await component(asMod, `g:nx:${c1}:q`));
		expect(JSON.stringify(next.json.data.components)).toContain(`${c2}`);
		// An action from the queue re-renders the queue card with doneBy.
		const act = await send(await component(asMod, `g:approve:${c2}:q`));
		expect(act.json.type).toBe(7);
		expect(JSON.stringify(act.json.data.embeds)).toContain("Approved by ModDisplay");
		const end = await send(await component(asMod, `g:nx:${c2}:q`));
		expect(end.json.type).toBe(7);
		expect(end.json.data.content).toBe("Queue is empty 🎉");
		expect(end.json.data.components).toEqual([]);
	});
});
