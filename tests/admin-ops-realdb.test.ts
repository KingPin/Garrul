/**
 * Admin operator endpoints against REAL SQLite: the rerender sweep, the
 * dev-only demo seeder, and single-comment moderation.
 *
 * Rerender pages by (created_at, id) and audits only a batch that did work;
 * seed-demo must refuse outside ENV=dev; moderation refuses unknown actions
 * before touching the row.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { CURRENT_RENDERER_VERSION } from "../src/lib/markdown";
import { Hono } from "hono";
import { admin } from "../src/routes/admin";
import { ADMIN_ID, ADMIN_SID, MOD_SID, adminHarness } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

beforeEach(() => installMockCaches());
afterEach(() => uninstallMockCaches());

const seed = (h: ReturnType<typeof adminHarness>, n: number, version = 1) => {
	h.sqlite.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)").run();
	const ins = h.sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, ip_hash, user_agent, created_at, depth)
		 VALUES (?, 'p', NULL, ?, '**hi**', 'stale', ?, 'approved', 'h', 'ua', ?, 0)`,
	);
	for (let i = 0; i < n; i++) ins.run(`c${i}`, ADMIN_ID, version, i + 1);
};

const audits = (h: ReturnType<typeof adminHarness>) =>
	(h.sqlite.prepare("SELECT action, meta FROM audit_log ORDER BY rowid").all() as Array<{
		action: string;
		meta: string;
	}>).map((a) => ({ action: a.action, meta: JSON.parse(a.meta) }));

describe("POST /admin/api/ops/rerender", () => {
	it("re-renders stale rows a page at a time and audits each working batch", async () => {
		const h = adminHarness();
		seed(h, 3);
		const first = await h.request("/admin/api/ops/rerender", { method: "POST", body: { batch: 2 } });
		const page1 = (await first.json()) as { processed: number; next_cursor: unknown };
		expect(page1.processed).toBe(2);
		expect(page1.next_cursor).toBeTruthy();

		const second = await h.request("/admin/api/ops/rerender", {
			method: "POST",
			body: { batch: 2, cursor: page1.next_cursor },
		});
		expect(((await second.json()) as { processed: number }).processed).toBe(1);
		const rows = h.sqlite.prepare("SELECT body_html, renderer_version FROM comments").all() as Array<{
			body_html: string;
			renderer_version: number;
		}>;
		expect(rows.every((r) => r.renderer_version === CURRENT_RENDERER_VERSION)).toBe(true);
		expect(rows[0]?.body_html).toContain("<strong>hi</strong>");

		// Nothing left: no audit row for an empty batch; junk batch/cursor fall back.
		const empty = await h.request("/admin/api/ops/rerender", {
			method: "POST",
			body: { batch: "lots", cursor: { created_at: "x", id: 1 } },
		});
		expect(((await empty.json()) as { processed: number }).processed).toBe(0);
		expect(audits(h).map((a) => [a.action, a.meta.batch_size, a.meta.processed])).toEqual([
			["rerender", 2, 2],
			["rerender", 2, 1],
		]);
	});

	it("is admin-only", async () => {
		const h = adminHarness();
		expect((await h.request("/admin/api/ops/rerender", { method: "POST", body: {}, sid: MOD_SID })).status).toBe(
			403,
		);
	});
});

describe("POST /admin/api/ops/seed-demo", () => {
	it("refuses outside dev without writing", async () => {
		const h = adminHarness({ ENV: "production" });
		const res = await h.request("/admin/api/ops/seed-demo", { method: "POST", body: {} });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "disabled_in_production" });
		expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get()).toEqual({ n: 0 });
	});

	it("seeds demo content in dev and audits the result", async () => {
		// ENV=dev reads the un-prefixed session cookie, which the harness doesn't send.
		const h = adminHarness({ ENV: "dev" });
		const res = await new Hono().route("/admin", admin).request(
			"/admin/api/ops/seed-demo",
			{ method: "POST", headers: { cookie: `garrul_sess=${ADMIN_SID}`, origin: "http://localhost" } },
			h.env as unknown as Record<string, unknown>,
			{ waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		const n = (h.sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
		expect(n).toBeGreaterThan(0);
		const [audit] = audits(h);
		expect(audit?.action).toBe("seed-demo");
		const { ok: _ok, ...result } = body;
		expect(audit?.meta).toEqual(result);
	});
});

describe("POST /admin/api/comments/:id", () => {
	it("moderates one comment, and refuses an unknown action or id", async () => {
		const h = adminHarness();
		seed(h, 1, CURRENT_RENDERER_VERSION);
		const act = (id: string, body: unknown) => h.request(`/admin/api/comments/${id}`, { method: "POST", body });
		expect((await act("c0", { action: "nuke" })).status).toBe(400);
		expect((await act("c0", "not json")).status).toBe(400);

		const res = await act("c0", { action: "spam", reason: "pills" });
		expect(await res.json()).toEqual({ ok: true, id: "c0", status: "spam" });
		expect(h.sqlite.prepare("SELECT status FROM comments WHERE id = 'c0'").get()).toEqual({ status: "spam" });
		expect((await act("nope", { action: "approve" })).status).toBe(404);
	});

	it("lets a mod moderate", async () => {
		const h = adminHarness();
		seed(h, 1, CURRENT_RENDERER_VERSION);
		const res = await h.request("/admin/api/comments/c0", {
			method: "POST",
			body: { action: "delete" },
			sid: MOD_SID,
		});
		expect(res.status).toBe(200);
	});
});
