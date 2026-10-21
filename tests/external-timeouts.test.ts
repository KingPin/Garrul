/**
 * The comment POST waits on siteverify, Akismet and Workers AI. Each call is
 * bounded, so a hung provider costs the reader a few seconds rather than
 * holding the request open, and a failed siteverify is a 400, not a 500.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSpam, type SpamCheckInput } from "../src/lib/spam";
import { verifyTurnstile } from "../src/lib/turnstile";

const input: SpamCheckInput = {
	body_md: "Hello world",
	author_name: "Daisy",
	author_email: null,
	user_agent: "test-ua",
	post_url: "https://example.com/post",
	is_first_comment: false,
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("external call timeouts", () => {
	it("siteverify carries a timeout signal and fails closed when it throws", async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
			throw new DOMException("timed out", "TimeoutError");
		});
		vi.stubGlobal("fetch", fetch);
		await expect(
			verifyTurnstile("tok", "secret", { expectedHostname: "example.com" }),
		).resolves.toBe(false);
		expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("Akismet carries a timeout signal and reads a timeout as no opinion", async () => {
		const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
			throw new DOMException("timed out", "TimeoutError");
		});
		vi.stubGlobal("fetch", fetch);
		const env = {
			SPAM_PROVIDER: "akismet",
			AKISMET_API_KEY: "k",
			AKISMET_SITE_URL: "https://example.com",
		};
		await expect(checkSpam(env, input)).resolves.toBeNull();
		expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("a Workers AI call that never answers is no opinion after 5 s", async () => {
		vi.useFakeTimers();
		const ai = { run: vi.fn(() => new Promise(() => {})) };
		const v = checkSpam({ SPAM_PROVIDER: "workers-ai", AI: ai as unknown as Ai }, input);
		await vi.advanceTimersByTimeAsync(5_000);
		await expect(v).resolves.toBeNull();
	});
});
