/**
 * The shared inactive-user gate, against REAL SQLite (every migration applied).
 *
 * Before this existed `is_banned` was consulted in four places, so a banned
 * user's cookie still worked for comment edit/delete, votes, reactions, reports,
 * page engagement and subscribe. These cover the two entry points every one of
 * those routes now goes through, plus the ban → session-revocation wiring.
 *
 * "Inactive" is banned *or* erased: both revoke sessions through KV, so both
 * need the D1 read to cover the propagation window.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	isInactiveGhost,
	requireActiveUser,
	resolveActor,
} from "../src/lib/active-user";
import { banUser } from "../src/lib/moderation";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				return this;
			},
			async run() {
				const r = stmt.run(...(bound as never[]));
				return { success: true, meta: { changes: r.changes } };
			},
			async first() {
				return stmt.get(...(bound as never[])) ?? null;
			},
			async all() {
				return { results: stmt.all(...(bound as never[])) };
			},
		};
	},
});

class StubKV {
	store = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}
	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}

const ADMIN_ID = "01HADMIN0000000000000000AB";
const ACTIVE_ID = "01HACTIVE000000000000000AC";
const BANNED_ID = "01HBANNED000000000000000BN";
const ERASED_ID = "01HERASED000000000000000ER";
const ACTIVE_SID = "a".repeat(64);
const BANNED_SID = "b".repeat(64);
const ERASED_SID = "e".repeat(64);
const IP_HASH = "f".repeat(64);

let sqlite: DatabaseSync;
let kv: StubKV;
let env: Bindings;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const seed = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, is_banned, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	seed.run(ADMIN_ID, "github", "1", "Op", 1, "admin", 0, 1_700_000_000_000);
	seed.run(ACTIVE_ID, "github", "2", "Reader", 0, "user", 0, 1_700_000_000_000);
	seed.run(BANNED_ID, "github", "3", "Spammer", 0, "user", 1, 1_700_000_000_000);
	// Erased, not banned: `eraseUserData` empties the identity and stamps
	// erased_at, and leaves is_banned alone.
	seed.run(ERASED_ID, "github", null, "[del]", 0, "user", 0, 1_700_000_000_000);
	sqlite
		.prepare("UPDATE users SET erased_at = ? WHERE id = ?")
		.run(1_700_000_001_000, ERASED_ID);

	kv = new StubKV();
	// Both sessions are live and unrevoked: the point of these tests is the D1
	// layer, which has to hold even while the KV stamp is still propagating.
	const far = 4_102_444_800_000;
	kv.store.set(
		`sess:${ACTIVE_SID}`,
		JSON.stringify({ user_id: ACTIVE_ID, issued_at: 1, expires_at: far }),
	);
	kv.store.set(
		`sess:${BANNED_SID}`,
		JSON.stringify({ user_id: BANNED_ID, issued_at: 1, expires_at: far }),
	);
	kv.store.set(
		`sess:${ERASED_SID}`,
		JSON.stringify({ user_id: ERASED_ID, issued_at: 1, expires_at: far }),
	);

	env = {
		DB: makeD1(sqlite),
		SESSIONS: kv,
		ENV: "prod",
	} as unknown as Bindings;
});

/**
 * Seed the ghost row for IP_HASH in a chosen state.
 *
 * Written directly rather than through `getOrCreateGhost` + an UPDATE because
 * the erased case has to be constructed: `eraseUserData` nulls `provider_id`,
 * so erasing a ghost the production way orphans it rather than leaving an
 * erased one behind.
 */
