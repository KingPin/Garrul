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
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { auth } from "../src/routes/auth";
import { issueHandoff } from "../src/lib/oauth";
import { issueSession } from "../src/lib/session";
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
	sessions = makeKv();
	oauthState = makeKv();
	env = {
		SESSIONS: sessions,
		OAUTH_STATE: oauthState,
		JWT_SECRET: "test-jwt-secret",
		ENV: "prod",
	} as unknown as Bindings;
});

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
					headers: { "content-type": "application/json" },
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
				{},
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
			{},
			env as unknown as Record<string, unknown>,
		);
		expect(res.status).toBe(400);
		expect(res.headers.get("set-cookie")).toContain("garrul_oauth_b_abababab=");
	});
});
