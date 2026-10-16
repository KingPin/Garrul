/**
 * Bulk moderation at the edge of BULK_ACTION_LIMIT, through a D1 stub that
 * enforces D1's 100-bound-parameter cap. The helper used to bind one `?` per
 * id plus two status binds, so 99 ids was 101 parameters.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminHarness } from "./helpers/admin-sqlite";
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
	return { ids, spamCount, bulk };
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
