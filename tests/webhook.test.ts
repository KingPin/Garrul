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
import { dispatchWebhook, type WebhookPayload } from "../src/lib/webhook";
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
