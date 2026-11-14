/**
 * Shared operator-bot actions, role table, ban guard, ban state and readouts
 * against REAL SQLite (every migration applied). fireWebhook is mocked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/webhook", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/webhook")>()),
	fireWebhook: vi.fn(),
}));

import { getUser } from "../src/db/queries";
import type { User } from "../src/db/queries";
import type { Bindings } from "../src/index";
import {
	banState,
	guardBanTarget,
	hasRole,
	requiredRole,
	runOpAction,
	unbanUser,
} from "../src/lib/opbot/actions";
import { buttonsFor } from "../src/lib/opbot/cards";
import type { OpActor } from "../src/lib/opbot/identity";
import {
	collectDigest,
	readComment,
	readQueue,
	readStats,
	readUser,
	relativeAge,
} from "../src/lib/opbot/readouts";
import { makeD1, makeKv } from "./helpers/admin-sqlite";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const setup = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
	}
	const addUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, 'github', ?, ?, ?, ?, 1)`,
	);
	addUser.run("adm", "1", "Ada", 1, "admin");
	addUser.run("mod", "2", "Mo", 0, "mod");
	addUser.run("plain", "3", "Plain", 0, "user");
	addUser.run("mod2", "4", "Mo Two", 0, "mod");
	sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)").run();
	const addComment = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, ip_hash, user_agent, created_at, depth)
		 VALUES (?, 'p', NULL, ?, 'hello', '<p>hello</p>', 1, ?, NULL, NULL, ?, 1)`,
	);
	addComment.run("c1", "plain", "pending", 100);
	addComment.run("c2", "mod2", "approved", 200);
	sqlite
		.prepare(
			"INSERT INTO reports (id, comment_id, reporter_user_id, reason, status, created_at) VALUES ('r1','c1','mod','spammy','open',5)",
		)
		.run();
	const SESSIONS = makeKv();
	const env = { DB: makeD1(sqlite), SESSIONS, TREE_CACHE: makeKv() } as unknown as Bindings;
	return { sqlite, env, SESSIONS };
};

const actorOf = async (env: Bindings, id: string, role: "mod" | "admin", viaRole: boolean) =>
	({ user: (await getUser(env.DB, id)) as User, role, adminViaDiscordRole: viaRole }) as OpActor;

const audits = (sqlite: DatabaseSync, action: string) =>
	sqlite.prepare("SELECT * FROM audit_log WHERE action = ?").all(action);

describe("role table", () => {
	it("admin for ban/banr/bsub/unban, mod otherwise", () => {
		for (const a of ["ban", "banr", "bsub", "unban"] as const) expect(requiredRole(a)).toBe("admin");
		for (const a of ["approve", "spam", "delete", "restore", "resolve", "reply", "sr", "rc", "pick", "rsub", "rv", "nx"] as const)
			expect(requiredRole(a)).toBe("mod");
	});
	it("admin satisfies mod, not vice versa", async () => {
		const { env } = setup();
		const mod = await actorOf(env, "mod", "mod", false);
		const adm = await actorOf(env, "adm", "admin", false);
		expect(hasRole(adm, "mod")).toBe(true);
		expect(hasRole(mod, "admin")).toBe(false);
	});
});

describe("runOpAction", () => {
	it("moderation actions change status and return doneBy + reported", async () => {
		const { env, sqlite } = setup();
		const actor = await actorOf(env, "mod", "mod", false);
		const res = await runOpAction({ env, executionCtx: undefined, actor, action: "approve", commentId: "c1" });
		expect(res).toEqual({ ok: true, status: "approved", doneBy: "Approved by Mo", reported: true });
		expect(audits(sqlite, "approve")).toHaveLength(1);
		if (res.ok) {
			const first = buttonsFor(res.status, { reported: res.reported })[0];
			expect(first?.some((b) => b.action === "spam")).toBe(true);
		}
		const spam = await runOpAction({ env, executionCtx: undefined, actor, action: "spam", commentId: "c1" });
		expect(spam).toMatchObject({ ok: true, status: "spam", doneBy: "Marked spam by Mo" });
		const restore = await runOpAction({ env, executionCtx: undefined, actor, action: "restore", commentId: "c1" });
		expect(restore).toMatchObject({ ok: true, status: "approved", doneBy: "Restored by Mo" });
		const del = await runOpAction({ env, executionCtx: undefined, actor, action: "delete", commentId: "c1" });
		expect(del).toMatchObject({ ok: true, status: "deleted", doneBy: "Deleted by Mo" });
	});

	it("resolve closes reports and reports reported=false", async () => {
		const { env, sqlite } = setup();
		const actor = await actorOf(env, "mod", "mod", false);
		const res = await runOpAction({ env, executionCtx: undefined, actor, action: "resolve", commentId: "c1" });
		expect(res).toMatchObject({ ok: true, doneBy: "Reports resolved by Mo", reported: false, status: "pending" });
		expect(audits(sqlite, "report.resolve")).toHaveLength(1);
	});

	it("missing comment", async () => {
		const { env } = setup();
		const actor = await actorOf(env, "adm", "admin", false);
		for (const action of ["approve", "resolve", "ban"] as const) {
			expect(await runOpAction({ env, executionCtx: undefined, actor, action, commentId: "nope" })).toEqual({
				ok: false,
				error: "comment_not_found",
			});
		}
	});

	it("mod cannot ban", async () => {
		const { env } = setup();
		const actor = await actorOf(env, "mod", "mod", false);
		expect(await runOpAction({ env, executionCtx: undefined, actor, action: "ban", commentId: "c1" })).toEqual({
			ok: false,
			error: "not_authorized",
		});
	});

	it("ban writes reason + from_comment audit and revokes sessions", async () => {
		const { env, sqlite, SESSIONS } = setup();
		const actor = await actorOf(env, "adm", "admin", false);
		const res = await runOpAction({ env, executionCtx: undefined, actor, action: "ban", commentId: "c1", reason: "abuse" });
		expect(res).toMatchObject({ ok: true, doneBy: "Banned by Ada" });
		const row = audits(sqlite, "ban")[0] as { reason: string; meta: string };
		expect(row.reason).toBe("abuse");
		expect(JSON.parse(row.meta)).toEqual({ from_comment: "c1" });
		expect([...SESSIONS.store.keys()]).toContain("sessrev:plain");
		expect((await getUser(env.DB, "plain"))?.is_banned).toBe(true);
	});

	it("staff guard: role-derived admin blocked, real admin succeeds", async () => {
		const { env, sqlite } = setup();
		const viaRole = await actorOf(env, "mod", "admin", true);
		expect(await runOpAction({ env, executionCtx: undefined, actor: viaRole, action: "ban", commentId: "c2" })).toEqual({
			ok: false,
			error: "target_is_staff",
		});
		expect(audits(sqlite, "ban")).toHaveLength(0);
		const real = await actorOf(env, "adm", "admin", false);
		expect(await runOpAction({ env, executionCtx: undefined, actor: real, action: "ban", commentId: "c2" })).toMatchObject({ ok: true });
		expect(audits(sqlite, "ban")).toHaveLength(1);
	});

	it("guardBanTarget", async () => {
		const { env } = setup();
		const viaRole = await actorOf(env, "mod", "admin", true);
		const real = await actorOf(env, "adm", "admin", false);
		const staff = (await getUser(env.DB, "mod2")) as User;
		const plain = (await getUser(env.DB, "plain")) as User;
		expect(guardBanTarget(viaRole, staff)).toBe(false);
		expect(guardBanTarget(viaRole, plain)).toBe(true);
		expect(guardBanTarget(real, staff)).toBe(true);
	});
});

describe("unbanUser", () => {
	it("unbans, guards staff, refuses non-admin, reports not_found", async () => {
		const { env, sqlite } = setup();
		const real = await actorOf(env, "adm", "admin", false);
		await runOpAction({ env, executionCtx: undefined, actor: real, action: "ban", commentId: "c1" });
		expect(await unbanUser({ env, actor: real, userId: "plain" })).toEqual({ ok: true });
		expect(audits(sqlite, "unban")).toHaveLength(1);
		expect(await unbanUser({ env, actor: real, userId: "ghost" })).toEqual({ ok: false, error: "not_found" });
		const viaRole = await actorOf(env, "mod", "admin", true);
		expect(await unbanUser({ env, actor: viaRole, userId: "mod2" })).toEqual({ ok: false, error: "target_is_staff" });
		const mod = await actorOf(env, "mod", "mod", false);
		expect(await unbanUser({ env, actor: mod, userId: "plain" })).toEqual({ ok: false, error: "not_authorized" });
	});
});

describe("banState", () => {
	it("covers banned+row, banned+no row, not banned, and latest-wins", async () => {
		const { env, sqlite } = setup();
		const real = await actorOf(env, "adm", "admin", false);
		expect(await banState(env.DB, (await getUser(env.DB, "plain")) as User)).toEqual({ banned: false });
		sqlite.prepare("UPDATE users SET is_banned = 1 WHERE id = 'mod2'").run();
		expect(await banState(env.DB, (await getUser(env.DB, "mod2")) as User)).toEqual({
			banned: true,
			reason: null,
			purged: true,
		});
		await runOpAction({ env, executionCtx: undefined, actor: real, action: "ban", commentId: "c1", reason: "abuse" });
		expect(await banState(env.DB, (await getUser(env.DB, "plain")) as User)).toEqual({
			banned: true,
			reason: "abuse",
			purged: false,
		});
	});

	it("keeps the ban reason after more unrelated audit rows than any fixed window", async () => {
		const { env, sqlite } = setup();
		const real = await actorOf(env, "adm", "admin", false);
		await runOpAction({ env, executionCtx: undefined, actor: real, action: "ban", commentId: "c1", reason: "abuse" });
		const add = sqlite.prepare(
			`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id, created_at)
			 VALUES (?, 'adm', 'note', 'user', 'plain', ?)`,
		);
		for (let n = 0; n < 60; n++) add.run(`zz-note-${n}`, 9_000_000_000_000 + n);
		expect(await banState(env.DB, (await getUser(env.DB, "plain")) as User)).toEqual({
			banned: true,
			reason: "abuse",
			purged: false,
		});
	});
});

describe("readouts", () => {
	it("readQueue / readStats / readComment / readUser / collectDigest", async () => {
		const { env } = setup();
		const q = await readQueue(env);
		expect(q).toMatchObject({ pending: 1, reported: 1, spam: 0, topFlagged: { slug: "p", count: 1 } });
		expect(q.oldest?.id).toBe("c1");
		expect(await readStats(env)).toMatchObject({ totalComments: 2, pending: 1, totalUsers: 4, banned: 0 });
		const c = await readComment(env, "c1");
		expect(c).toMatchObject({ authorName: "Plain", openReports: 1 });
		expect(await readComment(env, "zzz")).toBeNull();
		expect((await readUser(env, "plain"))?.ban).toEqual({ banned: false });
		expect(await readUser(env, "zzz")).toBeNull();
		const d = await collectDigest(env, 100 + 3 * 3600_000);
		expect(d).toMatchObject({ pending: 1, openReports: 1, banned: 0, oldestAgeMs: 3 * 3600_000 });
	});
	it("relativeAge", () => {
		expect(relativeAge(0, 5 * 60000)).toBe("5m");
		expect(relativeAge(0, 3 * 3600000)).toBe("3h");
		expect(relativeAge(0, 2 * 86400000)).toBe("2d");
	});
});
