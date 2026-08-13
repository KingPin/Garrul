/**
 * GET/DELETE /api/v1/subscribe/mine — the signed-in reader's own subscriptions.
 *
 * Two invariants carry this surface, and both are the kind that fail silently:
 *
 *   1. **Address scoping.** The session's address is the only key. A reader
 *      must never see or cancel a row belonging to another address, and the
 *      denial must be a 404 — a 403 confirms the id exists, which turns a ULID
 *      guess into an existence oracle over other readers' subscriptions.
 *   2. **The gate is `user.email != null`, not `PROVIDER_VERIFIED`.** Those two
 *      sets are easy to confuse and the failure is invisible: gating on the
 *      narrower one still works perfectly for the maintainer (github) while
 *      silently refusing every Facebook and Discord reader any way to
 *      unsubscribe. The facebook/discord cases below exist to fail loudly if
 *      anyone reaches for `PROVIDER_VERIFIED` here.
 *
 * A reader with no address at all (anonymous ghost, X/Twitter — whose v2 API
 * exposes no email under our scopes) is signed in but owns nothing: an empty
 * list, not a 500 and not a 401.
 *
 * Real SQLite + the mock Cache API (the rate limiter's backend), same harness
 * as subscriptions-session-email.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { subscriptions } from "../src/routes/api.subscriptions";
import { makeKv } from "./helpers/kv";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
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

// Session IDs are validated against /^[0-9a-f]{64}$/ before KV is touched, so a
// readable label would be rejected as malformed and read as anonymous — which
// would make every case below pass for the wrong reason.
const sid = (n: string) => n.repeat(64).slice(0, 64);

const GH_SID = sid("a");
const GH_EMAIL = "reader@example.com";
const FB_SID = sid("b");
const FB_EMAIL = "fb@example.com";
const DC_SID = sid("c");
const DC_EMAIL = "discord@example.com";
const TW_SID = sid("d");
const GHOST_SID = sid("e");
const BANNED_SID = sid("f");

const T0 = 1_700_000_000_000;

let sqlite: DatabaseSync;
let env: Bindings;

const addSub = (
	id: string,
	slug: string,
	email: string,
	opts: { at?: number; confirmed?: boolean; cancelled?: boolean } = {},
): void => {
	sqlite
		.prepare(
			`INSERT INTO subscriptions
			   (id, post_slug, email, token, confirm_token, confirmed_at,
			    created_at, unsubscribed_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
		)
		.run(
			id,
			slug,
			email,
			`${id}-token`,
			opts.confirmed === false ? null : T0,
			opts.at ?? T0,
			opts.cancelled ? T0 : null,
		);
};

const cancelledAt = (id: string): number | null | undefined =>
	(
		sqlite
			.prepare("SELECT unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(id) as { unsubscribed_at: number | null } | undefined
	)?.unsubscribed_at;

beforeEach(async () => {
	installMockCaches();

	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}

	const post = sqlite.prepare(
		"INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)",
	);
	for (const slug of ["alpha", "beta", "gamma", "delta"]) {
		post.run(slug, slug[0]?.toUpperCase() + slug.slice(1), null, T0);
	}

	const seed = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, is_admin, is_banned, created_at)
		 VALUES (?, ?, ?, ?, ?, 0, ?, 1700000000000)`,
	);
	seed.run("u-gh", "github", "1", "Reader", GH_EMAIL, 0);
	// Outside PROVIDER_VERIFIED, but the provider still vouched for the address.
	seed.run("u-fb", "facebook", "2", "Fbook", FB_EMAIL, 0);
	seed.run("u-dc", "discord", "3", "Disco", DC_EMAIL, 0);
	// X/Twitter's OAuth 2.0 exposes no email under our scopes, so the column is
	// genuinely null for these accounts — not an oversight in the fixture.
	seed.run("u-tw", "twitter", "4", "Birdsite", null, 0);
	seed.run("u-ghost", "anon", null, "Ghost", null, 0);
	seed.run("u-banned", "github", "5", "Spammer", "spam@example.com", 1);

	addSub("s-gh-1", "alpha", GH_EMAIL, { at: T0 + 1 });
	addSub("s-gh-2", "beta", GH_EMAIL, { at: T0 + 2, confirmed: false });
	addSub("s-gh-3", "gamma", GH_EMAIL, { at: T0 + 3, cancelled: true });
	// Distinct timestamps: the list is ordered by created_at, so a tie would
	// make the ordering assertion depend on SQLite's row order.
	addSub("s-fb-1", "alpha", FB_EMAIL, { at: T0 + 2 });
	addSub("s-fb-2", "delta", FB_EMAIL, { at: T0 + 1 });
	addSub("s-dc-1", "beta", DC_EMAIL);

	const sessions = makeKv();
	const far = 4_102_444_800_000;
	for (const [s, uid] of [
		[GH_SID, "u-gh"],
		[FB_SID, "u-fb"],
		[DC_SID, "u-dc"],
		[TW_SID, "u-tw"],
		[GHOST_SID, "u-ghost"],
		[BANNED_SID, "u-banned"],
	]) {
		await sessions.put(
			`sess:${s}`,
			JSON.stringify({ user_id: uid, issued_at: 1, expires_at: far }),
		);
	}

	env = {
		DB: makeD1(sqlite),
		SESSIONS: sessions,
		TREE_CACHE: makeKv(),
		// "dev" also selects the unprefixed cookie name the requests below send.
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		PUBLIC_BASE_URL: "https://comments.example",
	} as unknown as Bindings;
});

afterEach(() => {
	uninstallMockCaches();
});

const call = async (
	path: string,
	opts: { method?: string; sid?: string } = {},
): Promise<Response> =>
	await new Hono<{ Bindings: Bindings }>().route("/", subscriptions).request(
		path,
		{
			method: opts.method ?? "GET",
			headers: {
				"cf-connecting-ip": "203.0.113.1",
				...(opts.sid ? { cookie: `garrul_sess=${opts.sid}` } : {}),
			},
		},
		env as unknown as Record<string, unknown>,
	);

type ListBody = { subscriptions: { id: string; title: string | null }[] };
type BellBody = { subscribed: boolean; pending: boolean; id: string | null };

describe("GET /subscribe/mine — the list", () => {
	it("refuses an anonymous caller without disclosing anything", async () => {
		const res = await call("/mine");
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain(GH_EMAIL);
	});

	it("refuses a banned session with 403, as POST /subscribe does", async () => {
		expect((await call("/mine", { sid: BANNED_SID })).status).toBe(403);
	});

	it("returns this address's active rows, newest first", async () => {
		const res = await call("/mine", { sid: GH_SID });
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListBody;
		// s-gh-3 is cancelled; s-fb-* and s-dc-1 belong to other addresses.
		expect(body.subscriptions.map((s) => s.id)).toEqual(["s-gh-2", "s-gh-1"]);
		expect(body.subscriptions.map((s) => s.title)).toEqual(["Beta", "Alpha"]);
	});

	it("lists an un-confirmed row too", async () => {
		// s-gh-2 has confirmed_at = NULL. It is a real row the reader created, it
		// occupies the per-address pending cap, and a subscription you cannot see
		// is one you cannot cancel.
		const body = (await (
			await call("/mine", { sid: GH_SID })
		).json()) as ListBody;
		expect(body.subscriptions.map((s) => s.id)).toContain("s-gh-2");
	});

	it("serves a facebook reader — the PROVIDER_VERIFIED regression", async () => {
		// facebook is outside PROVIDER_VERIFIED. Gating this endpoint on that set
		// instead of `user.email != null` returns an empty list here while every
		// github/google reader keeps working, so the bug ships invisibly.
		const body = (await (
			await call("/mine", { sid: FB_SID })
		).json()) as ListBody;
		expect(body.subscriptions.map((s) => s.id)).toEqual(["s-fb-1", "s-fb-2"]);
	});

	it("serves a discord reader for the same reason", async () => {
		const body = (await (
			await call("/mine", { sid: DC_SID })
		).json()) as ListBody;
		expect(body.subscriptions.map((s) => s.id)).toEqual(["s-dc-1"]);
	});

	it("is empty, not an error, for an X/Twitter session with no address", async () => {
		const res = await call("/mine", { sid: TW_SID });
		expect(res.status).toBe(200);
		expect((await res.json()) as ListBody).toEqual({ subscriptions: [] });
	});

	it("is empty, not an error, for an anonymous ghost", async () => {
		const res = await call("/mine", { sid: GHOST_SID });
		expect(res.status).toBe(200);
		expect((await res.json()) as ListBody).toEqual({ subscriptions: [] });
	});
});

describe("GET /subscribe/mine?post_slug= — the bell", () => {
	const bell = async (slug: string, s: string): Promise<BellBody> =>
		(await (await call(`/mine?post_slug=${slug}`, { sid: s })).json()) as BellBody;

	it("is lit and settled for a confirmed row", async () => {
		expect(await bell("alpha", GH_SID)).toEqual({
			subscribed: true,
			pending: false,
			id: "s-gh-1",
		});
	});

	it("is lit and pending for an un-confirmed row", async () => {
		// The distinction the widget needs: without `pending` the bell either
		// lies (lit, but no mail will ever arrive) or under-reports, and the
		// reader re-subscribes and burns another confirmation email.
		expect(await bell("beta", GH_SID)).toEqual({
			subscribed: true,
			pending: true,
			id: "s-gh-2",
		});
	});

	it("hands back an id DELETE /mine/:id accepts", async () => {
		// The whole reason the id is in this response: it is what makes the bell a
		// two-way toggle. If these two ever disagree the bell can light up and
		// then refuse to switch off.
		const { id } = await bell("alpha", GH_SID);
		const res = await call(`/mine/${id}`, { sid: GH_SID, method: "DELETE" });
		expect(res.status).toBe(200);
		expect(typeof cancelledAt("s-gh-1")).toBe("number");
	});

	it("is unlit for a cancelled row", async () => {
		expect(await bell("gamma", GH_SID)).toEqual({
			subscribed: false,
			pending: false,
			id: null,
		});
	});

	it("is unlit for a slug nobody at this address follows", async () => {
		// delta is followed by fb@example.com only.
		expect(await bell("delta", GH_SID)).toEqual({
			subscribed: false,
			pending: false,
			id: null,
		});
	});

	it("is unlit for a session with no address, not an error", async () => {
		const res = await call("/mine?post_slug=alpha", { sid: GHOST_SID });
		expect(res.status).toBe(200);
		expect((await res.json()) as BellBody).toEqual({
			subscribed: false,
			pending: false,
			id: null,
		});
	});

	it("still refuses an anonymous caller", async () => {
		expect((await call("/mine?post_slug=alpha")).status).toBe(401);
	});
});

describe("DELETE /subscribe/mine/:id", () => {
	const del = (id: string, s?: string) =>
		call(`/mine/${id}`, { method: "DELETE", ...(s ? { sid: s } : {}) });

	it("cancels a row the session owns", async () => {
		const res = await del("s-gh-1", GH_SID);
		expect(res.status).toBe(200);
		expect(cancelledAt("s-gh-1")).not.toBeNull();
	});

	it("answers 404 — not 403 — for another address's row, and writes nothing", async () => {
		// 403 would confirm the id exists, which is the whole oracle.
		const res = await del("s-fb-1", GH_SID);
		expect(res.status).toBe(404);
		expect(cancelledAt("s-fb-1")).toBeNull();
	});

	it("answers the same 404 for an id that does not exist", async () => {
		// Indistinguishable from the case above by design.
		expect((await del("s-nope", GH_SID)).status).toBe(404);
	});

	it("answers 404 for a session that has no address at all", async () => {
		const res = await del("s-gh-1", GHOST_SID);
		expect(res.status).toBe(404);
		expect(cancelledAt("s-gh-1")).toBeNull();
	});

	it("refuses an anonymous caller", async () => {
		const res = await del("s-gh-1");
		expect(res.status).toBe(401);
		expect(cancelledAt("s-gh-1")).toBeNull();
	});

	it("refuses a banned session", async () => {
		expect((await del("s-gh-1", BANNED_SID)).status).toBe(403);
	});

	it("is idempotent and does not move the original timestamp", async () => {
		// That timestamp is the record of when the reader actually asked to stop.
		const res = await del("s-gh-3", GH_SID);
		expect(res.status).toBe(200);
		expect(cancelledAt("s-gh-3")).toBe(T0);
	});

	it("lets a facebook reader cancel their own row", async () => {
		expect((await del("s-fb-1", FB_SID)).status).toBe(200);
		expect(cancelledAt("s-fb-1")).not.toBeNull();
	});
});
