/**
 * Session cookie round-trip — covers the critical-path claim in the
 * plan that "auth cookie roundtrip" is on the test bar. Exercises
 * src/lib/session.ts: issue → read → clear.
 *
 * We don't spin Miniflare; the surface area is small enough that a
 * stub KV + a stub Hono-shaped context is more faithful (and faster)
 * than a worker fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	destroySession,
	issueSession,
	readSession,
	revokeOtherSessions,
	revokeSession,
	revokeUserSessions,
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
	// Counted so a test can prove readSession did *not* re-write the record —
	// the sliding TTL is the reason a ban needs a revocation stamp at all.
	puts = 0;
	async put(
		key: string,
		value: string,
		opts?: { expirationTtl?: number },
	): Promise<void> {
		this.puts++;
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
		// Two headers in production: the session cookie, then an expiry for the
		// pre-`__Host-` name so upgraded installs don't keep a dead cookie around.
		expect(setCookies).toHaveLength(2);
		expect(setCookies[0]).toContain("__Host-garrul_sess=");
		expect(setCookies[1]).toMatch(/^garrul_sess=; .*Max-Age=0/);
		const sidValue = extractCookieValue(setCookies[0]!);
		expect(sidValue).toMatch(/^[0-9a-f]{64}$/);

		const { ctx: readCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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
			cookieHeader: "__Host-garrul_sess=%E0%A4%A",
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
			cookieHeader: `__Host-garrul_sess=%E0%A4%A; __Host-garrul_sess=${sidValue}`,
		});
		await destroySession(ctx);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(false);
	});

	it("an oversized cookie value does not throw on signout", async () => {
		// >512-byte KV keys throw; a too-long sid must be rejected before the
		// delete so a corrupted cookie can't make signout un-completable.
		const { ctx, setCookies } = makeCtx({
			cookieHeader: `__Host-garrul_sess=${"a".repeat(600)}`,
		});
		await destroySession(ctx);
		expect(setCookies[0]).toMatch(/Max-Age=0/);
	});

	it("readSession returns null for an unknown cookie value", async () => {
		const { ctx } = makeCtx({
			cookieHeader: "__Host-garrul_sess=deadbeef".padEnd(72, "0"),
		});
		expect(await readSession(ctx)).toBeNull();
	});

	it("destroySession emits an expiring Set-Cookie", async () => {
		const { ctx, setCookies } = makeCtx({});
		await destroySession(ctx);
		expect(setCookies).toHaveLength(2);
		expect(setCookies[0]).toMatch(/^__Host-garrul_sess=; .*Max-Age=0/);
		expect(setCookies[1]).toMatch(/^garrul_sess=; .*Max-Age=0/);
	});

	it("destroySession deletes the KV record so the sid cannot be replayed", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(true);

		const { ctx: signoutCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
		});
		await destroySession(signoutCtx);
		expect(kv.store.has(`sess:${sidValue}`)).toBe(false);

		// A retained copy of the cookie is now inert server-side.
		const { ctx: replayCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
		});
		expect(await readSession(replayCtx)).toBeNull();
	});

	it("revokeSession deletes the KV record without touching the cookie", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		await issueSession(issueCtx, userId);
		const sidValue = extractCookieValue(setCookies[0]!);

		const { ctx, setCookies: revokeCookies } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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
			cookieHeader: `__Host-garrul_sess=${sidValue}`,
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

	/**
	 * `__Host-` is what makes the browser refuse a same-name cookie set by a
	 * sibling subdomain with a `Domain=` attribute. Without it, script on any
	 * host under the operator's eTLD+1 can plant a session id of its choosing and
	 * parseCookie may return that one instead — session fixation against the
	 * documented `comments.<yourdomain>` layout.
	 */
	describe("__Host- prefix", () => {
		it("prefixes the cookie in production, with the attributes the prefix requires", async () => {
			const { ctx, setCookies } = makeCtx({ env: "prod" });
			await issueSession(ctx, userId);
			const sc = setCookies[0]!;
			expect(sc.startsWith("__Host-garrul_sess=")).toBe(true);
			expect(sc).toMatch(/Path=\//);
			expect(sc).toMatch(/Secure/);
			expect(sc).not.toMatch(/Domain=/);
		});

		it("drops the prefix in dev, where Secure is unavailable over plain HTTP", async () => {
			const { ctx, setCookies } = makeCtx({ env: "dev" });
			await issueSession(ctx, userId);
			expect(setCookies[0]!.startsWith("garrul_sess=")).toBe(true);
			// No legacy expiry either — dev never renamed anything.
			expect(setCookies).toHaveLength(1);
		});

		it("ignores an unprefixed cookie in production", async () => {
			const { ctx: issueCtx, kv, setCookies } = makeCtx({ env: "prod" });
			await issueSession(issueCtx, userId);
			const sidValue = extractCookieValue(setCookies[0]!);

			// Exactly the shape a sibling subdomain can plant. Accepting it as a
			// fallback would keep the fixation path open, so it must not resolve
			// even though the sid itself is real.
			const { ctx } = makeCtxWithSameKv(kv, {
				cookieHeader: `garrul_sess=${sidValue}`,
			});
			expect(await readSession(ctx)).toBeNull();
		});

		it("still resolves the prefixed cookie when an unprefixed one is also present", async () => {
			const { ctx: issueCtx, kv, setCookies } = makeCtx({ env: "prod" });
			await issueSession(issueCtx, userId);
			const sidValue = extractCookieValue(setCookies[0]!);

			const { ctx } = makeCtxWithSameKv(kv, {
				cookieHeader: `garrul_sess=deadbeef; __Host-garrul_sess=${sidValue}`,
			});
			expect((await readSession(ctx))?.user_id).toBe(userId);
		});
	});
});

