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

	// Akismet's API contract puts the key in the hostname, so the secret is in
	// every request URL — and a fetch error string or an error body can echo that
	// URL straight into the operator's log stream, where it is durable and
	// readable by anyone with `wrangler tail` access.
	describe("never logs the API key", () => {
		const SECRET = "ak-do-not-log-me";
		const env = {
			SPAM_PROVIDER: "akismet",
			AKISMET_API_KEY: SECRET,
			AKISMET_SITE_URL: "https://example.com",
		};
		let lines: string[];

		beforeEach(() => {
			lines = [];
			vi.spyOn(console, "log").mockImplementation((s: unknown) => {
				lines.push(String(s));
			});
		});
		afterEach(() => vi.restoreAllMocks());

		it("scrubs it from a fetch error that echoes the request URL", async () => {
			globalThis.fetch = (async (url: string) => {
				throw new Error(`request to ${url} failed`);
			}) as typeof fetch;

			expect(await checkSpam(env, input)).toBeNull();
			expect(lines.join("\n")).not.toContain(SECRET);
			// Still diagnosable: the redaction marker proves the line was emitted.
			expect(lines.join("\n")).toContain("***");
		});

		it("scrubs it from an error response body", async () => {
			mockFetch({ ok: false, text: `invalid key ${SECRET} for site` });
			expect(await checkSpam(env, input)).toBeNull();
			expect(lines.join("\n")).not.toContain(SECRET);
		});

		it("scrubs it from an unexpected response body", async () => {
			mockFetch({ ok: true, text: `nope ${SECRET}` });
			expect(await checkSpam(env, input)).toBeNull();
			expect(lines.join("\n")).not.toContain(SECRET);
		});
	});
});

describe("workers-ai provider", () => {
	// Clef-flash returns P(spam) as a "noul" answer under the question id.
	const makeAi = (p: unknown) => ({
		run: vi.fn(async () => ({ answers: { spam: { type: "noul", noul: p } } })),
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

	const envWith = (ai: unknown, kv?: StubKV) => ({
		SPAM_PROVIDER: "workers-ai",
		AI: ai as Ai,
		...(kv && { RATE_LIMITS: kv as unknown as KVNamespace }),
	});

	it("calls Clef-flash with the comment as state and one yes/no question", async () => {
		const ai = makeAi(0.1);
		await checkSpam(envWith(ai), input);
		expect(ai.run).toHaveBeenCalledWith(
			"@cf/cloudflare/clef-flash",
			expect.objectContaining({
				model: "clef-flash",
				state: expect.objectContaining({ comment: "Hello world" }),
				questions: { spam: expect.objectContaining({ type: "noul" }) },
			}),
		);
	});

	it("flags spam at or above the threshold and records the probability as score", async () => {
		const kv = new StubKV();
		const v = await checkSpam(envWith(makeAi(0.5), kv), input, 50);
		expect(v).toMatchObject({ spam: true, reason: "workers-ai.spam", score: 0.5 });
		expect(v?.raw).toMatchObject({ cached: false, threshold: 50 });
		// Caches the probability, not the verdict, so a retuned threshold applies.
		expect([...kv.map.values()]).toEqual(["0.5"]);
	});

	it("passes as ham below the threshold", async () => {
		const v = await checkSpam(envWith(makeAi(0.49)), input, 50);
		expect(v).toMatchObject({ spam: false, score: 0.49 });
	});

	it("re-judges a cached probability against the current threshold", async () => {
		const ai = makeAi(0.6);
		const kv = new StubKV();
		expect((await checkSpam(envWith(ai, kv), input, 50))?.spam).toBe(true);
		const v = await checkSpam(envWith(ai, kv), input, 80);
		expect(v).toMatchObject({ spam: false, score: 0.6, raw: { cached: true } });
		expect(ai.run).toHaveBeenCalledTimes(1);
	});

	it("treats a pre-Clef SPAM/HAM cache entry as a miss", async () => {
		const ai = makeAi(0.2);
		const kv = new StubKV();
		await checkSpam(envWith(ai, kv), input);
		const [key] = kv.map.keys();
		kv.map.set(key as string, "spam");
		const v = await checkSpam(envWith(ai, kv), input);
		expect(v).toMatchObject({ spam: false, raw: { cached: false } });
		expect(ai.run).toHaveBeenCalledTimes(2);
	});

	it("returns null when the answer is missing or not a probability", async () => {
		expect(await checkSpam(envWith(makeAi(undefined)), input)).toBeNull();
		expect(await checkSpam(envWith(makeAi(1.5)), input)).toBeNull();
		expect(await checkSpam(envWith(makeAi("0.9")), input)).toBeNull();
	});

	it("returns null when the model call throws", async () => {
		const ai = { run: vi.fn(async () => { throw new Error("ai down"); }) };
		expect(await checkSpam(envWith(ai), input)).toBeNull();
	});
});
