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

	const envWith = (ai: unknown) => ({
		SPAM_PROVIDER: "workers-ai",
		AI: ai as Ai,
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

	it("calls full Clef when the model setting names it", async () => {
		const ai = makeAi(0.1);
		const v = await checkSpam(envWith(ai), input, 70, "clef");
		expect(ai.run).toHaveBeenCalledWith(
			"@cf/cloudflare/clef",
			expect.objectContaining({ model: "clef" }),
		);
		expect(v?.raw).toMatchObject({ model: "@cf/cloudflare/clef" });
	});

	it("records the Clef-flash id when no model is passed", async () => {
		// Upgrade safety: an install with no new setting keeps today's raw.model.
		const v = await checkSpam(envWith(makeAi(0.1)), input);
		expect(v?.raw).toMatchObject({ model: "@cf/cloudflare/clef-flash" });
	});

	it("flags spam at or above the threshold and records the probability as score", async () => {
		const v = await checkSpam(envWith(makeAi(0.5)), input, 50);
		expect(v).toMatchObject({ spam: true, reason: "workers-ai.spam", score: 0.5 });
		expect(v?.raw).toMatchObject({ threshold: 50 });
	});

	it("passes as ham below the threshold", async () => {
		const v = await checkSpam(envWith(makeAi(0.49)), input, 50);
		expect(v).toMatchObject({ spam: false, score: 0.49 });
	});

	it("flags a score sitting exactly on the threshold", async () => {
		// 0.57 * 100 is 56.99999999999999, so a multiplied comparison misses this.
		expect(await checkSpam(envWith(makeAi(0.57)), input, 57)).toMatchObject({
			spam: true,
		});
	});

	it("keeps its verdict when KV is out of quota", async () => {
		// A KV-backed verdict cache used to sit here. Once the account's daily KV
		// writes ran out, its put threw and the verdict was dropped as "no opinion".
		const exhausted = {
			get: vi.fn(async () => {
				throw new Error("KV get() limit exceeded for the day.");
			}),
			put: vi.fn(async () => {
				throw new Error("KV put() limit exceeded for the day.");
			}),
		};
		const env = { ...envWith(makeAi(0.9)), RATE_LIMITS: exhausted };
		expect(await checkSpam(env, input, 70)).toMatchObject({ spam: true, score: 0.9 });
		expect(exhausted.get).not.toHaveBeenCalled();
		expect(exhausted.put).not.toHaveBeenCalled();
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

describe("decisions provider", () => {
	// Bring-your-own-key: any OpenAI-style /decisions endpoint. The key rides in
	// an Authorization header, and a provider's error body can quote it back,
	// so the adapter logs only a status or an error name, never a message.
	const SECRET = "sk-do-not-log-me-0123456789abcdef";
	const originalFetch = globalThis.fetch;
	let calls: { url: string; init: RequestInit }[];
	let lines: string[];

	const env = (extra: Record<string, string> = {}) => ({
		SPAM_PROVIDER: "decisions",
		SPAM_DECISIONS_API_KEY: SECRET,
		...extra,
	});
	// The model arrives as the resolved `spam_decisions_model` setting, not env.
	const check = (e = env(), threshold = 70, model = "vendor/decider") =>
		checkSpam(e, input, threshold, "clef-flash", model);
	const respond = (status: number, body: unknown) => {
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(
				typeof body === "string" ? body : JSON.stringify(body),
				{ status },
			);
		}) as typeof fetch;
	};
	const answer = (p: unknown) => ({ answers: { spam: { type: "noul", noul: p } } });

	beforeEach(() => {
		calls = [];
		lines = [];
		vi.spyOn(console, "log").mockImplementation((s: unknown) => {
			lines.push(String(s));
		});
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("posts the shared spam question to OpenRouter by default, with a bearer key", async () => {
		respond(200, answer(0.1));
		await check();
		expect(calls).toHaveLength(1);
		// `?.`: tsconfig sets noUncheckedIndexedAccess, and tests are type-checked.
		expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
		const headers = new Headers(calls[0]?.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
		// A redirect could carry that header to another host or to http://.
		expect(calls[0]?.init.redirect).toBe("manual");
		const body = JSON.parse(String(calls[0]?.init.body));
		expect(body).toMatchObject({
			model: "vendor/decider",
			state: { comment: "Hello world", author: "Daisy" },
			questions: { spam: { type: "noul" } },
		});
		// Same privacy contract as Clef: no email, IP or user agent.
		expect(Object.keys(body.state).sort()).toEqual(
			["author", "comment", "first_time_commenter", "page"],
		);
	});

	it("uses SPAM_DECISIONS_URL when set", async () => {
		respond(200, answer(0.1));
		await check(env({ SPAM_DECISIONS_URL: "https://decide.example/v1/decisions" }));
		expect(calls[0]?.url).toBe("https://decide.example/v1/decisions");
	});

	it("refuses a non-https endpoint without calling it", async () => {
		respond(200, answer(0.9));
		expect(
			await check(env({ SPAM_DECISIONS_URL: "http://decide.example/v1/decisions" })),
		).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("returns null on a redirect without following it", async () => {
		respond(302, "");
		expect(await check()).toBeNull();
		expect(calls).toHaveLength(1);
		expect(lines.join("\n")).toContain("302");
	});

	it("returns null without a key or a model, and never calls out", async () => {
		respond(200, answer(0.9));
		expect(await check(env({ SPAM_DECISIONS_API_KEY: "" }))).toBeNull();
		expect(await check(env(), 70, "")).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("applies the threshold and records the configured model", async () => {
		respond(200, answer(0.8));
		expect(await check()).toMatchObject({
			spam: true,
			reason: "decisions.spam",
			score: 0.8,
			raw: { model: "vendor/decider", threshold: 70 },
		});
		respond(200, answer(0.69));
		expect(await check()).toMatchObject({ spam: false, score: 0.69 });
	});

	it("returns null on an HTTP error without logging the body or the key", async () => {
		respond(401, `{"error":"invalid key ${SECRET}"}`);
		expect(await check()).toBeNull();
		const logged = lines.join("\n");
		expect(logged).toContain("401");
		expect(logged).not.toContain(SECRET.slice(0, 8));
		expect(logged).not.toContain("invalid key");
	});

	it("returns null on a malformed answer", async () => {
		respond(200, answer("0.9"));
		expect(await check()).toBeNull();
		respond(200, { choices: [] });
		expect(await check()).toBeNull();
	});

	it("logs only an error's name, never its message", async () => {
		// V8's JSON.parse error quotes a truncated prefix of the text it choked
		// on — here, the start of the key — so an exact-match scrub would miss
		// it. A fetch error can carry whatever the runtime saw.
		respond(200, `${SECRET} PRIVATE-BODY is not json`);
		expect(await check()).toBeNull();
		globalThis.fetch = (async () => {
			throw new TypeError(`connect failed for ${SECRET}`);
		}) as typeof fetch;
		expect(await check()).toBeNull();
		const logged = lines.join("\n");
		expect(logged).not.toContain(SECRET.slice(0, 8));
		expect(logged).not.toContain("PRIVATE-BODY");
		expect(logged).toContain("SyntaxError");
		expect(logged).toContain("TypeError");
	});
});