/**
 * Session revocation on ban. There is no reverse index from user to sessions, so
 * a ban stamps a per-user epoch and readSession compares it to the session's
 * immutable `issued_at`.
 */
describe("session revocation epoch", () => {
	const userId = "01HXXXXXXXXXXXXXXXXXXXXXXX";

	// Rewrite the stored record's issued_at so the before/after relationship to a
	// revocation stamp is deterministic — a real ban and a real login can land in
	// the same millisecond.
	const setIssuedAt = (kv: StubKV, sid: string, issuedAt: number): void => {
		const key = `sess:${sid}`;
		const row = kv.store.get(key)!;
		const record = JSON.parse(row.value) as Record<string, unknown>;
		record.issued_at = issuedAt;
		kv.store.set(key, {
			value: JSON.stringify(record),
			expiresAt: row.expiresAt,
		});
	};

	const issue = async (): Promise<{ kv: StubKV; sid: string }> => {
		const { ctx, kv, setCookies } = makeCtx({});
		await issueSession(ctx, userId);
		return { kv, sid: extractCookieValue(setCookies[0]!) };
	};

	it("issueSession stamps an issued_at that never moves", async () => {
		const { kv, sid } = await issue();
		const record = JSON.parse(kv.store.get(`sess:${sid}`)!.value) as {
			issued_at: number;
			expires_at: number;
		};
		expect(record.issued_at).toBeGreaterThan(0);
		expect(record.expires_at).toBeGreaterThan(record.issued_at);
	});

	it("rejects a session issued before the ban and deletes its record", async () => {
		const { kv, sid } = await issue();
		setIssuedAt(kv, sid, Date.now() - 5_000);
		await revokeUserSessions({ SESSIONS: kv as unknown as KVNamespace }, userId);

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect(await readSession(ctx)).toBeNull();
		// Purged, so the cookie is inert without paying the extra read next time.
		expect(kv.store.has(`sess:${sid}`)).toBe(false);
	});

	it("keeps a session issued after the ban (re-login after unban)", async () => {
		const { ctx: issueCtx, kv, setCookies } = makeCtx({});
		// Stamp first, dated in the past, then log in.
		await kv.put(`sessrev:${userId}`, String(Date.now() - 5_000));
		await issueSession(issueCtx, userId);
		const sid = extractCookieValue(setCookies[0]!);

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect((await readSession(ctx))?.user_id).toBe(userId);
		expect(kv.store.has(`sess:${sid}`)).toBe(true);
	});

	it("kills a legacy record that predates issued_at", async () => {
		const { kv, sid } = await issue();
		const key = `sess:${sid}`;
		const row = kv.store.get(key)!;
		// Exactly the shape written before this field existed.
		kv.store.set(key, {
			value: JSON.stringify({
				user_id: userId,
				expires_at: Date.now() + 29 * 24 * 60 * 60 * 1000,
			}),
			expiresAt: row.expiresAt,
		});
		await revokeUserSessions({ SESSIONS: kv as unknown as KVNamespace }, userId);

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect(await readSession(ctx)).toBeNull();
		expect(kv.store.has(key)).toBe(false);
	});

	it("fails closed on an unparseable stamp", async () => {
		const { kv, sid } = await issue();
		await kv.put(`sessrev:${userId}`, "not-a-timestamp");

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect(await readSession(ctx)).toBeNull();
		expect(kv.store.has(`sess:${sid}`)).toBe(false);
	});

	it("does not slide the TTL of a session it is about to revoke", async () => {
		const { kv, sid } = await issue();
		const key = `sess:${sid}`;
		const row = kv.store.get(key)!;
		// Age it past the refresh interval so an unrevoked read *would* re-write.
		kv.store.set(key, {
			value: JSON.stringify({
				user_id: userId,
				issued_at: Date.now() - 2 * 24 * 60 * 60 * 1000,
				expires_at: Date.now() + (30 - 2) * 24 * 60 * 60 * 1000,
			}),
			expiresAt: row.expiresAt,
		});
		await revokeUserSessions({ SESSIONS: kv as unknown as KVNamespace }, userId);
		const putsBefore = kv.puts;

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect(await readSession(ctx)).toBeNull();
		// A revoked session must never cost a KV write on its way out.
		expect(kv.puts).toBe(putsBefore);
	});

	it("a stamp for another user leaves this session alone", async () => {
		const { kv, sid } = await issue();
		setIssuedAt(kv, sid, Date.now() - 5_000);
		await revokeUserSessions(
			{ SESSIONS: kv as unknown as KVNamespace },
			"01HOTHERUSER00000000000000",
		);

		const { ctx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${sid}`,
		});
		expect((await readSession(ctx))?.user_id).toBe(userId);
	});

	it("the stamp expires with the longest possible session", async () => {
		const { kv } = await issue();
		await revokeUserSessions({ SESSIONS: kv as unknown as KVNamespace }, userId);
		const row = kv.store.get(`sessrev:${userId}`)!;
		// 30 days — a stamp outliving every session it could revoke is dead weight.
		expect(row.expiresAt).toBeGreaterThan(
			Date.now() + 29 * 24 * 60 * 60 * 1000,
		);
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

describe("revokeOtherSessions (sign out everywhere else)", () => {
	const userId = "01HUSER0000000000000000USR";

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("kills every other session but hands the caller a survivor, even on a frozen clock", async () => {
		// Workers freeze Date.now() during synchronous work; pin it so the test
		// reproduces the worst case — stamp and mint in the same millisecond.
		const T = 1_900_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(T);

		const { ctx: otherCtx, kv, setCookies: otherCookies } = makeCtx({});
		await issueSession(otherCtx, userId); // the "stolen" session, issued_at = T
		const otherSid = extractCookieValue(otherCookies[0]!);
		const { ctx: callerIssueCtx, setCookies: callerCookies } =
			makeCtxWithSameKv(kv, {});
		await issueSession(callerIssueCtx, userId);
		const callerSid = extractCookieValue(callerCookies[0]!);

		const { ctx: revokeCtx, setCookies: revokeCookies } = makeCtxWithSameKv(
			kv,
			{ cookieHeader: `__Host-garrul_sess=${callerSid}` },
		);
		await revokeOtherSessions(revokeCtx, userId);

		// The stamp landed, and the replacement postdates it strictly.
		expect(kv.store.get(`sessrev:${userId}`)!.value).toBe(String(T));
		const newSid = extractCookieValue(revokeCookies[0]!);
		const newRecord = JSON.parse(kv.store.get(`sess:${newSid}`)!.value) as {
			issued_at: number;
		};
		expect(newRecord.issued_at).toBeGreaterThan(T);

		// Old caller record is deleted outright, not left for the epoch to reap.
		expect(kv.store.has(`sess:${callerSid}`)).toBe(false);

		// The other session is dead; the replacement still reads.
		const { ctx: replayCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${otherSid}`,
		});
		expect(await readSession(replayCtx)).toBeNull();
		const { ctx: survivorCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${newSid}`,
		});
		expect((await readSession(survivorCtx))?.user_id).toBe(userId);
	});

	it("still revokes when the caller sends no cookie at all", async () => {
		const { ctx: otherCtx, kv, setCookies } = makeCtx({});
		await issueSession(otherCtx, userId);
		const otherSid = extractCookieValue(setCookies[0]!);

		const { ctx: revokeCtx, setCookies: revokeCookies } = makeCtxWithSameKv(
			kv,
			{},
		);
		await revokeOtherSessions(revokeCtx, userId);

		expect(kv.store.has(`sessrev:${userId}`)).toBe(true);
		expect(revokeCookies.length).toBeGreaterThan(0);
		const { ctx: replayCtx } = makeCtxWithSameKv(kv, {
			cookieHeader: `__Host-garrul_sess=${otherSid}`,
		});
		expect(await readSession(replayCtx)).toBeNull();
	});
});
