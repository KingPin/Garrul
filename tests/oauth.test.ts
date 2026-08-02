/**
 * OAuth helpers — signed-state issue/verify, callback URL derivation,
 * authorize URL building, and provider id type-guard.
 *
 * State is stateless and HMAC-signed (no KV write on the unauthenticated
 * /start route), so its rejection cases ARE the login-CSRF and replay
 * defenses — they matter more than the happy path.
 *
 * We don't exercise the actual provider HTTPS calls — those happen at the
 * boundary in fetch_profile / exchangeCodeForToken. Those callers are
 * exercised by integration tests once wrangler-dev is wired in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	buildAuthorizeUrl,
	callbackUrl,
	computeCodeChallenge,
	constantTimeEqual,
	consumeHandoff,
	exchangeCodeForToken,
	genCodeVerifier,
	isProvider,
	issueHandoff,
	issueState,
	PROVIDERS,
	randomHex,
	STATE_MAX_AGE_MS,
	verifyState,
} from "../src/lib/oauth";
import { base64UrlEncode } from "../src/lib/hmac";

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
		expect(isProvider("twitter")).toBe(true);
		expect(isProvider("discord")).toBe(true);
		expect(isProvider("myspace")).toBe(false);
		expect(isProvider("")).toBe(false);
	});
});

describe("issueState / verifyState", () => {
	const SECRET = "state-signing-secret";

	it("round-trips the state payload", async () => {
		const { state, token } = await issueState(SECRET, {
			provider: "github",
			return_origin: "https://blog.example.com",
		});
		const got = await verifyState(SECRET, token, {
			provider: "github",
			state,
		});
		expect(got).toMatchObject({
			provider: "github",
			return_origin: "https://blog.example.com",
			state,
		});
		expect(typeof got?.created_at).toBe("number");
	});

	it("issues a fresh 48-hex state per flow", async () => {
		const a = await issueState(SECRET, { provider: "github", return_origin: "" });
		const b = await issueState(SECRET, { provider: "github", return_origin: "" });
		expect(a.state).toMatch(/^[0-9a-f]{48}$/);
		expect(a.state).not.toBe(b.state);
		expect(a.token).not.toBe(b.token);
	});

	it("rejects a token signed with a different secret", async () => {
		const { state, token } = await issueState("attacker-secret", {
			provider: "github",
			return_origin: "https://x.test",
		});
		expect(
			await verifyState(SECRET, token, { provider: "github", state }),
		).toBeNull();
	});

	it("rejects a token bound to a different state (replay defense)", async () => {
		// The core login-CSRF property: a (cookie, state) pair is not
		// transferable. An attacker's own valid token must not validate against
		// a state value they didn't mint it for.
		const a = await issueState(SECRET, {
			provider: "github",
			return_origin: "https://x.test",
		});
		const b = await issueState(SECRET, {
			provider: "github",
			return_origin: "https://x.test",
		});
		expect(
			await verifyState(SECRET, a.token, { provider: "github", state: b.state }),
		).toBeNull();
	});

	it("rejects a provider mismatch", async () => {
		// Stops a state minted for one provider being redeemed at another's
		// callback, where a different client_secret and profile shape apply.
		const { state, token } = await issueState(SECRET, {
			provider: "github",
			return_origin: "https://x.test",
		});
		expect(
			await verifyState(SECRET, token, { provider: "google", state }),
		).toBeNull();
	});

	it("rejects a tampered payload", async () => {
		const { state, token } = await issueState(SECRET, {
			provider: "github",
			return_origin: "https://x.test",
		});
		const [, sig] = token.split(".");
		// Re-encode a payload the attacker wants, keeping the real signature.
		const forgedBody = base64UrlEncode(
			JSON.stringify({
				provider: "github",
				return_origin: "https://evil.test",
				state,
				created_at: Date.now(),
			}),
		);
		expect(
			await verifyState(SECRET, `${forgedBody}.${sig}`, {
				provider: "github",
				state,
			}),
		).toBeNull();
	});

	it("rejects malformed and empty tokens without throwing", async () => {
		for (const bad of ["", ".", "nodot", "body.", "body.short"]) {
			expect(
				await verifyState(SECRET, bad, { provider: "github", state: "x" }),
			).toBeNull();
		}
	});

	it("expires a state past STATE_MAX_AGE_MS", async () => {
		// created_at is now actually READ. Under the old KV implementation the
		// field was written and never checked, leaving freshness entirely to
		// best-effort KV expiry.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_700_000_000_000);
			const { state, token } = await issueState(SECRET, {
				provider: "github",
				return_origin: "https://x.test",
			});
			vi.setSystemTime(1_700_000_000_000 + STATE_MAX_AGE_MS - 1);
			expect(
				await verifyState(SECRET, token, { provider: "github", state }),
			).not.toBeNull();
			vi.setSystemTime(1_700_000_000_000 + STATE_MAX_AGE_MS + 1);
			expect(
				await verifyState(SECRET, token, { provider: "github", state }),
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("carries the PKCE code_verifier through the signed payload", async () => {
		const verifier = genCodeVerifier();
		const { state, token } = await issueState(SECRET, {
			provider: "twitter",
			return_origin: "https://x.test",
			code_verifier: verifier,
		});
		const got = await verifyState(SECRET, token, {
			provider: "twitter",
			state,
		});
		expect(got?.code_verifier).toBe(verifier);
	});

	it("fits comfortably inside a cookie", async () => {
		// The payload now rides in a Set-Cookie header; blowing the ~4KB
		// per-cookie limit would break sign-in for the PKCE providers only,
		// which is exactly the kind of thing that ships unnoticed.
		const { token } = await issueState(SECRET, {
			provider: "twitter",
			return_origin: "https://a-fairly-long-subdomain.example.com",
			code_verifier: genCodeVerifier(),
		});
		expect(token.length).toBeLessThan(1024);
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

describe("exchangeCodeForToken", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const stubFetch = () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ access_token: "tok-123" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		return calls;
	};

	it("uses HTTP Basic auth + code_verifier and omits client_secret from the body for token_auth:basic (twitter)", async () => {
		const calls = stubFetch();
		const token = await exchangeCodeForToken(
			"twitter",
			"the-code",
			"cid",
			"csecret",
			"https://x.test/cb",
			"the-verifier",
		);
		expect(token).toBe("tok-123");
		expect(calls[0]!.url).toBe(PROVIDERS.twitter.token_url);
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Basic ${btoa("cid:csecret")}`);
		const body = (calls[0]!.init.body as URLSearchParams).toString();
		expect(body).toContain("code_verifier=the-verifier");
		// The secret must never appear in the body when using Basic auth.
		expect(body).not.toContain("csecret");
		expect(body).not.toContain("client_secret");
	});

	it("puts client_secret in the body and sends no auth header for token_auth:body (github)", async () => {
		const calls = stubFetch();
		await exchangeCodeForToken(
			"github",
			"the-code",
			"id",
			"sec",
			"https://x.test/cb",
		);
		const headers = calls[0]!.init.headers as Record<string, string>;
		expect(headers.authorization).toBeUndefined();
		const body = (calls[0]!.init.body as URLSearchParams).toString();
		expect(body).toContain("client_secret=sec");
		expect(body).not.toContain("code_verifier");
	});
});
