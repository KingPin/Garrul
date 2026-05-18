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
	clearSession,
	issueSession,
	readSession,
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

	it("readSession returns null for an unknown cookie value", async () => {
		const { ctx } = makeCtx({
			cookieHeader: "garrul_sess=deadbeef".padEnd(72, "0"),
		});
		expect(await readSession(ctx)).toBeNull();
	});

	it("clearSession emits an expiring Set-Cookie", async () => {
		const { ctx, setCookies } = makeCtx({});
		clearSession(ctx);
		expect(setCookies).toHaveLength(1);
		expect(setCookies[0]).toMatch(/Max-Age=0/);
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
