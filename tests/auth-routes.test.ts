/**
 * Auth route hardening.
 *
 * Two things the route layer owes us that lib-level tests can't see:
 *
 * 1. `/session/exchange` must kill the session the browser already holds before
 *    minting a new one. The OAuth callback does; this route (the only one widget
 *    users take, because their session cookie has to land in the embedder's
 *    CHIPS partition) didn't — so "sign out everywhere by signing in again"
 *    silently left the old sid live and replayable in KV for 30 days.
 * 2. `/callback` must reject a malformed `state` before it reaches
 *    bindCookieName, whose output is interpolated into a Set-Cookie *name*.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { auth } from "../src/routes/auth";
import { issueHandoff } from "../src/lib/oauth";
import { issueSession, readSession } from "../src/lib/session";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
	};
};

const USER = "01HXXXXXXXXXXXXXXXXXXXXXXX";

let sessions: ReturnType<typeof makeKv>;
let oauthState: ReturnType<typeof makeKv>;
let env: Bindings;

beforeEach(() => {
	installMockCaches();
	sessions = makeKv();
	oauthState = makeKv();
	env = {
		SESSIONS: sessions,
		OAUTH_STATE: oauthState,
		JWT_SECRET: "test-jwt-secret",
		IP_HASH_SECRET: "test-ip-hash-secret",
		ENV: "prod",
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const IP = { "cf-connecting-ip": "203.0.113.7" };

const app = () => new Hono<{ Bindings: Bindings }>().route("/", auth);

/** Mint a real session the way the callback would, and return its sid. */
const seedSession = async (): Promise<string> => {
	let sid = "";
	const ctx = {
		env: env as unknown as { SESSIONS: KVNamespace; ENV: string },
		req: { header: () => undefined },
		header: (name: string, value: string) => {
			if (name.toLowerCase() === "set-cookie" && value.startsWith("__Host-")) {
				sid = value.split(";", 1)[0]!.split("=")[1]!;
			}
		},
	};
	await issueSession(ctx, USER);
	return sid;
};

