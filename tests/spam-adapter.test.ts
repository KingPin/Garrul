/**
 * Adapter dispatch + per-provider tests. The dispatcher must return null
 * when unconfigured (the caller treats null as "no opinion" — heuristics
 * decide alone). Provider tests use mocked transports so the suite stays
 * offline; CLAUDE.md forbids network in tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSpam, type SpamCheckInput } from "../src/lib/spam";

const input: SpamCheckInput = {
	body_md: "Hello world",
	author_name: "Daisy",
	author_email: null,
	user_agent: "test-ua",
	post_url: "https://example.com/post",
	is_first_comment: false,
};

describe("checkSpam dispatcher", () => {
	it("returns null when SPAM_PROVIDER is unset", async () => {
		const v = await checkSpam({}, input);
		expect(v).toBeNull();
	});

	it("returns null when provider is unknown", async () => {
		const v = await checkSpam({ SPAM_PROVIDER: "bogus" }, input);
		expect(v).toBeNull();
	});

	it("returns null for akismet when API key or site URL missing", async () => {
		expect(await checkSpam({ SPAM_PROVIDER: "akismet" }, input)).toBeNull();
		expect(
			await checkSpam(
				{ SPAM_PROVIDER: "akismet", AKISMET_API_KEY: "x" },
				input,
			),
		).toBeNull();
	});

	it("returns null for workers-ai when AI binding is missing", async () => {
		expect(await checkSpam({ SPAM_PROVIDER: "workers-ai" }, input)).toBeNull();
	});
});

describe("akismet provider", () => {
	const originalFetch = globalThis.fetch;
	let lastUrl = "";
	let lastBody = "";

	beforeEach(() => {
		lastUrl = "";
		lastBody = "";
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const mockFetch = (response: { ok: boolean; text: string; proTip?: string }) => {
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			lastUrl = url;
			lastBody = String(init?.body ?? "");
			const headers = new Headers();
			if (response.proTip) headers.set("x-akismet-pro-tip", response.proTip);
			return new Response(response.text, {
				status: response.ok ? 200 : 500,
				headers,
			});
		}) as typeof fetch;
	};

	it("returns spam=true when Akismet says 'true'", async () => {
		mockFetch({ ok: true, text: "true" });
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "akismet",
				AKISMET_API_KEY: "key",
				AKISMET_SITE_URL: "https://example.com",
			},
			input,
		);
		expect(v).toMatchObject({ spam: true, reason: "akismet.spam" });
		expect(v?.raw).toMatchObject({ response: "true" });
		expect(lastUrl).toContain("key.rest.akismet.com");
		expect(lastBody).toContain("blog=https%3A%2F%2Fexample.com");
		expect(lastBody).toContain("comment_author=Daisy");
		expect(lastBody).toContain("comment_content=Hello+world");
		// Privacy posture: a fixed placeholder IP, never the real client IP.
		expect(lastBody).toContain("user_ip=127.0.0.1");
	});

	it("returns spam=false when Akismet says 'false'", async () => {
		mockFetch({ ok: true, text: "false" });
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "akismet",
				AKISMET_API_KEY: "key",
				AKISMET_SITE_URL: "https://example.com",
			},
			input,
		);
		expect(v).toMatchObject({ spam: false });
		expect(v?.raw).toMatchObject({ response: "false" });
	});

	it("marks pro-tip 'discard' verdicts with the discard reason", async () => {
		mockFetch({ ok: true, text: "true", proTip: "discard" });
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "akismet",
				AKISMET_API_KEY: "key",
				AKISMET_SITE_URL: "https://example.com",
			},
			input,
		);
		expect(v).toMatchObject({ spam: true, reason: "akismet.discard" });
		expect(v?.raw).toMatchObject({ pro_tip: "discard" });
	});

	it("returns null on HTTP failure (degrade to no opinion)", async () => {
		mockFetch({ ok: false, text: "server error" });
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "akismet",
				AKISMET_API_KEY: "key",
				AKISMET_SITE_URL: "https://example.com",
			},
			input,
		);
		expect(v).toBeNull();
	});

	it("returns null on unexpected response body", async () => {
		mockFetch({ ok: true, text: "maybe" });
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "akismet",
				AKISMET_API_KEY: "key",
				AKISMET_SITE_URL: "https://example.com",
			},
			input,
		);
		expect(v).toBeNull();
	});
});

describe("workers-ai provider", () => {
	const makeAi = (response: string) => ({
		// Cloudflare's Ai.run returns either a string or { response: string }.
		run: vi.fn(async () => ({ response })),
	});

	class StubKV {
		map = new Map<string, string>();
		async get(key: string) {
			return this.map.get(key) ?? null;
		}
		async put(key: string, value: string) {
			this.map.set(key, value);
		}
	}

	it("returns spam=true when the model says SPAM", async () => {
		const ai = makeAi("SPAM");
		const kv = new StubKV();
		const v = await checkSpam(
			{
				SPAM_PROVIDER: "workers-ai",
				AI: ai as unknown as Ai,
				RATE_LIMITS: kv as unknown as KVNamespace,
			},
			input,
		);
		expect(v).toMatchObject({ spam: true, reason: "workers-ai.spam" });
		expect(v?.raw).toMatchObject({ cached: false });
		expect(ai.run).toHaveBeenCalledOnce();
		// Caches the verdict so a second call short-circuits.
		expect([...kv.map.values()]).toContain("spam");
	});

	it("returns spam=false when the model says HAM", async () => {
		const ai = makeAi("HAM");
		const v = await checkSpam(
			{ SPAM_PROVIDER: "workers-ai", AI: ai as unknown as Ai },
			input,
		);
		expect(v).toMatchObject({ spam: false });
		expect(v?.raw).toMatchObject({ cached: false });
	});

	it("uses cached verdict without calling the model again", async () => {
		const ai = makeAi("SPAM");
		const kv = new StubKV();
		await checkSpam(
			{
				SPAM_PROVIDER: "workers-ai",
				AI: ai as unknown as Ai,
				RATE_LIMITS: kv as unknown as KVNamespace,
			},
			input,
		);
		expect(ai.run).toHaveBeenCalledTimes(1);

		await checkSpam(
			{
				SPAM_PROVIDER: "workers-ai",
				AI: ai as unknown as Ai,
				RATE_LIMITS: kv as unknown as KVNamespace,
			},
			input,
		);
		expect(ai.run).toHaveBeenCalledTimes(1);
	});

	it("returns null when the model emits something unrecognized", async () => {
		const ai = makeAi("maybe?");
		const v = await checkSpam(
			{ SPAM_PROVIDER: "workers-ai", AI: ai as unknown as Ai },
			input,
		);
		expect(v).toBeNull();
	});

	it("returns null when the model call throws", async () => {
		const ai = { run: vi.fn(async () => { throw new Error("ai down"); }) };
		const v = await checkSpam(
			{ SPAM_PROVIDER: "workers-ai", AI: ai as unknown as Ai },
			input,
		);
		expect(v).toBeNull();
	});
});
