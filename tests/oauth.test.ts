/**
 * OAuth helpers — state issue/consume round-trip, callback URL derivation,
 * authorize URL building, and provider id type-guard.
 *
 * We don't exercise the actual provider HTTPS calls — those happen at the
 * boundary in fetch_profile / exchangeCodeForToken. Those callers are
 * exercised by integration tests once wrangler-dev is wired in.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	buildAuthorizeUrl,
	callbackUrl,
	consumeState,
	isProvider,
	issueState,
	PROVIDERS,
	randomHex,
} from "../src/lib/oauth";

class StubKV {
	private map = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.map.get(key) ?? null;
	}
	async put(key: string, value: string): Promise<void> {
		this.map.set(key, value);
	}
	async delete(key: string): Promise<void> {
		this.map.delete(key);
	}
}

const kv = () => new StubKV() as unknown as KVNamespace;

describe("isProvider", () => {
	it("accepts github and google only", () => {
		expect(isProvider("github")).toBe(true);
		expect(isProvider("google")).toBe(true);
		expect(isProvider("twitter")).toBe(false);
		expect(isProvider("")).toBe(false);
	});
});

describe("issueState / consumeState", () => {
	let store: KVNamespace;
	beforeEach(() => {
		store = kv();
	});

	it("round-trips state payload", async () => {
		const state = await issueState(store, {
			provider: "github",
			return_origin: "https://blog.example.com",
			created_at: 1700000000000,
			browser_token: "abc123",
		});
		const got = await consumeState(store, state);
		expect(got).toEqual({
			provider: "github",
			return_origin: "https://blog.example.com",
			created_at: 1700000000000,
			browser_token: "abc123",
		});
	});

	it("consumes state exactly once (CSRF / replay defense)", async () => {
		const state = await issueState(store, {
			provider: "google",
			return_origin: "https://x.test",
			created_at: 1,
			browser_token: "tok",
		});
		expect(await consumeState(store, state)).not.toBeNull();
		expect(await consumeState(store, state)).toBeNull();
	});

	it("returns null for unknown state", async () => {
		expect(await consumeState(store, "nope")).toBeNull();
	});

	it("carries browser_token through KV roundtrip", async () => {
		const tok = randomHex(16);
		const state = await issueState(store, {
			provider: "github",
			return_origin: "https://x.test",
			created_at: 2,
			browser_token: tok,
		});
		const got = await consumeState(store, state);
		expect(got?.browser_token).toBe(tok);
	});
});

describe("randomHex", () => {
	it("produces hex of requested byte length", () => {
		const h = randomHex(16);
		expect(h).toMatch(/^[0-9a-f]{32}$/);
	});
	it("produces distinct values across calls", () => {
		expect(randomHex(16)).not.toBe(randomHex(16));
	});
});

describe("callbackUrl", () => {
	it("uses OAUTH_CALLBACK_BASE when set", () => {
		const url = callbackUrl(
			{ OAUTH_CALLBACK_BASE: "https://comments.garrul.com" },
			"https://example.com/whatever",
			"github",
		);
		expect(url).toBe("https://comments.garrul.com/api/v1/auth/github/callback");
	});

	it("falls back to request origin when unset", () => {
		const url = callbackUrl({}, "https://localhost:8787/api/v1/auth/google/start", "google");
		expect(url).toBe("https://localhost:8787/api/v1/auth/google/callback");
	});

	it("strips a trailing slash from OAUTH_CALLBACK_BASE", () => {
		const url = callbackUrl(
			{ OAUTH_CALLBACK_BASE: "https://comments.garrul.com/" },
			"https://x.test",
			"github",
		);
		expect(url).toBe("https://comments.garrul.com/api/v1/auth/github/callback");
	});
});

describe("buildAuthorizeUrl", () => {
	it("includes client_id, redirect_uri, state, scope", () => {
		const url = new URL(
			buildAuthorizeUrl(
				"github",
				"clientidGH",
				"https://comments.example.com/api/v1/auth/github/callback",
				"abc123",
			),
		);
		expect(url.origin + url.pathname).toBe(PROVIDERS.github.authorize_url);
		expect(url.searchParams.get("client_id")).toBe("clientidGH");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://comments.example.com/api/v1/auth/github/callback",
		);
		expect(url.searchParams.get("state")).toBe("abc123");
		expect(url.searchParams.get("scope")).toBe("read:user user:email");
		expect(url.searchParams.get("response_type")).toBe("code");
	});

	it("adds prompt=select_account for google", () => {
		const url = new URL(
			buildAuthorizeUrl("google", "id", "https://x.test/cb", "s"),
		);
		expect(url.searchParams.get("prompt")).toBe("select_account");
	});
});
