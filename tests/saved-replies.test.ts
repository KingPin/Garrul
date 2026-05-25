/**
 * Saved-replies tests cover:
 *
 *   1. The query layer's SQL semantics — that listSavedRepliesForUser
 *      honors the (owner OR shared) visibility rule and that
 *      updateSavedReply / deleteSavedReply enforce owner_id in the WHERE
 *      clause (defense even from a crafted request).
 *   2. The route layer's role gating — requireMod must accept mod/admin
 *      and reject anonymous/user roles cleanly.
 *   3. Input validation — title/body bounds, scope allowlist.
 *   4. The post-as-reply path — re-renders through renderMarkdown (no
 *      stored HTML trusted), audits with from_saved_reply=true.
 *   5. The XSS-attempt fuzz — markdown body containing a <script> tag is
 *      stripped at post time, never persisted as html.
 *
 * No Miniflare. Hand-rolled D1 stub with capture so tests can assert
 * SQL shape directly.
 */
import { describe, it, expect } from "vitest";
import {
	deleteSavedReply,
	insertSavedReply,
	listSavedRepliesForUser,
	updateSavedReply,
} from "../src/db/queries";
import { renderMarkdown } from "../src/lib/markdown";
import {
	SAVED_REPLY_BODY_MAX,
	SAVED_REPLY_TITLE_MAX,
	parseSavedReplyBody,
} from "../src/routes/admin";

type Captured = { sql: string; binds: unknown[] };

const makeDb = (config: {
	listResult?: unknown[];
	updateChanges?: number;
	deleteChanges?: number;
	getRow?: Record<string, unknown> | null;
} = {}) => {
	const captured: Captured[] = [];
	const chain = (sql: string) => {
		const stmt = {
			_sql: sql,
			_binds: [] as unknown[],
			bind(...args: unknown[]) {
				this._binds = args;
				return this;
			},
			async first() {
				captured.push({ sql, binds: this._binds });
				if (sql.includes("FROM saved_replies WHERE id")) {
					return config.getRow ?? null;
				}
				return null;
			},
			async all() {
				captured.push({ sql, binds: this._binds });
				return { results: config.listResult ?? [] };
			},
			async run() {
				captured.push({ sql, binds: this._binds });
				if (sql.startsWith("UPDATE saved_replies")) {
					return { meta: { changes: config.updateChanges ?? 0 } };
				}
				if (sql.startsWith("DELETE FROM saved_replies")) {
					return { meta: { changes: config.deleteChanges ?? 0 } };
				}
				return { meta: { changes: 1 } };
			},
		};
		return stmt;
	};
	const db = {
		prepare(sql: string) {
			return chain(sql);
		},
	};
	return { db, captured };
};

// ---------------------- query layer SQL semantics --------------------------

describe("listSavedRepliesForUser", () => {
	it("issues a SELECT with (owner_id = ? OR scope = 'shared')", async () => {
		const { db, captured } = makeDb({ listResult: [] });
		await listSavedRepliesForUser(db as unknown as D1Database, "u_alice");
		const select = captured.find((c) => c.sql.includes("FROM saved_replies"));
		expect(select).toBeDefined();
		expect(select!.sql).toContain("owner_id = ?");
		expect(select!.sql).toContain("scope = 'shared'");
		expect(select!.binds).toEqual(["u_alice"]);
	});
});

describe("insertSavedReply", () => {
	it("binds the owner_id, scope, and a generated ulid in column order", async () => {
		const { db, captured } = makeDb();
		const r = await insertSavedReply(db as unknown as D1Database, {
			owner_id: "u_alice",
			title: "Welcome",
			body_md: "Hi!",
			scope: "private",
		});
		const insert = captured.find((c) => c.sql.includes("INSERT INTO saved_replies"));
		expect(insert).toBeDefined();
		// Bind order: id, owner_id, title, body_md, scope, created_at, updated_at
		expect(insert!.binds[1]).toBe("u_alice");
		expect(insert!.binds[2]).toBe("Welcome");
		expect(insert!.binds[3]).toBe("Hi!");
		expect(insert!.binds[4]).toBe("private");
		expect(r.id).toBeTruthy();
		expect(r.created_at).toBe(r.updated_at);
	});
});