const makeGhost = (opts: { banned: boolean; erasedAt: number | null }): void => {
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role,
			                    is_banned, created_at, erased_at)
			 VALUES (?, 'anon', ?, 'anon', 0, 'user', ?, ?, ?)`,
		)
		.run(
			"01HGHOST0000000000000000GH",
			IP_HASH,
			opts.banned ? 1 : 0,
			1_700_000_000_000,
			opts.erasedAt,
		);
};

const makeCtx = (sid: string | null): any => ({
	env,
	req: {
		header: (name: string) =>
			name.toLowerCase() === "cookie" && sid
				? `__Host-garrul_sess=${sid}`
				: undefined,
	},
	header: () => {},
});

describe("requireActiveUser", () => {
	it("returns the user when they exist and are not banned", async () => {
		const user = await requireActiveUser(env.DB, ACTIVE_ID);
		expect(user?.id).toBe(ACTIVE_ID);
	});

	it("returns null for a banned user", async () => {
		expect(await requireActiveUser(env.DB, BANNED_ID)).toBeNull();
	});

	it("returns null for an erased user", async () => {
		// `eraseUser` revokes their sessions, but that stamp is KV and takes up to
		// a minute to propagate. Without this the window let a live cookie keep
		// writing as an identity that is now a placeholder.
		expect(await requireActiveUser(env.DB, ERASED_ID)).toBeNull();
	});

	it("returns null for an id with no row", async () => {
		// A session outliving its user row would otherwise attribute writes to a
		// dangling id and trip the FK.
		expect(
			await requireActiveUser(env.DB, "01HGONE00000000000000GONE0"),
		).toBeNull();
	});
});

describe("resolveActor", () => {
	it("attributes an active session to its user", async () => {
		const actor = await resolveActor(makeCtx(ACTIVE_SID), IP_HASH);
		expect(actor).toEqual({ ok: true, userId: ACTIVE_ID });
	});

	it("rejects a banned session instead of downgrading it to a ghost", async () => {
		const actor = await resolveActor(makeCtx(BANNED_SID), IP_HASH);
		expect(actor.ok).toBe(false);
		// Falling back would hand them the anonymous budget — so no ghost row
		// should have been created either.
		const ghosts = sqlite
			.prepare(
				"SELECT COUNT(*) AS n FROM users WHERE provider = 'anon' AND provider_id = ?",
			)
			.get(IP_HASH) as { n: number };
		expect(ghosts.n).toBe(0);
	});

	it("rejects an erased session instead of downgrading it to a ghost", async () => {
		const actor = await resolveActor(makeCtx(ERASED_SID), IP_HASH);
		expect(actor.ok).toBe(false);
		const ghosts = sqlite
			.prepare(
				"SELECT COUNT(*) AS n FROM users WHERE provider = 'anon' AND provider_id = ?",
			)
			.get(IP_HASH) as { n: number };
		expect(ghosts.n).toBe(0);
	});

	it("falls back to the ip_hash ghost when there is no session", async () => {
		const first = await resolveActor(makeCtx(null), IP_HASH);
		expect(first.ok).toBe(true);
		// Same IP twice ⇒ same identity, so a repeat click toggles the same row.
		const second = await resolveActor(makeCtx(null), IP_HASH);
		expect(second).toEqual(first);
	});

	it("rejects an anonymous caller whose ip_hash ghost is banned", async () => {
		// An operator banning an abusive anonymous author from the queue bans a
		// ghost row. Without the check the ban reached comment POST and nothing
		// else, so votes/reactions/page engagement stayed open to them.
		const first = await resolveActor(makeCtx(null), IP_HASH);
		expect(first.ok).toBe(true);
		sqlite
			.prepare("UPDATE users SET is_banned = 1 WHERE provider_id = ?")
			.run(IP_HASH);
		expect((await resolveActor(makeCtx(null), IP_HASH)).ok).toBe(false);
	});

	it("rejects an anonymous caller whose ip_hash ghost is erased", async () => {
		// Erased-not-banned, built by hand: the production erase path nulls
		// provider_id, which orphans the ghost and makes this state unreachable
		// through it. That is a property of the erase statement, so this pins the
		// gate independently of it — if `eraseUserData` ever keeps provider_id,
		// the erased row becomes reachable and this is already covered.
		makeGhost({ banned: false, erasedAt: 1_700_000_002_000 });
		expect((await resolveActor(makeCtx(null), IP_HASH)).ok).toBe(false);
	});

	it("treats an unknown cookie as anonymous", async () => {
		const actor = await resolveActor(makeCtx("c".repeat(64)), IP_HASH);
		expect(actor.ok).toBe(true);
	});
});

describe("isInactiveGhost", () => {
	it("is false for an ip_hash that has never posted", async () => {
		// No row means nothing to refuse — and, just as importantly, no row is
		// created by asking. Reporting calls this on an unauthenticated path.
		expect(await isInactiveGhost(env.DB, IP_HASH)).toBe(false);
		const ghosts = sqlite
			.prepare(
				"SELECT COUNT(*) AS n FROM users WHERE provider = 'anon' AND provider_id = ?",
			)
			.get(IP_HASH) as { n: number };
		expect(ghosts.n).toBe(0);
	});

	it("is false for an active ghost", async () => {
		// The baseline that keeps the two assertions below from being vacuous.
		makeGhost({ banned: false, erasedAt: null });
		expect(await isInactiveGhost(env.DB, IP_HASH)).toBe(false);
	});

	it("is true for a banned ghost", async () => {
		makeGhost({ banned: true, erasedAt: null });
		expect(await isInactiveGhost(env.DB, IP_HASH)).toBe(true);
	});

	it("is true for an erased ghost", async () => {
		makeGhost({ banned: false, erasedAt: 1_700_000_002_000 });
		expect(await isInactiveGhost(env.DB, IP_HASH)).toBe(true);
	});
});

describe("banUser session revocation", () => {
	const stamp = (): string | undefined => kv.store.get(`sessrev:${BANNED_ID}`);

	it("stamps the revocation epoch on ban", async () => {
		const res = await banUser({
			env,
			adminId: ADMIN_ID,
			userId: BANNED_ID,
			banned: true,
		});
		expect(res.ok).toBe(true);
		expect(Number(stamp())).toBeGreaterThan(0);
	});

	it("does not clear the stamp on unban", async () => {
		await banUser({ env, adminId: ADMIN_ID, userId: BANNED_ID, banned: true });
		const before = stamp();
		await banUser({ env, adminId: ADMIN_ID, userId: BANNED_ID, banned: false });
		// The stamp stays a cutoff: cookies minted before the ban must not come
		// back to life. A fresh login gets a newer issued_at and is unaffected.
		expect(stamp()).toBe(before);
	});

	it("writes no stamp for a user that does not exist", async () => {
		const res = await banUser({
			env,
			adminId: ADMIN_ID,
			userId: "01HGONE00000000000000GONE0",
			banned: true,
		});
		expect(res).toEqual({ ok: false, error: "not_found" });
		expect(kv.store.size).toBe(3); // the three seeded sessions, nothing more
	});

	it("makes the banned user's live session record inert", async () => {
		// The D1 layer alone already rejects them — that's what covers the ~60s
		// while the KV stamp propagates.
		expect((await resolveActor(makeCtx(BANNED_SID), IP_HASH)).ok).toBe(false);
		expect(kv.store.has(`sess:${BANNED_SID}`)).toBe(true);

		await banUser({ env, adminId: ADMIN_ID, userId: BANNED_ID, banned: true });

		// Now the stamp purges the record on first read, so the retained cookie is
		// plain anonymous rather than attributed to the banned account — and it
		// stays that way after an unban, since the stamp is a permanent cutoff.
		const actor = await resolveActor(makeCtx(BANNED_SID), IP_HASH);
		expect(actor.ok).toBe(true);
		expect(actor.ok && actor.userId).not.toBe(BANNED_ID);
		expect(kv.store.has(`sess:${BANNED_SID}`)).toBe(false);
	});
});
