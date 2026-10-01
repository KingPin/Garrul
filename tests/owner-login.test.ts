/**
 * Owner login: the issuing helpers (scripts/owner-link.ts) and the redeeming
 * route (POST /admin/owner), against REAL SQLite with every migration applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	OWNER_ROWS_SQL,
	RefuseError,
	classifyOwnerRows,
	clearOldTokensSql,
	insertOwnerSql,
	insertTokenSql,
	newToken,
	resolveBaseUrl,
} from "../scripts/owner-link";
import { OWNER_TOKEN_TTL_MS, hashOwnerToken } from "../src/lib/owner-login";
import { adminHarness } from "./helpers/admin-sqlite";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

const OWNER_ID = "01HOWNER0000000000000000OW";
const HEADERS = { "cf-connecting-ip": "203.0.113.7" };

const setup = () => {
	const h = adminHarness({ IP_HASH_SECRET: "test-secret" });
	h.sqlite.exec(insertOwnerSql(OWNER_ID, Date.now()));
	// `age` shifts the issue time so a token can be born already expired.
	const issue = async (age = 0) => {
		const token = newToken();
		h.sqlite.exec(
			insertTokenSql(OWNER_ID, await hashOwnerToken(token), Date.now() - age),
		);
		return token;
	};
	const redeem = (token: unknown, extra: Record<string, string> = {}) =>
		h.request("/admin/owner", {
			method: "POST",
			body: { token },
			headers: { ...HEADERS, ...extra },
		});
	const unused = () =>
		h.sqlite
			.prepare("SELECT COUNT(*) AS n FROM owner_login_tokens WHERE used_at IS NULL")
			.get();
	return { ...h, issue, redeem, unused };
};

beforeEach(() => {
	installMockCaches();
});
afterEach(() => {
	uninstallMockCaches();
	vi.restoreAllMocks();
});

describe("owner-link helpers", () => {
	it("creates one admin owner row, idempotently", () => {
		const { sqlite } = adminHarness();
		sqlite.exec(insertOwnerSql(OWNER_ID, 1));
		sqlite.exec(insertOwnerSql("01HOWNER0000000000000000O2", 2));
		const rows = sqlite.prepare(OWNER_ROWS_SQL).all() as never[];
		expect(rows).toHaveLength(1);
		expect(classifyOwnerRows(rows)).toEqual({ kind: "ok", id: OWNER_ID });
	});

	it("refuses a banned, demoted or erased owner", () => {
		const base = {
			id: OWNER_ID,
			provider_id: "primary",
			is_admin: 1,
			is_banned: 0,
			role: "admin",
			erased_at: null,
		};
		expect(classifyOwnerRows([])).toEqual({ kind: "none" });
		for (const patch of [
			{ is_banned: 1 },
			{ role: "user", is_admin: 0 },
			{ erased_at: 5, provider_id: null },
		]) {
			expect(() => classifyOwnerRows([{ ...base, ...patch }])).toThrow(RefuseError);
		}
	});

	it("deletes unused and expired tokens but keeps a live used one", () => {
		const { sqlite } = adminHarness();
		sqlite.exec(insertOwnerSql(OWNER_ID, 1));
		const now = Date.now();
		sqlite.exec(insertTokenSql(OWNER_ID, "a".repeat(64), now));
		sqlite.exec(insertTokenSql(OWNER_ID, "b".repeat(64), now));
		sqlite.exec(
			`UPDATE owner_login_tokens SET used_at = ${now} WHERE token_hash = '${"b".repeat(64)}'`,
		);
		sqlite.exec(clearOldTokensSql(OWNER_ID, now));
		expect(sqlite.prepare("SELECT token_hash FROM owner_login_tokens").all()).toEqual([
			{ token_hash: "b".repeat(64) },
		]);
	});

	it("rejects bad ids and hashes before building SQL", () => {
		expect(() => insertTokenSql("x'; DROP TABLE users;--", "a".repeat(64), 1)).toThrow();
		expect(() => insertTokenSql(OWNER_ID, "zz", 1)).toThrow();
	});

	it("refuses the placeholder or empty PUBLIC_BASE_URL", () => {
		const t = (u: string) => `[vars]\nPUBLIC_BASE_URL = "${u}"\n`;
		expect(() => resolveBaseUrl(t("https://comments.example.com"), undefined, false)).toThrow(RefuseError);
		expect(() => resolveBaseUrl(t(""), undefined, false)).toThrow(RefuseError);
		expect(() => resolveBaseUrl(t("http://x.test"), undefined, false)).toThrow(RefuseError);
		expect(resolveBaseUrl(t("https://c.test/"), undefined, false)).toBe("https://c.test");
	});

	it("tokens are 43-char base64url and unique", () => {
		const a = newToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(newToken()).not.toBe(a);
	});
});

describe("GET /admin/owner", () => {
	it("serves the page without consuming a token, with hardening headers", async () => {
		const { request, issue, unused } = setup();
		await issue();
		const res = await request("/admin/owner", { sid: "none" });
		expect(res.status).toBe(200);
		expect(await res.text()).not.toContain("fetch(");
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		const js = await request("/admin/owner/app.js", { sid: "none" });
		expect(js.status).toBe(200);
		const src = await js.text();
		expect(src.indexOf("replaceState")).toBeLessThan(src.indexOf("addEventListener"));
		expect(unused()).toEqual({ n: 1 });
	});
});

describe("POST /admin/owner", () => {
	it("redeems once: sets the session cookie, then rejects a replay", async () => {
		const { issue, redeem, env } = setup();
		const token = await issue();
		const res = await redeem(token);
		expect(res.status).toBe(200);
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("__Host-garrul_sess=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Partitioned");
		expect(res.headers.get("cache-control")).toContain("no-store");
		const sid = /__Host-garrul_sess=([0-9a-f]{64})/.exec(cookie)?.[1];
		const rec = await (env.SESSIONS as unknown as { get(k: string): Promise<string> }).get(
			`sess:${sid}`,
		);
		expect(JSON.parse(rec).user_id).toBe(OWNER_ID);
		const again = await redeem(token);
		expect(again.status).toBe(400);
		expect(await again.json()).toEqual({ error: "sign_in_failed" });
	});

	it("answers wrong, expired and malformed tokens identically", async () => {
		const { issue, redeem } = setup();
		const expired = await issue(OWNER_TOKEN_TTL_MS + 1000);
		const bodies = [];
		const attempts = [newToken(), expired, "short", 42, null];
		for (const [i, t] of attempts.entries()) {
			// Distinct IPs: the route's own limiter (3 per 10s) would answer 429.
			const r = await redeem(t, { "cf-connecting-ip": `203.0.113.${i + 20}` });
			expect(r.status).toBe(400);
			bodies.push(await r.text());
		}
		expect(new Set(bodies).size).toBe(1);
	});

	it("lets exactly one of several simultaneous redemptions win", async () => {
		const { issue, redeem } = setup();
		const token = await issue();
		const rs = await Promise.all([redeem(token), redeem(token), redeem(token)]);
		expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
	});

	it("rejects a banned, demoted or erased owner even with a live token", async () => {
		for (const sql of [
			`UPDATE users SET is_banned = 1 WHERE id = '${OWNER_ID}'`,
			`UPDATE users SET role = 'user', is_admin = 0 WHERE id = '${OWNER_ID}'`,
			`UPDATE users SET erased_at = 1, provider_id = NULL WHERE id = '${OWNER_ID}'`,
		]) {
			const { issue, redeem, sqlite } = setup();
			const token = await issue();
			sqlite.exec(sql);
			const r = await redeem(token);
			expect(r.status).toBe(400);
			expect(r.headers.get("set-cookie")).toBeNull();
		}
	});

	it("leaves the token consumed when session creation fails", async () => {
		const { issue, redeem, env, unused } = setup();
		const token = await issue();
		(env as unknown as { SESSIONS: unknown }).SESSIONS = {
			put: async () => {
				throw new Error("kv down");
			},
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		const r = await redeem(token);
		expect(r.status).toBe(400);
		expect(unused()).toEqual({ n: 0 });
	});

	it("rejects a cross-origin POST without consuming the token", async () => {
		const { issue, redeem, unused } = setup();
		const token = await issue();
		const r = await redeem(token, { origin: "https://evil.test" });
		expect(r.status).toBe(403);
		expect(unused()).toEqual({ n: 1 });
	});

	it("never logs the token", async () => {
		const spies = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		const { issue, redeem } = setup();
		const good = await issue();
		const bad = newToken();
		await redeem(good);
		await redeem(bad);
		const logged = spies.flatMap((s) => s.mock.calls.flat()).join("\n");
		expect(logged).toContain("owner_login");
		expect(logged).not.toContain(good);
		expect(logged).not.toContain(bad);
	});
});
