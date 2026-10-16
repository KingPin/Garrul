/**
 * Bulk moderation at the edge of BULK_ACTION_LIMIT, through a D1 stub that
 * enforces D1's 100-bound-parameter cap. The helper used to bind one `?` per
 * id plus two status binds, so 99 ids was 101 parameters.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comments } from "../src/routes/api.comments";
import { ADMIN_ID, adminHarness } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

beforeEach(() => installMockCaches());
afterEach(() => uninstallMockCaches());

const seeded = (n: number) => {
	const h = adminHarness();
	h.sqlite.exec(
		"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u1', 'anon', NULL, 'Ann', 1)",
	);
	h.sqlite.exec("INSERT INTO posts (slug, title, url, created_at) VALUES ('p', 'P', NULL, 1)");
	const ins = h.sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, status, created_at, depth)
		 VALUES (?, 'p', NULL, 'u1', 'x', '<p>x</p>', 'approved', ?, 1)`,
	);
	const ids = Array.from({ length: n }, (_, i) => `c${String(i).padStart(4, "0")}`);
	for (const [i, id] of ids.entries()) ins.run(id, i + 1);
	const spamCount = () =>
		(h.sqlite.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'spam'").get() as {
			n: number;
		}).n;
	const bulk = (body: unknown) =>
		h.request("/admin/api/comments/bulk", { method: "POST", body });
	return { h, ids, spamCount, bulk };
};

describe("POST /admin/api/comments/bulk — parameter cap", () => {
	for (const n of [99, 100]) {
		it(`spams ${n} ids in one request`, async () => {
			const { ids, spamCount, bulk } = seeded(n);
			const res = await bulk({ ids, action: "spam" });
			expect(res.status).toBe(200);
			expect(spamCount()).toBe(n);
		});
	}

	it("still refuses 101 ids with too_many and changes nothing", async () => {
		const { ids, spamCount, bulk } = seeded(101);
		const res = await bulk({ ids, action: "spam" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "too_many" });
		expect(spamCount()).toBe(0);
	});
});

// D1 allows 50 queries per Worker invocation on the Free plan, and the old
// route ran three per id (comment read, audit insert, webhook endpoint load).
describe("POST /admin/api/comments/bulk — fixed query count", () => {
	const countedBulk = async (n: number) => {
		const s = seeded(n);
		const db = s.h.env.DB as unknown as { prepare: (sql: string) => unknown };
		const real = db.prepare.bind(db);
		let queries = 0;
		db.prepare = (sql: string) => {
			queries++;
			return real(sql);
		};
		const res = await s.bulk({ ids: s.ids, action: "spam" });
		expect(res.status).toBe(200);
		// Let the waitUntil'd webhook dispatch reach its endpoint load.
		await new Promise((r) => setTimeout(r, 0));
		return { ...s, res, queries };
	};

	it("runs the same number of D1 queries at 3 ids and at 100", async () => {
		const small = await countedBulk(3);
		const big = await countedBulk(100);
		expect(big.queries).toBe(small.queries);

		expect(await big.res.json()).toEqual({ ok: true, status: "spam", touched: big.ids });
		expect(big.spamCount()).toBe(100);
		const audits = big.h.sqlite
			.prepare("SELECT admin_id, action, target_kind, target_id, reason, meta FROM audit_log ORDER BY target_id")
			.all();
		expect(audits).toEqual(
			big.ids.map((id) => ({
				admin_id: ADMIN_ID,
				action: "bulk.spam",
				target_kind: "comment",
				target_id: id,
				reason: null,
				meta: JSON.stringify({ batch_size: 100, new_status: "spam" }),
			})),
		);
	});

	it("fires one webhook per comment from a single endpoint load", async () => {
		const { h, ids, bulk } = seeded(3);
		h.sqlite.exec(
			"INSERT INTO webhook_endpoints (id, url, created_at, updated_at) VALUES ('w1', 'https://hooks.example.com/x', 1, 1)",
		);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok", { status: 200 }));
		try {
			expect((await bulk({ ids, action: "spam" })).status).toBe(200);
			await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
			const bodies = fetchSpy.mock.calls.map(([, init]) => {
				const { ts, ...rest } = JSON.parse(String(init?.body));
				expect(typeof ts).toBe("number");
				return rest;
			});
			expect(bodies).toEqual(
				ids.map((id) => ({ event: "comment.spam", comment_id: id, post_slug: "p", user_id: "u1" })),
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rolls back the status change when the audit insert fails", async () => {
		const { h, ids, spamCount, bulk } = seeded(3);
		h.sqlite.exec(
			"CREATE TRIGGER boom BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'boom'); END",
		);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await bulk({ ids, action: "spam" })).status).toBe(500);
		} finally {
			spy.mockRestore();
		}
		expect(spamCount()).toBe(0);
	});
});

// The bulk path once left deleted_by NULL, so the tree read a bulk-deleted
// spam parent as an author delete and returned its real author.
describe("POST /admin/api/comments/bulk — delete keeps a hidden parent masked", () => {
	it("bulk-deleting a spam parent with an approved reply leaves an anonymous placeholder", async () => {
		const { h, bulk } = seeded(0);
		h.sqlite.exec(
			"INSERT INTO users (id, provider, provider_id, name, created_at) VALUES ('u2', 'github', '9', 'Hidden Author', 1)",
		);
		h.sqlite.exec(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html, status, created_at, depth)
			 VALUES ('root', 'p', NULL, 'u2', 'x', '<p>x</p>', 'spam', 1, 1),
			        ('kid', 'p', 'root', 'u1', 'y', '<p>y</p>', 'approved', 2, 2)`,
		);
		expect((await bulk({ ids: ["root"], action: "delete" })).status).toBe(200);

		const app = new Hono().route("/", comments);
		const res = await app.request("/?slug=p", {}, h.env as unknown as Record<string, unknown>);
		expect(res.status).toBe(200);
		const page = (await res.json()) as { threads: Record<string, unknown>[] };
		expect(page.threads[0]).toMatchObject({
			id: "root",
			status: "deleted",
			deleted_by: "moderator",
			author: { id: "", name: "[deleted]" },
		});
		expect(JSON.stringify(page)).not.toContain("Hidden Author");
	});
});