describe("POST /session/exchange", () => {
	it("revokes the session already in the cookie", async () => {
		const oldSid = await seedSession();
		expect(sessions.store.has(`sess:${oldSid}`)).toBe(true);
		const token = await issueHandoff(
			oauthState as unknown as KVNamespace,
			USER,
		);

		const res = await app().request(
			"/session/exchange",
			{
				method: "POST",
				headers: {
					...IP,
					"content-type": "application/json",
					cookie: `__Host-garrul_sess=${oldSid}`,
				},
				body: JSON.stringify({ token }),
			},
			env as unknown as Record<string, unknown>,
		);

		expect(res.status).toBe(200);
		// Old record gone, and a different one issued in its place.
		expect(sessions.store.has(`sess:${oldSid}`)).toBe(false);
		const sids = [...sessions.store.keys()].filter((k) =>
			k.startsWith("sess:"),
		);
		expect(sids).toHaveLength(1);
		expect(sids[0]).not.toBe(`sess:${oldSid}`);
	});

	it("fails closed when revoking the old session throws: no new cookie", async () => {
		const oldSid = await seedSession();
		sessions.delete = async () => {
			throw new Error("KV delete cap");
		};
		const token = await issueHandoff(
			oauthState as unknown as KVNamespace,
			USER,
		);
		const res = await app().request(
			"/session/exchange",
			{
				method: "POST",
				headers: {
					...IP,
					"content-type": "application/json",
					cookie: `__Host-garrul_sess=${oldSid}`,
				},
				body: JSON.stringify({ token }),
			},
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBeGreaterThanOrEqual(500);
		const cookies = res.headers.getSetCookie();
		expect(
			cookies.filter((c) => /^__Host-garrul_sess=[^;]+/.test(c)),
		).toEqual([]);
	});

	it("rejects a token that was already spent", async () => {
		const token = await issueHandoff(
			oauthState as unknown as KVNamespace,
			USER,
		);
		const call = () =>
			app().request(
				"/session/exchange",
				{
					method: "POST",
					headers: { ...IP, "content-type": "application/json" },
					body: JSON.stringify({ token }),
				},
				env as unknown as Record<string, unknown>,
			);
		expect((await call()).status).toBe(200);
		expect((await call()).status).toBe(400);
	});
});

describe("GET /:provider/callback — state shape", () => {
	const badStates = [
		// Would land in a Set-Cookie name: `;` lets the caller append attributes,
		// `=` splits the name/value pair.
		"abc;Path=/",
		"aaaaaaaa=x",
		// Control characters make the runtime reject the header outright.
		`aaaa${String.fromCharCode(13)}${String.fromCharCode(10)}aaaa`,
		// Wrong length / charset for a 48-hex-char state.
		"deadbeef",
		"z".repeat(48),
		"a".repeat(600),
	];

	for (const state of badStates) {
		it(`rejects ${JSON.stringify(state.slice(0, 24))} without emitting a cookie`, async () => {
			const res = await app().request(
				`/github/callback?code=x&state=${encodeURIComponent(state)}`,
				{ headers: IP },
				env as unknown as Record<string, unknown>,
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toBe("invalid state");
			// The guard runs before bindCookieName, so nothing derived from the
			// attacker's value reaches a header at all.
			expect(res.headers.get("set-cookie")).toBeNull();
		});
	}

	it("still reaches the state check for a well-formed state", async () => {
		// 48 hex chars: shape is fine, so this fails on the missing/invalid
		// signed cookie instead — same status, but it clears the flow cookie.
		const state = "ab".repeat(24);
		const res = await app().request(
			`/github/callback?code=x&state=${state}`,
			{ headers: IP },
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBe(400);
		// The clear must name the same cookie /start set, prefix included — a
		// mismatched name (or path) leaves the single-use flow cookie live.
		expect(res.headers.get("set-cookie")).toContain(
			"__Host-garrul_oauth_b_abababab=;",
		);
	});
});

/**
 * The binding cookie's name is the whole defense. Its signature proves we
 * issued the state, not which browser holds it, so an attacker who starts a
 * flow himself can hand the victim his own state — the only thing stopping him
 * pairing it with the matching cookie is that `__Host-` cannot be written by a
 * sibling host under the operator's eTLD+1. `comments.<yourdomain>` is the
 * documented layout, so a sibling is the expected case, not an exotic one.
 */
describe("GET /:provider/start — binding cookie name", () => {
	const start = async (envOverride: Record<string, string> = {}) => {
		const res = await app().request(
			"/github/start",
			{},
			{
				...(env as unknown as Record<string, unknown>),
				GH_CLIENT_ID: "cid",
				GH_CLIENT_SECRET: "csecret",
				...envOverride,
			} as Record<string, unknown>,
		);
		expect(res.status).toBe(302);
		return res.headers.get("set-cookie") ?? "";
	};

	it("prefixes the cookie in production, with the attributes the prefix needs", async () => {
		const sc = await start();
		expect(sc).toContain("__Host-garrul_oauth_b_");
		expect(sc).toMatch(/(^|; )Path=\/(;|$)/);
		expect(sc).toMatch(/(^|; )Secure(;|$)/);
		expect(sc).not.toMatch(/Domain=/);
	});

	it("drops the prefix in dev, where plain HTTP cannot satisfy Secure", async () => {
		const sc = await start({ ENV: "dev" });
		expect(sc.startsWith("garrul_oauth_b_")).toBe(true);
		expect(sc).toContain("Path=/api/v1/auth");
	});
});

describe("auth routes — refusals and sign-out", () => {
	const post = (path: string, body: string, cookie?: string) =>
		app().request(
			path,
			{
				method: "POST",
				headers: { ...IP, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				body,
			},
			env as unknown as Record<string, unknown>,
		);

	it("answers 503 for a provider with no client credentials", async () => {
		const res = await app().request("/github/start", { headers: IP }, env as unknown as Record<string, unknown>);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "provider_not_configured" });
	});

	it.each([
		["non-JSON", "{nope"],
		["no token", "{}"],
		["an empty token", '{"token":""}'],
	])("refuses an exchange body with %s", async (_label, body) => {
		const res = await post("/session/exchange", body);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "err.token.bad" });
	});

	it("signs out by deleting the session behind the cookie", async () => {
		const sid = await seedSession();
		const res = await post("/signout", "", `__Host-garrul_sess=${sid}`);
		expect(await res.json()).toEqual({ ok: true });
		expect(sessions.store.has(`sess:${sid}`)).toBe(false);
	});
});

/**
 * GitHub answers the token exchange with 429 "Access to this site has been
 * restricted" (Retry-After: 300) to some shared Cloudflare Workers egress
 * addresses. When every retry is blocked, the callback must say so. It used to
 * fold that into a bare "Sign-in failed."
 * with nothing on the page or in the analytics row that said why, so a
 * transient upstream block read as a broken install.
 */
