/**
 * verifyToken endpoint-probing tests. Cloudflare issues two kinds of API
 * token and each verifies at its own endpoint; probing the wrong one
 * returns 401 on a perfectly valid token. These pin the probe order, the
 * fall-back, and the both-failed error shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { verifyToken } from "../src/lib/cf-usage";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`;
const USER_URL = "https://api.cloudflare.com/client/v4/user/tokens/verify";

type Reply = { status: number; body: unknown };

const ACTIVE: Reply = {
	status: 200,
	body: { success: true, result: { id: "tok-id", status: "active" } },
};
const INVALID: Reply = {
	status: 401,
	body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] },
};
const NOT_FOUND: Reply = { status: 404, body: { success: false, errors: [] } };

const originalFetch = globalThis.fetch;

/** Stubs fetch with a per-URL reply table; returns the URL call log. */
const stubFetch = (replies: Record<string, Reply>): string[] => {
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		const reply = replies[url] ?? NOT_FOUND;
		return {
			ok: reply.status >= 200 && reply.status < 300,
			status: reply.status,
			json: async () => reply.body,
		};
	}) as unknown as typeof fetch;
	return calls;
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("verifyToken", () => {
	it("accepts an account-owned token without touching the user endpoint", async () => {
		const calls = stubFetch({ [ACCOUNT_URL]: ACTIVE, [USER_URL]: INVALID });
		expect(await verifyToken("cfat-token", ACCOUNT_ID)).toEqual({
			ok: true,
			status: "active",
		});
		expect(calls).toEqual([ACCOUNT_URL]);
	});

	it("falls back to the user endpoint when the account probe rejects", async () => {
		const calls = stubFetch({ [ACCOUNT_URL]: INVALID, [USER_URL]: ACTIVE });
		expect(await verifyToken("user-token", ACCOUNT_ID)).toEqual({
			ok: true,
			status: "active",
		});
		expect(calls).toEqual([ACCOUNT_URL, USER_URL]);
	});

	it("reports both probe errors when neither endpoint accepts the token", async () => {
		stubFetch({ [ACCOUNT_URL]: INVALID, [USER_URL]: INVALID });
		expect(await verifyToken("revoked", ACCOUNT_ID)).toEqual({
			ok: false,
			error: "account:http_401 user:http_401",
		});
	});

	it("falls back when the account probe fails for a non-auth reason", async () => {
		// 404/5xx on the account endpoint must not fail the token closed while
		// the user endpoint still vouches for it. (A wrong CF_ACCOUNT_ID is
		// *not* this case — Cloudflare ignores the path ID and verifies the
		// bearer alone, so a typo passes here and surfaces per-panel later.)
		const calls = stubFetch({ [USER_URL]: ACTIVE });
		expect(await verifyToken("user-token", ACCOUNT_ID)).toEqual({
			ok: true,
			status: "active",
		});
		expect(calls).toEqual([ACCOUNT_URL, USER_URL]);
	});

	it("probes only the user endpoint when no account ID is given", async () => {
		const calls = stubFetch({ [USER_URL]: ACTIVE });
		expect(await verifyToken("user-token")).toEqual({
			ok: true,
			status: "active",
		});
		expect(calls).toEqual([USER_URL]);
	});

	it("returns a non-active status as-is rather than falling back", async () => {
		const expired: Reply = {
			status: 200,
			body: { success: true, result: { status: "expired" } },
		};
		const calls = stubFetch({ [ACCOUNT_URL]: expired, [USER_URL]: ACTIVE });
		expect(await verifyToken("token", ACCOUNT_ID)).toEqual({
			ok: true,
			status: "expired",
		});
		expect(calls).toEqual([ACCOUNT_URL]);
	});

	it("rejects a malformed verify response", async () => {
		const empty: Reply = { status: 200, body: { success: true } };
		stubFetch({ [ACCOUNT_URL]: empty, [USER_URL]: empty });
		expect(await verifyToken("token", ACCOUNT_ID)).toEqual({
			ok: false,
			error: "account:invalid_response user:invalid_response",
		});
	});

	it("percent-encodes the account ID into the probe URL", async () => {
		const calls = stubFetch({});
		await verifyToken("token", "acct/../evil");
		expect(calls[0]).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct%2F..%2Fevil/tokens/verify",
		);
	});
});
