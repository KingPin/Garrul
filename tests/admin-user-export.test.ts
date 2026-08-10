/**
 * GET /admin/api/users/:id/export — the mechanism behind a GDPR Art. 15
 * (access) / Art. 20 (portability) request.
 *
 * Exercised through the real Hono route against real SQLite, because what's
 * worth pinning is the *contents* of a legal deliverable rather than any logic:
 *
 *   - The subject's own data is actually in there. An export that silently
 *     dropped a table would be an incomplete access response, and nothing else
 *     in the system would notice.
 *   - `admin_id` is NOT in there. Moderation actions taken against the subject
 *     are their data; which moderator took them is a third party's. This is the
 *     one assertion that stops a well-meaning `SELECT *` from leaking staff
 *     identities into a file the operator hands to a stranger.
 *   - Only an admin can fetch it, and the response is not cacheable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../src/routes/admin";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { UserDataExport } from "../src/db/queries";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const DAY = 86_400_000;
const NOW = Date.now();

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";
const SUBJECT_ID = "01HSUBJECT00000000000000SU";
const SLUG = "hello";

const makeD1 = (db: DatabaseSync): any => ({
	prepare(sql: string) {
		const stmt = db.prepare(sql);
		let bound: unknown[] = [];
		return {
			bind(...args: unknown[]) {
				bound = args;
				return this;
			},
			async run() {
				const r = stmt.run(...(bound as never[]));
				return { success: true, meta: { changes: r.changes } };
			},
			async first() {
				return stmt.get(...(bound as never[])) ?? null;
			},
			async all() {
				return { results: stmt.all(...(bound as never[])) };
			},
		};
	},
});

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		async get(key: string, type?: "json") {
			const raw = store.get(key);
			if (raw == null) return null;
			return type === "json" ? JSON.parse(raw) : raw;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
	};
};

const makeSessions = () => ({
	async get(key: string) {
		if (key === `sess:${ADMIN_SID}`)
			return JSON.stringify({ user_id: ADMIN_ID, expires_at: 4_102_444_800_000 });
		if (key === `sess:${MOD_SID}`)
			return JSON.stringify({ user_id: MOD_ID, expires_at: 4_102_444_800_000 });
		return null;
	},
	async put() {},
	async delete() {},
});

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const seedUser = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
		                    is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "github", "1", "Op", null, 1, "admin", NOW - 400 * DAY);
	seedUser.run(MOD_ID, "github", "2", "Mod", null, 0, "mod", NOW - 400 * DAY);
	seedUser.run(
		SUBJECT_ID,
		"github",
		"3",
		"Subject",
		"subject@example.com",
		0,
		"user",
		NOW - 100 * DAY,
	);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?,?,?,?)")
		.run(SLUG, "Hello", null, NOW - 400 * DAY);

	// One row in each surface the export is supposed to reach.
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md,
			                       body_html, renderer_version, status, ip_hash,
			                       user_agent, created_at, depth)
			 VALUES ('c-1', ?, NULL, ?, 'my comment', '<p>my comment</p>', 1,
			         'approved', 'hash-of-their-ip', 'their-ua', ?, 1)`,
		)
		.run(SLUG, SUBJECT_ID, NOW - 50 * DAY);
	sqlite
		.prepare(
			`INSERT INTO reports (id, comment_id, reporter_user_id, reporter_ip_hash,
			                      reason, status, created_at)
			 VALUES ('r-1', 'c-1', ?, 'hash-of-their-ip', 'spam', 'open', ?)`,
		)
		.run(SUBJECT_ID, NOW - 40 * DAY);
	sqlite
		.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, created_at)
			 VALUES ('s-1', ?, 'subject@example.com', 'tok', ?)`,
		)
		.run(SLUG, NOW - 60 * DAY);
	sqlite
		.prepare(
			`INSERT INTO votes (comment_id, user_id, value, created_at)
			 VALUES ('c-1', ?, 1, ?)`,
		)
		.run(SUBJECT_ID, NOW - 30 * DAY);
	sqlite
		.prepare(
			`INSERT INTO spam_verdicts (id, comment_id, source, verdict, score, raw, created_at)
			 VALUES ('v-1', 'c-1', 'akismet', 'ham', NULL, '{"response":"false"}', ?)`,
		)
		.run(NOW - 50 * DAY);
	// A moderation action against the subject, taken by ADMIN_ID. The admin's
	// identity must not survive into the export.
	sqlite
		.prepare(
			`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id,
			                        reason, meta, created_at)
			 VALUES ('a-1', ?, 'ban', 'user', ?, 'being rude', '{}', ?)`,
		)
		.run(ADMIN_ID, SUBJECT_ID, NOW - 20 * DAY);

	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const fetchExport = (opts: { sid?: string; id?: string } = {}) => {
	const { sid = ADMIN_SID, id = SUBJECT_ID } = opts;
	return new Hono<{ Bindings: Bindings }>()
		.route("/admin", admin)
		.request(
			`/admin/api/users/${id}/export`,
			{ headers: { cookie: `__Host-garrul_sess=${sid}` } },
			env as unknown as Record<string, unknown>,
			execCtx,
		);
};

/** `res.json()` is `unknown`; the route's contract is `UserDataExport`. */
const exportBody = async (
	opts: { sid?: string; id?: string } = {},
): Promise<UserDataExport> =>
	(await fetchExport(opts)).json() as Promise<UserDataExport>;

