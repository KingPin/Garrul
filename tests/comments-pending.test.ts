/**
 * GET /api/v1/comments — own-pending visibility.
 *
 * A logged-in author sees their own `pending` (in-moderation) comments merged
 * into the thread so they get a visible confirmation; nobody else does. This
 * is an authZ contract: pending content must never leak to other users or to
 * anonymous viewers.
 *
 * No Miniflare: a hand-rolled D1 stub routes by SQL substring and scopes the
 * own-pending query by its bound user_id, an in-memory KV double backs
 * settings, and a mock `caches.default` covers the anonymous first-page edge
 * cache. Sessions are simulated via a SESSIONS KV double + cookie.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { comments } from "../src/routes/api.comments";
import {
	installMockCaches,
	uninstallMockCaches,
	type MockCache,
} from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

let mockCache: MockCache;
beforeEach(() => {
	mockCache = installMockCaches();
});
afterEach(() => uninstallMockCaches());

const AUTHOR = "01HU000000000000000000";
const OTHER = "01HU000000000000000001";
// 64-hex session ids (SESSION_ID_RE) for each user.
const SID_AUTHOR = "a".repeat(64);
const SID_OTHER = "b".repeat(64);

type Row = {
	id: string;
	post_slug: string;
	parent_id: string | null;
	user_id: string;
	body_md: string;
	body_html: string;
	renderer_version: number;
	status: string;
	edited_at: number | null;
	deleted_at: number | null;
	deleted_by: string | null;
	ip_hash: string | null;
	user_agent: string | null;
	created_at: number;
	score_up: number;
	score_down: number;
};

const mkRow = (id: string, user_id: string, status: string, at: number): Row => ({
	id,
	post_slug: "hello",
	parent_id: null,
	user_id,
	body_md: id,
	body_html: `<p>${id}</p>`,
	renderer_version: 1,
	status,
	edited_at: null,
	deleted_at: null,
	deleted_by: null,
	ip_hash: null,
	user_agent: null,
	created_at: at,
	score_up: 0,
	score_down: 0,
});

const userRow = (id: string) => ({
	id,
	provider: "anon",
	provider_id: null,
	name: id,
	email: null,
	avatar_url: null,
	is_admin: 0,
	is_banned: 0,
	role: "user",
	created_at: 1_700_000_000_000,
});

// D1 double. `approved` feeds the public list query; `pending` feeds the
// own-pending query but is filtered by the bound user_id so the stub enforces
// the same scoping the real SQL does.
const makeDb = (approved: Row[], pending: Row[]) => {
	const chain = (sql: string) => {
		let boundArgs: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				boundArgs = args;
				return this;
			},
			all: async () => {
				if (sql.includes("key, value FROM settings")) return { results: [] };
				if (
					sql.includes("FROM comments") &&
					sql.includes("status = 'pending'")
				) {
					const uid = boundArgs[1];
					return { results: pending.filter((r) => r.user_id === uid) };
				}
				if (sql.includes("FROM comments") && sql.includes("status NOT IN")) {
					// Fresh array per call: the handler mutates `rows` via push().
					return { results: [...approved] };
				}
				if (sql.includes("FROM users WHERE id IN")) {
					const ids = new Set([...approved, ...pending].map((r) => r.user_id));
					return { results: [...ids].map(userRow) };
				}
				return { results: [] };
			},
			first: async () => {
				if (sql.includes("FROM posts WHERE slug")) {
					return { slug: "hello", title: "Hello", url: null, created_at: 1 };
				}
				return null;
			},
		};
	};
	return { prepare: (sql: string) => chain(sql) };
};

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

// SESSIONS double mapping each session id to its user. Far-future expiry so
// readSession's sliding-TTL refresh never rewrites.
const makeSessions = () => {
	const map: Record<string, string> = {
		[`sess:${SID_AUTHOR}`]: AUTHOR,
		[`sess:${SID_OTHER}`]: OTHER,
	};
	return {
		async get(key: string) {
			const uid = map[key];
			if (!uid) return null;
			return JSON.stringify({
				user_id: uid,
				expires_at: 4_102_444_800_000, // year 2100
			});
		},
		async put() {},
		async delete() {},
	};
};

const mkEnv = (approved: Row[], pending: Row[]) =>
	({
		DB: makeDb(approved, pending),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	}) as unknown as Bindings;

type ListResp = { threads: { id: string; status: string }[] };

const get = async (env: Bindings, cookie?: string): Promise<ListResp> => {
	const app = new Hono<{ Bindings: Bindings }>().route("/", comments);
	const headers = cookie ? { cookie } : undefined;
	const res = await app.request(
		"/?slug=hello",
		headers ? { headers } : {},
		env as unknown as Record<string, unknown>,
	);
	expect(res.status).toBe(200);
	return (await res.json()) as ListResp;
};

describe("GET /comments — own pending visibility", () => {
	const approved = [mkRow("01HUAPPROVED0000000000", OTHER, "approved", 1000)];
	const pending = [mkRow("01HUPENDING00000000000", AUTHOR, "pending", 2000)];

	it("shows the author their own pending comment", async () => {
		const env = mkEnv(approved, pending);
		const page = await get(env, `garrul_sess=${SID_AUTHOR}`);
		const ids = page.threads.map((t) => t.id);
		expect(ids).toContain("01HUPENDING00000000000");
		const node = page.threads.find((t) => t.id === "01HUPENDING00000000000");
		expect(node!.status).toBe("pending");
	});

	it("does NOT show a pending comment to a different signed-in user", async () => {
		const env = mkEnv(approved, pending);
		const page = await get(env, `garrul_sess=${SID_OTHER}`);
		const ids = page.threads.map((t) => t.id);
		expect(ids).not.toContain("01HUPENDING00000000000");
	});

	it("does NOT show a pending comment to anonymous viewers", async () => {
		const env = mkEnv(approved, pending);
		const page = await get(env);
		const ids = page.threads.map((t) => t.id);
		expect(ids).not.toContain("01HUPENDING00000000000");
		expect(ids).toContain("01HUAPPROVED0000000000");
	});
});