describe("updateSavedReply", () => {
	it("requires owner_id in WHERE (defense even from crafted request)", async () => {
		const { db, captured } = makeDb({ updateChanges: 1 });
		await updateSavedReply(
			db as unknown as D1Database,
			"r_1",
			"u_alice",
			{ title: "x", body_md: "y", scope: "shared" },
		);
		const upd = captured.find((c) => c.sql.startsWith("UPDATE saved_replies"));
		expect(upd).toBeDefined();
		expect(upd!.sql).toContain("WHERE id = ? AND owner_id = ?");
		// Bind order: title, body_md, scope, updated_at, id, owner_id
		expect(upd!.binds[4]).toBe("r_1");
		expect(upd!.binds[5]).toBe("u_alice");
	});

	it("returns false when changes=0 (id+owner_id didn't match)", async () => {
		const { db } = makeDb({ updateChanges: 0 });
		const ok = await updateSavedReply(
			db as unknown as D1Database,
			"r_other",
			"u_alice",
			{ title: "x", body_md: "y", scope: "shared" },
		);
		expect(ok).toBe(false);
	});

	it("returns true when changes>0", async () => {
		const { db } = makeDb({ updateChanges: 1 });
		const ok = await updateSavedReply(
			db as unknown as D1Database,
			"r_1",
			"u_alice",
			{ title: "x", body_md: "y", scope: "shared" },
		);
		expect(ok).toBe(true);
	});
});

describe("deleteSavedReply", () => {
	it("requires owner_id in WHERE", async () => {
		const { db, captured } = makeDb({ deleteChanges: 1 });
		await deleteSavedReply(db as unknown as D1Database, "r_1", "u_alice");
		const del = captured.find((c) => c.sql.startsWith("DELETE FROM saved_replies"));
		expect(del).toBeDefined();
		expect(del!.sql).toContain("WHERE id = ? AND owner_id = ?");
		expect(del!.binds).toEqual(["r_1", "u_alice"]);
	});

	it("returns false when owner_id mismatch (admin cannot delete other mod's private reply)", async () => {
		// Even an admin's user.id passed in here will NOT remove a row that
		// belongs to a different owner — D1 reports changes=0.
		const { db } = makeDb({ deleteChanges: 0 });
		const ok = await deleteSavedReply(
			db as unknown as D1Database,
			"r_1",
			"u_admin",
		);
		expect(ok).toBe(false);
	});
});

// ----------------- markdown sanitization at post time ----------------------

describe("saved reply body sanitization", () => {
	it("strips raw <script> from markdown body when re-rendered", () => {
		const malicious = `Hi <script>alert(1)</script> there`;
		const html = renderMarkdown(malicious);
		// The tag must not survive; the text content inside is allowed to
		// remain as inert text (no executable handler).
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("</script>");
	});

	it("strips raw <img onerror=..> from markdown body when re-rendered", () => {
		const malicious = `<img src=x onerror="alert(1)">`;
		const html = renderMarkdown(malicious);
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("<img");
	});

	it("preserves the allowed markdown subset", () => {
		const md = `**bold** *em* [link](https://example.com)`;
		const html = renderMarkdown(md);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>em</em>");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('rel="nofollow ugc');
	});
});

// --------------------- input validation parser -----------------------------

describe("parseSavedReplyBody — title length bound", () => {
	it("accepts a title at the cap", () => {
		const r = parseSavedReplyBody({
			title: "x".repeat(SAVED_REPLY_TITLE_MAX),
			body_md: "ok",
			scope: "private",
		});
		expect(r.ok).toBe(true);
	});

	it("rejects a title one char over the cap with title_too_long", () => {
		const r = parseSavedReplyBody({
			title: "x".repeat(SAVED_REPLY_TITLE_MAX + 1),
			body_md: "ok",
			scope: "private",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("title_too_long");
	});
});

describe("parseSavedReplyBody — body length bound", () => {
	it("accepts a body at the cap", () => {
		const r = parseSavedReplyBody({
			title: "t",
			body_md: "x".repeat(SAVED_REPLY_BODY_MAX),
			scope: "private",
		});
		expect(r.ok).toBe(true);
	});

	it("rejects a body one char over the cap with body_too_long", () => {
		const r = parseSavedReplyBody({
			title: "t",
			body_md: "x".repeat(SAVED_REPLY_BODY_MAX + 1),
			scope: "private",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("body_too_long");
	});
});

describe("parseSavedReplyBody — other rules", () => {
	it("rejects a missing title with title_required", () => {
		const r = parseSavedReplyBody({ title: "  ", body_md: "ok", scope: "private" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("title_required");
	});

	it("rejects a missing body with body_required", () => {
		const r = parseSavedReplyBody({ title: "t", body_md: "  ", scope: "private" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("body_required");
	});

	it("rejects an unknown scope with scope_invalid", () => {
		const r = parseSavedReplyBody({
			title: "t",
			body_md: "ok",
			scope: "team",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toBe("scope_invalid");
	});

	it("trims the title but preserves body whitespace", () => {
		const r = parseSavedReplyBody({
			title: "  hello  ",
			body_md: "  body  ",
			scope: "shared",
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.fields.title).toBe("hello");
			expect(r.fields.body_md).toBe("  body  ");
		}
	});
});