describe("GET /:provider/callback — token exchange failures", () => {
	const oauthEnv = () =>
		({
			...(env as unknown as Record<string, unknown>),
			GH_CLIENT_ID: "cid",
			GH_CLIENT_SECRET: "csecret",
		}) as Record<string, unknown>;

	/** Run /start for real and return the callback path plus its flow cookie. */
	const startFlow = async () => {
		const res = await app().request("/github/start", { headers: IP }, oauthEnv());
		const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
		const cookie = res.headers.get("set-cookie")!.split(";", 1)[0]!;
		return { path: `/github/callback?code=the-code&state=${state}`, cookie };
	};

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("names GitHub's 429 block and does not ask the reader to wait", async () => {
		const { path, cookie } = await startFlow();
		// Skip the real retry delay between the blocked attempts.
		vi.stubGlobal("setTimeout", (fn: () => void) => {
			fn();
			return 0;
		});
		vi.stubGlobal("fetch", async () =>
			new Response('{"message":"Access to this site has been restricted."}', {
				status: 429,
				headers: { "retry-after": "300" },
			}),
		);
		const res = await app().request(path, { headers: { ...IP, cookie } }, oauthEnv());
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBeNull();
		const body = await res.text();
		expect(body).toContain("HTTP 429");
		expect(body).toContain("Sign in again");
		expect(body).not.toContain("Wait");
	});

	it("keeps internal failure codes off the page for other exchange errors", async () => {
		const { path, cookie } = await startFlow();
		vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
		const res = await app().request(path, { headers: { ...IP, cookie } }, oauthEnv());
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("<p>Sign-in failed.</p>");
		expect(body).not.toContain("token_exchange_failed");
	});
});

describe("auth routes - rate limits", () => {
	it("signout answers 429 on the sixth hit in ten seconds", async () => {
		const a = app();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const res = await a.request("/signout", { method: "POST", headers: IP }, env);
			statuses.push(res.status);
		}
		expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
		const last = await a.request("/signout", { method: "POST", headers: IP }, env);
		expect(await last.json()).toEqual({ error: "ratelimited" });
	});

	it("exchange answers 429 on the sixth hit", async () => {
		const a = app();
		const statuses: number[] = [];
		for (let i = 0; i < 6; i++) {
			const token = await issueHandoff(oauthState as unknown as KVNamespace, USER);
			const res = await a.request(
				"/session/exchange",
				{ method: "POST", headers: { ...IP, "content-type": "application/json" }, body: JSON.stringify({ token }) },
				env,
			);
			statuses.push(res.status);
		}
		expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
	});

	it("signout and exchange keep separate buckets", async () => {
		const a = app();
		for (let i = 0; i < 5; i++) await a.request("/signout", { method: "POST", headers: IP }, env);
		const token = await issueHandoff(oauthState as unknown as KVNamespace, USER);
		const res = await a.request(
			"/session/exchange",
			{ method: "POST", headers: { ...IP, "content-type": "application/json" }, body: JSON.stringify({ token }) },
			env,
		);
		expect(res.status).toBe(200);
	});

	it("callback is limited before the state check", async () => {
		const a = app();
		let last = 0;
		for (let i = 0; i < 6; i++) {
			const res = await a.request("/github/callback?code=x&state=junk", { headers: IP }, env);
			last = res.status;
		}
		expect(last).toBe(429);
	});
});

describe("auth routes - revocation stays unconditional and fail-closed", () => {
	it("deletes a well-formed cookie's key even when KV reads it as missing", async () => {
		const sid = "c".repeat(64);
		const deletes: string[] = [];
		sessions.delete = async (key: string) => {
			deletes.push(key);
		};
		const res = await app().request(
			"/signout",
			{ method: "POST", headers: { ...IP, cookie: `__Host-garrul_sess=${sid}` } },
			env,
		);
		expect(res.status).toBe(200);
		expect(deletes).toEqual([`sess:${sid}`]);
	});

	it("a failing delete fails the signout instead of reporting success", async () => {
		const sid = await seedSession();
		sessions.delete = async () => {
			throw new Error("KV delete cap");
		};
		const res = await app().request(
			"/signout",
			{ method: "POST", headers: { ...IP, cookie: `__Host-garrul_sess=${sid}` } },
			env,
		);
		expect(res.status).toBeGreaterThanOrEqual(500);
		const still = await readSession({
			env: env as never,
			req: { header: () => `__Host-garrul_sess=${sid}` },
		} as never);
		expect(still).not.toBeNull();
	});
});
