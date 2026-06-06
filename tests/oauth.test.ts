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
	computeCodeChallenge,
	constantTimeEqual,
	consumeHandoff,
	consumeState,
	genCodeVerifier,
	isProvider,
	issueHandoff,
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
	it("accepts known providers and rejects others", () => {
		expect(isProvider("github")).toBe(true);
		expect(isProvider("google")).toBe(true);
		expect(isProvider("facebook")).toBe(true);
		expect(isProvider("myspace")).toBe(false);
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

	it("carries the PKCE code_verifier through KV roundtrip", async () => {
		const verifier = genCodeVerifier();
		const state = await issueState(store, {
			provider: "github",
			return_origin: "https://x.test",
			created_at: 3,
			browser_token: "tok",
			code_verifier: verifier,
		});
		const got = await consumeState(store, state);
		expect(got?.code_verifier).toBe(verifier);
	});
});

describe("PKCE helpers", () => {
	it("genCodeVerifier produces a 64-hex-char string within RFC 7636 limits", () => {
		const v = genCodeVerifier();
		expect(v).toMatch(/^[0-9a-f]{64}$/);
		expect(v.length).toBeGreaterThanOrEqual(43);
		expect(v.length).toBeLessThanOrEqual(128);
		expect(genCodeVerifier()).not.toBe(v);
	});

	it("computeCodeChallenge matches the RFC 7636 §B test vector", async () => {
		// Appendix B: verifier → base64url(SHA-256(verifier)) without padding.
		const challenge = await computeCodeChallenge(
			"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		);
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});

	it("produces base64url output (no +, /, or = padding)", async () => {
		const challenge = await computeCodeChallenge(genCodeVerifier());
		expect(challenge).not.toMatch(/[+/=]/);
	});
});

describe("issueHandoff / consumeHandoff", () => {
	let store: KVNamespace;
	beforeEach(() => {
		store = kv();
	});

	it("round-trips user_id through the handoff token", async () => {
		const token = await issueHandoff(store, "user-abc");
		expect(token).toMatch(/^[0-9a-f]{48}$/);
		expect(await consumeHandoff(store, token)).toBe("user-abc");
	});

	it("consumes handoff exactly once (replay defense)", async () => {
		const token = await issueHandoff(store, "user-xyz");
		expect(await consumeHandoff(store, token)).toBe("user-xyz");
		expect(await consumeHandoff(store, token)).toBeNull();
	});

	it("rejects malformed tokens without touching KV", async () => {
		expect(await consumeHandoff(store, "not-hex")).toBeNull();
		expect(await consumeHandoff(store, "")).toBeNull();
		expect(await consumeHandoff(store, "a".repeat(47))).toBeNull();
	});

	it("returns null for unknown handoff tokens", async () => {
		expect(await consumeHandoff(store, "0".repeat(48))).toBeNull();
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

describe("constantTimeEqual", () => {
	it("returns true for identical strings", () => {
		expect(constantTimeEqual("abc123", "abc123")).toBe(true);
		expect(constantTimeEqual("", "")).toBe(true);
	});
	it("returns false on length mismatch", () => {
		expect(constantTimeEqual("abc", "abcd")).toBe(false);
		expect(constantTimeEqual("abcd", "abc")).toBe(false);
		expect(constantTimeEqual("", "x")).toBe(false);
	});
	it("returns false on byte mismatch at any position", () => {
		// First-byte mismatch — naive === short-circuits here; this is the
		// position whose timing leak motivated the helper.
		expect(constantTimeEqual("xbc", "abc")).toBe(false);
		// Middle-byte mismatch.
		expect(constantTimeEqual("axc", "abc")).toBe(false);
		// Last-byte mismatch.
		expect(constantTimeEqual("abx", "abc")).toBe(false);
	});
	it("returns true for two randomHex outputs that happen to match", () => {
		const tok = randomHex(16);
		expect(constantTimeEqual(tok, tok)).toBe(true);
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

	it("omits PKCE params when no code_challenge is passed", () => {
		const url = new URL(
			buildAuthorizeUrl("github", "id", "https://x.test/cb", "s"),
		);
		expect(url.searchParams.get("code_challenge")).toBeNull();
		expect(url.searchParams.get("code_challenge_method")).toBeNull();
	});

	it("adds S256 code_challenge when one is passed", () => {
		const url = new URL(
			buildAuthorizeUrl(
				"github",
				"id",
				"https://x.test/cb",
				"s",
				"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
			),
		);
		expect(url.searchParams.get("code_challenge")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});
});
