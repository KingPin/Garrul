/**
 * Version-check cache and behind-detection logic. The middleware is gated
 * to /admin/* so the cache stays warm between admin hits; tests drive the
 * exported pure functions directly with a KV stub and a mocked fetch.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
	getCachedLatestVersion,
	peekCachedLatestVersion,
} from "../src/lib/version-check";

vi.mock("../src/lib/version.gen", () => ({
	CURRENT_VERSION: "0.0.1",
	REPO_OWNER: "kingpin",
	REPO_NAME: "garrul",
}));

const warnSpy = vi.fn();
vi.mock("../src/lib/log", () => ({
	log: {
		warn: (...args: unknown[]) => warnSpy(...args),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

class StubKV {
	store = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}
	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}
}

const makeEnv = () =>
	({ TREE_CACHE: new StubKV() as unknown as KVNamespace }) as {
		TREE_CACHE: KVNamespace;
	};

const okResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

const errResponse = (status: number) =>
	new Response("error", { status });

describe("version-check", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		warnSpy.mockClear();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("hits GitHub once on cold cache, reuses on warm cache", async () => {
		const env = makeEnv();
		fetchMock.mockResolvedValueOnce(
			okResponse({
				tag_name: "v0.0.2",
				html_url: "https://github.com/kingpin/garrul/releases/tag/v0.0.2",
			}),
		);

		const first = await getCachedLatestVersion(env);
		const second = await getCachedLatestVersion(env);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(first?.latest).toBe("v0.0.2");
		expect(second?.latest).toBe("v0.0.2");
		expect(first?.behind).toBe(true);
	});

	it("caches a null marker on GitHub 5xx and backs off", async () => {
		const env = makeEnv();
		fetchMock.mockResolvedValueOnce(errResponse(503));

		const first = await getCachedLatestVersion(env);
		const second = await getCachedLatestVersion(env);

		expect(first).toBeNull();
		expect(second).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith(
			"version_check.failed",
			expect.objectContaining({ status: 503 }),
		);
	});

	it("reports behind=false when current matches latest", async () => {
		const env = makeEnv();
		fetchMock.mockResolvedValueOnce(
			okResponse({
				tag_name: "v0.0.1",
				html_url: "https://github.com/kingpin/garrul/releases/tag/v0.0.1",
			}),
		);

		const info = await getCachedLatestVersion(env);
		expect(info?.behind).toBe(false);
	});

	it("strips the v-prefix when comparing semver", async () => {
		const env = makeEnv();
		fetchMock.mockResolvedValueOnce(
			okResponse({
				tag_name: "0.1.0",
				html_url: "https://github.com/kingpin/garrul/releases/tag/0.1.0",
			}),
		);
		const info = await getCachedLatestVersion(env);
		expect(info?.behind).toBe(true);
		expect(info?.latest).toBe("0.1.0");
	});

	it("peek never triggers a fetch", async () => {
		const env = makeEnv();
		const cold = await peekCachedLatestVersion(env);
		expect(cold).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();

		// Populate the cache via the real path.
		fetchMock.mockResolvedValueOnce(
			okResponse({
				tag_name: "v0.0.2",
				html_url: "https://github.com/kingpin/garrul/releases/tag/v0.0.2",
			}),
		);
		await getCachedLatestVersion(env);

		const warm = await peekCachedLatestVersion(env);
		expect(warm?.latest).toBe("v0.0.2");
	});

	it("treats a malformed GitHub payload as a failure", async () => {
		const env = makeEnv();
		fetchMock.mockResolvedValueOnce(okResponse({ unexpected: "shape" }));
		const info = await getCachedLatestVersion(env);
		expect(info).toBeNull();
		expect(warnSpy).toHaveBeenCalledWith("version_check.malformed");
	});
});
