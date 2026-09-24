/**
 * POST /admin/api/subscriptions/:id against REAL SQLite.
 *
 * `unsubscribe` soft-deletes and audits without the email. `resend` rotates
 * the confirm token only after the mail provider accepts the message, so a
 * failed send leaves the reader's existing link working.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { ADMIN_ID, adminHarness } from "./helpers/admin-sqlite";

const SUB = "01HSUB000000000000000000SB";
const MAIL_ENV = {
	PUBLIC_BASE_URL: "https://comments.example.com",
	EMAIL_FROM: "noreply@example.com",
	EMAIL_PROVIDER: "resend",
	RESEND_API_KEY: "re_test",
};

const setup = (env: Record<string, unknown> = MAIL_ENV, confirmedAt: number | null = null) => {
	const h = adminHarness(env);
	h.sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('hello', 'Hello', NULL, 1)")
		.run();
	h.sqlite
		.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, created_at, confirm_token, confirmed_at)
			 VALUES (?, 'hello', 'reader@example.com', 'unsub-tok', 1, 'old-token', ?)`,
		)
		.run(SUB, confirmedAt);
	const row = () =>
		h.sqlite
			.prepare("SELECT confirm_token, unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(SUB) as { confirm_token: string; unsubscribed_at: number | null };
	const act = (action: string) =>
		h.request(`/admin/api/subscriptions/${SUB}`, { method: "POST", body: { action } });
	return { ...h, row, act };
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("POST /admin/api/subscriptions/:id", () => {
	it("unsubscribes and audits with the post slug only", async () => {
		const { act, row, sqlite } = setup();
		const res = await act("unsubscribe");
		expect(await res.json()).toEqual({ ok: true, id: SUB, status: "unsubscribed" });
		expect(row().unsubscribed_at).not.toBeNull();
		const audit = sqlite
			.prepare("SELECT admin_id, action, meta FROM audit_log")
			.get() as { admin_id: string; action: string; meta: string };
		expect(audit.admin_id).toBe(ADMIN_ID);
		expect(audit.action).toBe("sub.unsubscribe");
		expect(JSON.parse(audit.meta)).toEqual({ post_slug: "hello" });
		// A resend to an unsubscribed row is refused.
		expect((await act("resend")).status).toBe(409);
	});

	it("resends the confirmation and rotates the token on a delivered send", async () => {
		const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const { act, row } = setup();
		const res = await act("resend");
		expect(await res.json()).toEqual({ ok: true, id: SUB, status: "resent" });
		const token = row().confirm_token;
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const sent = JSON.parse(String(init.body));
		expect(sent.to).toEqual(["reader@example.com"]);
		expect(sent.html).toContain(`https://comments.example.com/api/v1/subscribe/confirm/${token}`);
	});

	it("keeps the old token when the provider rejects the send", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
		const { act, row } = setup();
		const res = await act("resend");
		expect(res.status).toBe(502);
		expect(row().confirm_token).toBe("old-token");
	});

	it("refuses resend without mail config, for a confirmed row, and bad input", async () => {
		expect((await setup({}).act("resend")).status).toBe(503);
		const confirmed = setup(MAIL_ENV, 5);
		expect((await confirmed.act("resend")).status).toBe(409);
		expect((await confirmed.act("purge")).status).toBe(400);
		const missing = await confirmed.request("/admin/api/subscriptions/01HNOPE", {
			method: "POST",
			body: { action: "unsubscribe" },
		});
		expect(missing.status).toBe(404);
	});
});
