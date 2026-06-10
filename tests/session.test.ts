/**
 * Session cookie round-trip — covers the critical-path claim in the
 * plan that "auth cookie roundtrip" is on the test bar. Exercises
 * src/lib/session.ts: issue → read → clear.
 *
 * We don't spin Miniflare; the surface area is small enough that a
 * stub KV + a stub Hono-shaped context is more faithful (and faster)
 * than a worker fixture.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
	destroySession,
	issueSession,
	readSession,
	revokeSession,
} from "../src/lib/session";

class StubKV {
	store = new Map<string, { value: string; expiresAt: number }>();
	async get(key: string): Promise<string | null> {
		const row = this.store.get(key);
		if (!row) return null;
		if (row.expiresAt < Date.now()) {
			this.store.delete(key);
			return null;
		}
		return row.value;
	}
	async put(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void> {
		const ttl = opts?.expirationTtl ?? 60 * 60;
		this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
	}
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}

type CtxLike = Parameters<typeof issueSession>[0];

const makeCtx = (opts: {
	env?: string;
	cookieHeader?: string;
}): {
	ctx: CtxLike;
	kv: StubKV;
	setCookies: string[];
} => {
	const kv = new StubKV();
	const setCookies: string[] = [];
	const ctx: CtxLike = {
		env: {
			SESSIONS: kv as unknown as KVNamespace,
			ENV: opts.env ?? "prod",
		},
		req: {
			header: (name: string) =>
				name.toLowerCase() === "cookie" ? opts.cookieHeader : undefined,
		},
		header: (name: string, value: string) => {
			if (name.toLowerCase() === "set-cookie") setCookies.push(value);
		},
	};
	return { ctx, kv, setCookies };
};

const extractCookieValue = (setCookie: string): string => {
	const first = setCookie.split(";", 1)[0] ?? "";
	const eq = first.indexOf("=");
	return first.slice(eq + 1);
};

describe("session cookie roundtrip", () => {
	let userId: string;
	beforeEach(() => {
		userId = "01HXXXXXXXXXXXXXXXXXXXXXXX";
	});

	it("issueSession → readSession round-trips the user_id", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		expect(setCookies).toHaveLength(1);
		const sidValue = extractCookieValue(setCookies[0]!);
		expect(sidValue).toMatch(/^[0-9a-f]{64}$/);

		const { ctx: readCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		const session = await readSession(readCtx);
		expect(session?.user_id).toBe(userId);
		expect(session?.sid).toBe(sidValue);
	});

	it("readSession returns null when no cookie sent", async () => {
		const { ctx } = makeCtx({});
		expect(await readSession(ctx)).toBeNull();
	});

	it("malformed percent-encoding in the cookie is treated as no session", async () => {
		const { ctx, setCookies } = makeCtx({
			cookieHeader: "garrul_sess=%E0%A4%A",
		});
		expect(await readSession(ctx)).toBeNull();
		// destroySession must not throw either — it still expires the cookie.
		await destroySession(ctx);
		expect(setCookies[0]).toMatch(/Max-Age=0/);
	});

	it("a malformed cookie cannot shadow a valid same-name cookie", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);

		// A garbage first occurrence must not stop us reaching the real sid.
		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=%E0%A4%A; garrul_sess=${sidValue}`,
		});
		await destroySession(ctx);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(false);
	});

	it("an oversized cookie value does not throw on signout", async () => {
		// >512-byte KV keys throw; a too-long sid must be rejected before the
		// delete so a corrupted cookie can't make signout un-completable.
		const { ctx, setCookies } = makeCtx({
			cookieHeader: `garrul_sess=${"a".repeat(600)}`,
		});
		await destroySession(ctx);
		expect(setCookies[0]).toMatch(/Max-Age=0/);
	});

	it("readSession returns null for an unknown cookie value", async () => {
		const { ctx } = makeCtx({
			cookieHeader: "garrul_sess=deadbeef".padEnd(72, "0"),
		});
		expect(await readSession(ctx)).toBeNull();
	});

	it("destroySession emits an expiring Set-Cookie", async () => {
		const { ctx, setCookies } = makeCtx({});
		await destroySession(ctx);
		expect(setCookies).toHaveLength(1);
		expect(setCookies[0]).toMatch(/Max-Age=0/);
	});

	it("destroySession deletes the KV record so the sid cannot be replayed", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(true);

		const { ctx: signoutCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		await destroySession(signoutCtx);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(false);

		// A retained copy of the cookie is now inert server-side.
		const { ctx: replayCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		expect(await readSession(replayCtx)).toBeNull();
	});

	it("revokeSession deletes the KV record without touching the cookie", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);

		const { ctx, setCookies: revokeCookies } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		await revokeSession(ctx);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(false);
		// Unlike destroySession, revoke leaves the cookie alone — re-login
		// overwrites it with a fresh Set-Cookie immediately after.
		expect(revokeCookies).toHaveLength(0);
	});

	it("does not re-write the KV record on an immediate re-read", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		const before = kv.store.get(`sess:${sidValue}`)!.value;

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		expect((await readSession(ctx))?.user_id).toBe(userId);
		// Fresh record is well within the refresh interval → no wasted KV write.
		expect(kv.store.get(`sess:${sidValue}`)!.value).toBe(before);
	});

	it("slides the TTL once the record has aged past the refresh interval", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		const key = `sess:${sidValue}`;
		const row = kv.store.get(key)!;
		// Age the record two days (expires_at two days closer than a fresh one).
		kv.store.set(key, {
			value: JSON.stringify({
				user_id: userId,
				expires_at: Date.now() + (30 - 2) * 24 * 60 * 60 * 1000,
			}),
			expiresAt: row.expiresAt,
		});

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		expect((await readSession(ctx))?.user_id).toBe(userId);
		const refreshed = JSON.parse(kv.store.get(key)!.value) as {
			expires_at: number;
		};
		// Aged record → refreshed back toward a full 30-day expiry.
		expect(refreshed.expires_at).toBeGreaterThan(
			Date.now() + (30 - 1) * 24 * 60 * 60 * 1000,
		);
	});

	it("expired session record is purged on read", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		const key = `sess:${sidValue}`;
		const row = kv.store.get(key);
		expect(row).toBeTruthy();
		// Tamper: rewrite the JSON value with a past expires_at.
		kv.store.set(key, {
			value: JSON.stringify({ user_id: userId, expires_at: Date.now() - 1000 }),
			expiresAt: row!.expiresAt,
		});

		const { ctx: readCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		expect(await readSession(readCtx)).toBeNull();
		// And the KV row is gone (so the stale cookie is inert next time too).
		expect(kv.store.has(key)).toBe(false);
	});

	it("malformed KV record is purged on read", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		const key = `sess:${sidValue}`;
		kv.store.set(key, {
			value: "{not-json",
			expiresAt: Date.now() + 60_000,
		});

		const { ctx: readCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `garrul_sess=${sidValue}`,
		});
		expect(await readSession(readCtx)).toBeNull();
		expect(kv.store.has(key)).toBe(false);
	});

	it("prod env emits SameSite=None; Secure; Partitioned", async () => {
		const { ctx, setCookies } = makeCtx({ env: "prod" });
		await issueSession(ctx, userId);
		const sc = setCookies[0]!;
		expect(sc).toMatch(/SameSite=None/);
		expect(sc).toMatch(/Secure/);
		expect(sc).toMatch(/Partitioned/);
		expect(sc).toMatch(/HttpOnly/);
	});

	it("dev env emits SameSite=Lax without Secure/Partitioned", async () => {
		const { ctx, setCookies } = makeCtx({ env: "dev" });
		await issueSession(ctx, userId);
		const sc = setCookies[0]!;
		expect(sc).toMatch(/SameSite=Lax/);
		expect(sc).not.toMatch(/Secure/);
		expect(sc).not.toMatch(/Partitioned/);
	});
});

const makeCtxWithSameKv = (
	kv: StubKV,
	opts: { cookieHeader?: string },
): { ctx: CtxLike; kv: StubKV; setCookies: string[] } => {
	const setCookies: string[] = [];
	const ctx: CtxLike = {
		env: { SESSIONS: kv as unknown as KVNamespace, ENV: "prod" },
		req: {
			header: (name: string) =>
				name.toLowerCase() === "cookie" ? opts.cookieHeader : undefined,
		},
		header: (name: string, value: string) => {
			if (name.toLowerCase() === "set-cookie") setCookies.push(value);
		},
	};
	return { ctx, kv, setCookies };
};