const lastAudit = () =>
	sqlite
		.prepare(
			"SELECT action, meta FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.get() as { action: string; meta: string | null } | undefined;

describe("GET /admin/api/users/:id/export", () => {
	it("returns every surface holding the subject's data", async () => {
		const res = await fetchExport();

		expect(res.status).toBe(200);
		const body = (await res.json()) as UserDataExport;
		expect(body).toMatchObject({
			export_version: 1,
			user: { id: SUBJECT_ID, email: "subject@example.com" },
		});
		expect(body.comments).toHaveLength(1);
		expect(body.reports_filed).toHaveLength(1);
		expect(body.subscriptions).toHaveLength(1);
		expect(body.votes).toHaveLength(1);
		expect(body.spam_verdicts).toHaveLength(1);
		expect(body.moderation_actions).toHaveLength(1);
	});

	// Their own hash and user agent: withholding them would make the export a
	// lie about what the instance holds.
	it("includes the subject's own ip_hash and user_agent", async () => {
		const body = await exportBody();

		expect(body.comments[0]).toMatchObject({
			ip_hash: "hash-of-their-ip",
			user_agent: "their-ua",
			body_md: "my comment",
		});
	});

	// The load-bearing assertion: a `SELECT *` on audit_log would hand the
	// requester the moderator's user id.
	it("omits the acting admin from moderation actions", async () => {
		const body = await exportBody();

		expect(body.moderation_actions[0]).toEqual({
			action: "ban",
			reason: "being rude",
			created_at: NOW - 20 * DAY,
		});
		expect(JSON.stringify(body)).not.toContain(ADMIN_ID);
	});

	it("serves as a non-cacheable named attachment", async () => {
		const res = await fetchExport();

		expect(res.headers.get("content-disposition")).toBe(
			`attachment; filename="garrul-export-${SUBJECT_ID}.json"`,
		);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	// A raw `new Response` would drop everything the admin middleware prepared
	// via `c.header()`, shipping the export with no CSP and no nosniff.
	it("keeps the admin middleware security headers", async () => {
		const res = await fetchExport();

		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("content-security-policy")).toBeTruthy();
	});

	// Counts, never values — an audit row echoing the payload would recreate the
	// personal data it exists to audit.
	it("audits the export without recording what was in it", async () => {
		await fetchExport();

		const audit = lastAudit();
		expect(audit?.action).toBe("user.export");
		expect(JSON.parse(audit?.meta ?? "{}")).toEqual({
			comments: 1,
			reports_filed: 1,
			subscriptions: 1,
		});
		expect(audit?.meta).not.toContain("subject@example.com");
	});

	it("404s for an unknown user", async () => {
		const res = await fetchExport({ id: "01HNOSUCHUSER0000000000000" });

		expect(res.status).toBe(404);
	});

	// Admin-only: a mod moderates comments, but handing out a personal-data dump
	// is the operator's call.
	// `subscriptions.email` is always written lowercased, but `users.email` keeps
	// whatever casing the OAuth provider sent. A case-sensitive `=` between them
	// drops the subject's subscriptions out of a legal deliverable, silently.
	it("matches subscriptions when the provider sent mixed-case email", async () => {
		sqlite
			.prepare(`UPDATE users SET email = 'Subject@Example.com' WHERE id = ?`)
			.run(SUBJECT_ID);

		const body = await exportBody();

		expect(body.subscriptions).toHaveLength(1);
	});

	it("rejects a mod", async () => {
		const res = await fetchExport({ sid: MOD_SID });

		expect(res.status).toBe(403);
	});

	it("rejects an unauthenticated caller", async () => {
		const res = await fetchExport({ sid: "c".repeat(64) });

		expect(res.status).toBe(401);
	});

	// An erased account has email NULL, which must match no subscriptions rather
	// than every row with a NULL address.
	it("matches no subscriptions when the subject has no address", async () => {
		sqlite.prepare("UPDATE users SET email = NULL WHERE id = ?").run(SUBJECT_ID);

		const body = await exportBody();

		expect(body.subscriptions).toEqual([]);
	});
});
