/**
 * Dispatch-path SSRF coverage for the legacy WEBHOOK_URL env shim
 * (issue #14). Table-saved endpoints are validated by checkOutboundUrl
 * on save; the synthesized `_env` endpoint never goes through a save,
 * so its only gate is the checkOutboundUrl call inside postOnce. These
 * tests pin that gate: a private/loopback WEBHOOK_URL must be rejected
 * at dispatch time with no network call.
 *
 * The DB stub returns zero webhook_endpoints rows, which is exactly the
 * condition that triggers the env-shim synthesis in loadEndpoints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dispatchWebhook,
	MAX_DELIVERY_BODY_BYTES,
	type WebhookPayload,
} from "../src/lib/webhook";
import { log } from "../src/lib/log";

// Minimal D1 stub: every .all() returns no rows (no webhook_endpoints
// configured → loadEndpoints synthesizes the env endpoint). The generic
// adapter renders the payload without touching the DB, so nothing else
// is needed.
const emptyDb = {
	prepare() {
		return {
			bind() {
				return this;
			},
			async first() {
				return null;
			},
			async all() {
				return { results: [] };
			},
			async run() {
				return {};
			},
		};
	},
} as unknown as D1Database;

const payload: WebhookPayload = {
	event: "comment.posted",
	comment_id: "01HC000000000000000000",
	post_slug: "hello-world",
	user_id: "01HU000000000000000000",
	ts: 1700000000000,
};

const makeEnv = (webhookUrl: string) => ({
	DB: emptyDb,
	WEBHOOK_URL: webhookUrl,
	ENV: "production",
});

describe("WEBHOOK_URL env shim SSRF guard", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		warnSpy.mockRestore();
	});

	const expectBlocked = async (url: string, reason: string) => {
		await dispatchWebhook(makeEnv(url), payload);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledWith(
			"webhook.failed",
			expect.objectContaining({
				endpoint_id: "_env",
				error: `url:${reason}`,
			}),
		);
	};

	it("rejects an RFC1918/loopback literal with private_ipv4, no network call", async () => {
		await expectBlocked("http://127.0.0.1/hook", "private_ipv4");
	});

	it("rejects a 10.x literal", async () => {
		await expectBlocked("http://10.0.0.5/hook", "private_ipv4");
	});

	it("rejects a 192.168.x literal even over https", async () => {
		await expectBlocked("https://192.168.1.1/hook", "private_ipv4");
	});

	it("rejects localhost by hostname", async () => {
		await expectBlocked("http://localhost:8080/hook", "loopback_host");
	});

	it("rejects an IPv6 loopback literal", async () => {
		await expectBlocked("http://[::1]/hook", "private_ipv6");
	});

	it("rejects internal TLDs", async () => {
		await expectBlocked("https://ci.internal/hook", "internal_tld");
	});

	// Positive controls — prove the harness actually reaches fetch when the
	// URL is allowed, so the blocked cases above aren't passing vacuously.
	it("delivers to a public https URL", async () => {
		await dispatchWebhook(makeEnv("https://example.com/hook"), payload);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.com/hook",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("allows public http:// for the legacy env shim (allowHttp carve-out)", async () => {
		await dispatchWebhook(makeEnv("http://example.com/hook"), payload);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// D1 stub with one enabled generic endpoint row; records every
// webhook_deliveries INSERT so tests can assert whether a retry row was
// queued. Row shape mirrors WebhookEndpointRow (enabled as 0/1, events
// as a comma string or null) so toWebhookEndpoint maps it for real.
const makeDbWithEndpoint = () => {
	const inserts: unknown[][] = [];
	const endpointRow = {
		id: "01HE000000000000000000",
		url: "https://example.com/hook",
		secret: null,
		events: null,
		adapter: "generic",
		enabled: 1,
		fail_count: 0,
		disabled_at: null,
		created_at: 0,
		updated_at: 0,
	};
	const db = {
		prepare(sql: string) {
			let bound: unknown[] = [];
			return {
				bind(...args: unknown[]) {
					bound = args;
					return this;
				},
				async first() {
					return null;
				},
				async all() {
					if (sql.includes("FROM webhook_endpoints")) {
						return { results: [endpointRow] };
					}
					return { results: [] };
				},
				async run() {
					if (sql.includes("INSERT INTO webhook_deliveries")) {
						inserts.push(bound);
					}
					return {};
				},
			};
		},
	} as unknown as D1Database;
	return { db, inserts };
};

describe("webhook_deliveries body cap (issue #13)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Receiver always fails → dispatch wants to queue a retry row.
		fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		warnSpy.mockRestore();
	});

	it("queues a retry row for a normal-sized body", async () => {
		const { db, inserts } = makeDbWithEndpoint();
		await dispatchWebhook({ DB: db, ENV: "production" }, payload);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(inserts).toHaveLength(1);
	});

	it("skips the retry queue for an oversized body but still POSTs inline", async () => {
		const { db, inserts } = makeDbWithEndpoint();
		// Generic adapter stringifies the payload verbatim, so a huge slug
		// pushes the rendered body past the cap.
		const fat: WebhookPayload = {
			...payload,
			post_slug: "x".repeat(MAX_DELIVERY_BODY_BYTES + 1024),
		};
		await dispatchWebhook({ DB: db, ENV: "production" }, fat);
		expect(fetchMock).toHaveBeenCalledTimes(1); // inline attempt still fires
		expect(inserts).toHaveLength(0); // but nothing persisted
		expect(warnSpy).toHaveBeenCalledWith(
			"webhook.delivery_body_too_large",
			expect.objectContaining({
				max_bytes: MAX_DELIVERY_BODY_BYTES,
				body_bytes: expect.any(Number),
			}),
		);
	});

	it("reports body_bytes on every failure log line", async () => {
		const { db } = makeDbWithEndpoint();
		await dispatchWebhook({ DB: db, ENV: "production" }, payload);
		expect(warnSpy).toHaveBeenCalledWith(
			"webhook.failed",
			expect.objectContaining({ body_bytes: expect.any(Number) }),
		);
	});
});

// D1 stub: one enabled *discord* endpoint plus comment/user/post rows so
// the adapter's loadContext can build links. Proves the PUBLIC_BASE_URL →
// dispatch → renderBody → adapter threading actually reaches the wire,
// not just the typechecker.
const makeDbForDiscord = () => {
	const endpointRow = {
		id: "01HE000000000000000000",
		url: "https://example.com/hook",
		secret: null,
		events: null,
		adapter: "discord",
		enabled: 1,
		fail_count: 0,
		disabled_at: null,
		created_at: 0,
		updated_at: 0,
	};
	return {
		prepare(sql: string) {
			return {
				bind() {
					return this;
				},
				async first() {
					if (sql.includes("FROM comments")) {
						return {
							id: "01HC000000000000000000",
							post_slug: "hello-world",
							body_md: "Nice post!",
							status: "approved",
							user_id: "01HU000000000000000000",
							created_at: 0,
						};
					}
					if (sql.includes("FROM users")) {
						return { id: "01HU000000000000000000", name: "Alice", avatar_url: null };
					}
					if (sql.includes("FROM posts")) {
						return {
							slug: "hello-world",
							title: "Hello, world!",
							url: "https://blog.example.com/p",
							created_at: 0,
						};
					}
					return null;
				},
				async all() {
					if (sql.includes("FROM webhook_endpoints")) {
						return { results: [endpointRow] };
					}
					return { results: [] };
				},
				async run() {
					return {};
				},
			};
		},
	} as unknown as D1Database;
};

describe("discord adapter dispatch threads PUBLIC_BASE_URL to the wire", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("POSTs an embed body carrying the admin + page links", async () => {
		await dispatchWebhook(
			{
				DB: makeDbForDiscord(),
				ENV: "production",
				PUBLIC_BASE_URL: "https://comments.example.com",
			},
			payload,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(Array.isArray(body.embeds)).toBe(true);
		const links = body.embeds[0].fields[0].value;
		expect(links).toContain(
			"https://comments.example.com/admin/comments/01HC000000000000000000",
		);
		expect(links).toContain("https://blog.example.com/p");
	});
});

// A telegram endpoint's real target is https://api.telegram.org/bot<TOKEN>/…,
// so the bot token is in the request URL. Some runtimes echo the URL back in a
// fetch error string — this pins that such a string is scrubbed before it can
// reach the failure log (CLAUDE.md: never log the token).
const makeDbForTelegram = () => {
	const endpointRow = {
		id: "01HE000000000000000000",
		url: "-1001234567890", // chat id, not a URL
		secret: null,
		events: null,
		adapter: "telegram",
		enabled: 1,
		fail_count: 0,
		disabled_at: null,
		created_at: 0,
		updated_at: 0,
	};
	return {
		prepare(sql: string) {
			return {
				bind() {
					return this;
				},
				async first() {
					if (sql.includes("FROM comments")) {
						return {
							id: "01HC000000000000000000",
							post_slug: "hello-world",
							body_md: "Nice post!",
							status: "approved",
							user_id: "01HU000000000000000000",
							created_at: 0,
						};
					}
					if (sql.includes("FROM users")) {
						return { id: "01HU000000000000000000", name: "Alice", avatar_url: null };
					}
					if (sql.includes("FROM posts")) {
						return { slug: "hello-world", title: "Hi", url: null, created_at: 0 };
					}
					return null;
				},
				async all() {
					if (sql.includes("FROM webhook_endpoints")) {
						return { results: [endpointRow] };
					}
					return { results: [] };
				},
				async run() {
					return {};
				},
			};
		},
	} as unknown as D1Database;
};

describe("telegram dispatch never logs the bot token", () => {
	const TOKEN = "123456789:AA-secret-bot-token-do-not-log";
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// fetch throws an error whose message embeds the full request URL — the
		// worst-case runtime behavior we defend against.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				throw new Error(`request to ${url} failed`);
			}),
		);
		warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		warnSpy.mockRestore();
	});

	it("scrubs the token from the failure log's error field", async () => {
		await dispatchWebhook(
			{ DB: makeDbForTelegram(), ENV: "production", TELEGRAM_BOT_TOKEN: TOKEN },
			payload,
		);
		const failCall = warnSpy.mock.calls.find((c) => c[0] === "webhook.failed");
		expect(failCall).toBeDefined();
		const logged = JSON.stringify(failCall?.[1]);
		expect(logged).not.toContain(TOKEN);
		expect(failCall?.[1]).toMatchObject({ error: expect.stringContaining("***") });
	});
});
