/**
 * The OAuth round trip, /start → provider → /callback, against REAL SQLite.
 *
 * The provider's token and userinfo endpoints are a stubbed fetch, so no
 * network is touched. The flow's state rides only in the /start cookie; the
 * callback must turn a good exchange into a user row, a session and a
 * one-time handoff posted to the allow-listed opener, and must turn every
 * failure (token, profile, banned) into a failed page with no session.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { auth } from "../src/routes/auth";
import type { Bindings } from "../src/index";
import { adminHarness, makeKv } from "./helpers/admin-sqlite";

const BLOG = "https://blog.example.com";

const setup = (extra: Record<string, unknown> = {}) => {
	const h = adminHarness();
	const sessions = makeKv();
	const oauthState = makeKv();
	const env = {
		DB: h.env.DB,
		SESSIONS: sessions,
		OAUTH_STATE: oauthState,
		ANALYTICS: { writeDataPoint() {} },
		JWT_SECRET: "test-jwt-secret",
		ENV: "dev",
		GOOGLE_CLIENT_ID: "cid",
		GOOGLE_CLIENT_SECRET: "csecret",
		ALLOWED_ORIGINS: BLOG,
		ADMIN_EMAILS: "boss@example.com",
		...extra,
	} as unknown as Bindings;
	const app = new Hono<{ Bindings: Bindings }>().route("/", auth);
	const call = (path: string, cookie = "", override: Record<string, unknown> = {}) =>
		app.request(path, { headers: cookie ? { cookie } : {} }, { ...env, ...override } as never);

	// Run /start, then the callback with the cookie /start set.
	const signIn = async (returnTo = BLOG, override: Record<string, unknown> = {}) => {
		const start = await call(`/google/start?return=${encodeURIComponent(returnTo)}`);
		expect(start.status).toBe(302);
		const state = new URL(start.headers.get("location") as string).searchParams.get("state");
		const cookie = (start.headers.get("set-cookie") as string).split(";", 1)[0];
		return call(`/google/callback?code=auth-code&state=${state}`, cookie, override);
	};
	const users = () =>
		h.sqlite.prepare("SELECT provider_id, name, role FROM users WHERE provider = 'google'").all();
	const sessionKeys = () => [...sessions.store.keys()].filter((k) => k.startsWith("sess:"));
	return { ...h, oauthState, signIn, users, sessionKeys };
};

// Token endpoint, then userinfo; each answer is [status, body].
const provider = (token: [number, unknown], profile: [number, unknown] = [200, {}]) => {
	const fetchMock = vi.fn(async (url: string) => {
		const [status, body] = String(url).includes("/token") ? token : profile;
		return new Response(JSON.stringify(body), { status });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

const PROFILE = { sub: "g-1", email: "boss@example.com", email_verified: true, name: "Boss" };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GET /:provider/callback — full round trip", () => {
	it("creates the user, issues a session and posts a handoff to the opener", async () => {
		const fetchMock = provider([200, { access_token: "at" }], [200, PROFILE]);
		const { signIn, users, sessionKeys, oauthState } = setup();
		const html = await (await signIn()).text();

		expect(users()).toEqual([{ provider_id: "g-1", name: "Boss", role: "admin" }]);
		expect(sessionKeys()).toHaveLength(1);
		const handoff = html.match(/"handoff":"([0-9a-f]+)"/)?.[1] as string;
		expect(handoff).toMatch(/^[0-9a-f]{48}$/);
		expect([...oauthState.store.keys()].some((k) => k.includes(handoff))).toBe(true);
		expect(html).toContain(`"type":"garrul:auth","ok":true`);
		expect(html).toContain(`postMessage(`);
		expect(html).toContain(`"${BLOG}"`);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(init.body)).toContain("code=auth-code");
	});

	it("renders a static page with no postMessage target for an unlisted return origin", async () => {
		provider([200, { access_token: "at" }], [200, PROFILE]);
		const html = await (await setup().signIn("https://evil.example.com")).text();
		expect(html).toContain("Signed in.");
		expect(html).not.toContain("postMessage");
	});

	it.each([
		["token_exchange_failed", [500, {}], [200, PROFILE]],
		["token_exchange_failed", [200, { error: "invalid_grant" }], [200, PROFILE]],
		["profile_fetch_failed", [200, { access_token: "at" }], [401, {}]],
	] as const)("fails with %s and writes nothing", async (message, token, profile) => {
		provider(token as [number, unknown], profile as [number, unknown]);
		const { signIn, users, sessionKeys } = setup();
		const html = await (await signIn()).text();
		expect(html).toContain(`"ok":false,"message":"${message}"`);
		expect(users()).toEqual([]);
		expect(sessionKeys()).toEqual([]);
	});

	it("refuses a banned account without issuing a session", async () => {
		provider([200, { access_token: "at" }], [200, PROFILE]);
		const h = setup();
		h.sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, is_banned, role, created_at)
				 VALUES ('01HBANNED00000000000000000', 'google', 'g-1', 'Boss', 1, 'user', 1)`,
			)
			.run();
		const html = await (await h.signIn()).text();
		expect(html).toContain(`"message":"banned"`);
		expect(h.sessionKeys()).toEqual([]);
	});

	it("answers 503 when the provider loses its credentials mid-flow", async () => {
		const fetchMock = provider([200, { access_token: "at" }]);
		const res = await setup().signIn(BLOG, { GOOGLE_CLIENT_SECRET: "" });
		expect(res.status).toBe(503);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
