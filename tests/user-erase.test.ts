/**
 * Admin data-erasure path — POST /admin/api/users/:id/erase.
 *
 * Before this existed, honouring a deletion request meant hand-written SQL
 * against D1, and a soft-deleted comment kept its `ip_hash` and `user_agent`
 * forever — including in every `db-export.sh` dump.
 *
 * Real SQLite with every migration applied, because every assertion here is
 * "did this column actually get cleared". The D1 adapter implements `batch` in a
 * transaction, which is what the erasure relies on: a half-erased user is worse
 * than an un-erased one. Foreign keys are enforced (node:sqlite's default), so
 * the notifications → subscriptions ordering is genuinely exercised rather than
 * assumed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { admin } from "../src/routes/admin";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

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
	// D1 wraps a batch in a transaction; so does this.
	async batch(statements: { run(): Promise<unknown> }[]) {
		db.exec("BEGIN");
		try {
			const out = [];
			for (const s of statements) out.push(await s.run());
			db.exec("COMMIT");
			return out;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	},
});

const ADMIN_SID = "a".repeat(64);
const MOD_SID = "b".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const MOD_ID = "01HMOD00000000000000000MOD";
const TARGET_ID = "01HTARGET00000000000000TGT";
const OTHER_ID = "01HOTHER00000000000000OTHR";
const SECOND_ADMIN_ID = "01HADMIN2000000000000000A2";

const SLUG = "hello";
const TARGET_COMMENT = "01HCTARGET0000000000000CT";
const OTHER_COMMENT = "01HCOTHER00000000000000CO";
const TARGET_EMAIL = "target@example.com";
const IP = "hash-of-target-ip";

let sqlite: DatabaseSync;
let env: Bindings;
let sessionStore: Map<string, string>;

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const makeSessions = (store: Map<string, string>) => ({
	async get(key: string) {
		if (key === `sess:${ADMIN_SID}`)
			return JSON.stringify({ user_id: ADMIN_ID, expires_at: 4_102_444_800_000 });
		if (key === `sess:${MOD_SID}`)
			return JSON.stringify({ user_id: MOD_ID, expires_at: 4_102_444_800_000 });
		return store.get(key) ?? null;
	},
	async put(key: string, value: string) {
		store.set(key, value);
	},
	async delete(key: string) {
		store.delete(key);
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
		async list({ prefix }: { prefix: string }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
			};
		},
	};
};

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
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	seedUser.run(ADMIN_ID, "github", "1", "Op", "op@example.com", null, 1, "admin", 1_700_000_000_000);
	seedUser.run(MOD_ID, "github", "2", "Mod", null, null, 0, "mod", 1_700_000_000_000);
	seedUser.run(SECOND_ADMIN_ID, "github", "3", "Op2", null, null, 1, "admin", 1_700_000_000_000);
	// The target is an OAuth account: provider_id is the provider's user id, the
	// handle a later login is matched on.
	seedUser.run(
		TARGET_ID,
		"github",
		"9001",
		"Real Name",
		TARGET_EMAIL,
		"https://avatars.example/9001.png",
		0,
		"user",
		1_700_000_000_000,
	);
	seedUser.run(OTHER_ID, "anon", "other-ip-hash", "Someone Else", null, null, 0, "user", 1_700_000_000_000);

	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Hello", null, 1_700_000_000_000);

	const seedComment = sqlite.prepare(
		`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
		                       renderer_version, status, ip_hash, user_agent,
		                       created_at, depth)
		 VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
	);
	seedComment.run(
		TARGET_COMMENT, SLUG, TARGET_ID,
		"my address is 1 Real Street", "<p>my address is 1 Real Street</p>",
		"approved", IP, "Mozilla/5.0 (target)", 1_700_000_001_000,
	);
	seedComment.run(
		OTHER_COMMENT, SLUG, OTHER_ID,
		"unrelated", "<p>unrelated</p>",
		"approved", "other-ip", "Mozilla/5.0 (other)", 1_700_000_002_000,
	);

	// A subscription on the target's address, with an unsent notification hanging
	// off it — the FK that makes delete order matter.
	sqlite
		.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, confirm_token,
			                            confirmed_at, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		)
		.run("01HSUBTARGET000000000SUB", SLUG, TARGET_EMAIL, "t".repeat(64), 1_700_000_000_000, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO subscriptions (id, post_slug, email, token, confirm_token,
			                            confirmed_at, created_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
		)
		.run("01HSUBOTHER0000000000SUB", SLUG, "bystander@example.com", "o".repeat(64), 1_700_000_000_000, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO notifications (id, subscription_id, comment_id, created_at, sent_at)
			 VALUES (?, ?, ?, ?, NULL)`,
		)
		.run("01HNOTIF00000000000000NT", "01HSUBTARGET000000000SUB", OTHER_COMMENT, 1_700_000_003_000);

	sqlite
		.prepare(
			`INSERT INTO telegram_links (tg_user_id, tg_chat_id, user_id, digest, linked_at)
			 VALUES (?, ?, ?, 0, ?)`,
		)
		.run("tg-555", "chat-555", TARGET_ID, 1_700_000_000_000);

	// Three notes, one of each shape the erasure has to tell apart: about the
	// target, about a comment of theirs, and authored *by* the target.
	sqlite
		.prepare(
			`INSERT INTO moderator_notes (id, target_kind, target_id, author_id,
			                              body, created_at)
			 VALUES ('n-about', 'user', ?, ?, 'note about target', ?),
			        ('n-comment', 'comment', ?, ?, 'note on their comment', ?),
			        ('n-authored', 'user', ?, ?, 'note they wrote', ?)`,
		)
		.run(
			TARGET_ID,
			MOD_ID,
			1_700_000_000_000,
			TARGET_COMMENT,
			MOD_ID,
			1_700_000_000_000,
			OTHER_ID,
			TARGET_ID,
			1_700_000_000_000,
		);

	sqlite
		.prepare(
			`INSERT INTO reports (id, comment_id, reporter_user_id, reporter_ip_hash,
			                      reason, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?)`,
		)
		.run("01HREPORT00000000000RPT", OTHER_COMMENT, TARGET_ID, IP, "spam", 1_700_000_004_000);

	sessionStore = new Map();
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(sessionStore),
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const app = () => new Hono<{ Bindings: Bindings }>().route("/admin", admin);

const erase = (
	body: unknown,
	opts: { sid?: string; target?: string } = {},
) => {
	const { sid = ADMIN_SID, target = TARGET_ID } = opts;
	return app().request(
		`/admin/api/users/${target}/erase`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: `__Host-garrul_sess=${sid}`,
				origin: "http://localhost",
			},
			body: JSON.stringify(body),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);
};

const userRow = (id = TARGET_ID) =>
	sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;

const commentRow = (id: string) =>
	sqlite.prepare("SELECT * FROM comments WHERE id = ?").get(id) as Record<
		string,
		unknown
	>;

const count = (sql: string, ...binds: unknown[]): number =>
	(sqlite.prepare(sql).get(...(binds as never[])) as { n: number }).n;

const lastAudit = () =>
	sqlite
		.prepare(
			"SELECT action, target_id, meta FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1",
		)
		.get() as { action: string; target_id: string; meta: string | null } | undefined;

describe("POST /admin/api/users/:id/erase — identity", () => {
	it("clears name, email, avatar and provider_id, and stamps erased_at", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: false });
		expect(res.status).toBe(200);
		const u = userRow();
		expect(u.name).toBe("[deleted]");
		expect(u.email).toBeNull();
		expect(u.avatar_url).toBeNull();
		// The handle a later OAuth login is matched on. Clearing it is what stops
		// the erased identity being resurrected by the next sign-in.
		expect(u.provider_id).toBeNull();
		expect(u.erased_at).toEqual(expect.any(Number));
		// The row itself must survive: comments.user_id references it.
		expect(u.id).toBe(TARGET_ID);
	});

	it("clears provider_id for an anonymous ghost, where it holds the ip_hash", async () => {
		expect(userRow(OTHER_ID).provider_id).toBe("other-ip-hash");
		const res = await erase({ confirm: "ERASE", redact_bodies: false }, {
			target: OTHER_ID,
		});
		expect(res.status).toBe(200);
		expect(userRow(OTHER_ID).provider_id).toBeNull();
	});

	it("revokes their live sessions", async () => {
		await erase({ confirm: "ERASE", redact_bodies: false });
		const revoked = [...sessionStore.keys()].filter((k) => k.includes(TARGET_ID));
		expect(revoked).toHaveLength(1);
	});
});

describe("POST /admin/api/users/:id/erase — comment data", () => {
	it("clears ip_hash and user_agent on their comments and leaves others alone", async () => {
		await erase({ confirm: "ERASE", redact_bodies: false });
		const mine = commentRow(TARGET_COMMENT);
		expect(mine.ip_hash).toBeNull();
		expect(mine.user_agent).toBeNull();
		const theirs = commentRow(OTHER_COMMENT);
		expect(theirs.ip_hash).toBe("other-ip");
		expect(theirs.user_agent).toBe("Mozilla/5.0 (other)");
	});

	it("keeps the comment readable by default — anonymizing the author is the default, not deleting the thread", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: false });
		const body = (await res.json()) as { counts: Record<string, number> };
		expect(body.counts.bodies_redacted).toBe(0);
		const c = commentRow(TARGET_COMMENT);
		expect(c.body_md).toBe("my address is 1 Real Street");
		expect(c.status).toBe("approved");
	});

	it("blanks the bodies and marks them deleted when asked", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: true });
		const body = (await res.json()) as { counts: Record<string, number> };
		expect(body.counts.bodies_redacted).toBe(1);
		const c = commentRow(TARGET_COMMENT);
		expect(c.body_md).toBe("");
		expect(c.body_html).toBe("");
		expect(c.status).toBe("deleted");
		expect(c.deleted_by).toBe("moderator");
		expect(c.deleted_at).toEqual(expect.any(Number));
		// Still not touching anyone else's.
		expect(commentRow(OTHER_COMMENT).body_md).toBe("unrelated");
	});
});

describe("POST /admin/api/users/:id/erase — linked records", () => {
	it("removes their subscriptions and the notifications hanging off them", async () => {
		// Ordering matters: notifications.subscription_id is a foreign key, so
		// deleting the subscription first aborts the whole transaction.
		const res = await erase({ confirm: "ERASE", redact_bodies: false });
		expect(res.status).toBe(200);
		expect(
			count("SELECT COUNT(*) AS n FROM subscriptions WHERE email = ?", TARGET_EMAIL),
		).toBe(0);
		expect(count("SELECT COUNT(*) AS n FROM notifications")).toBe(0);
		// A different subscriber on the same thread is untouched.
		expect(
			count(
				"SELECT COUNT(*) AS n FROM subscriptions WHERE email = ?",
				"bystander@example.com",
			),
		).toBe(1);
	});

	// `subscriptions.email` is always written lowercased; `users.email` keeps the
	// casing the OAuth provider sent, and the column has no COLLATE NOCASE. A raw
	// `=` between them leaves the subscription behind after a *completed*
	// erasure — the mail keeps arriving and the audit row reports 0 deleted.
	it("removes subscriptions when the provider sent a mixed-case email", async () => {
		sqlite
			.prepare(`UPDATE users SET email = ? WHERE id = ?`)
			.run("Target@Example.com", TARGET_ID);

		const res = await erase({ confirm: "ERASE", redact_bodies: false });
		expect(res.status).toBe(200);
		expect(
			count("SELECT COUNT(*) AS n FROM subscriptions WHERE email = ?", TARGET_EMAIL),
		).toBe(0);
	});

	it("removes the Telegram link", async () => {
		await erase({ confirm: "ERASE", redact_bodies: false });
		expect(
			count("SELECT COUNT(*) AS n FROM telegram_links WHERE user_id = ?", TARGET_ID),
		).toBe(0);
	});

	it("clears reporter_ip_hash on reports they filed but keeps the report", async () => {
		await erase({ confirm: "ERASE", redact_bodies: false });
		const r = sqlite
			.prepare("SELECT reporter_user_id, reporter_ip_hash, status FROM reports")
			.get() as Record<string, unknown>;
		expect(r.reporter_ip_hash).toBeNull();
		expect(r.reporter_user_id).toBe(TARGET_ID);
		expect(r.status).toBe("open");
	});
});

describe("POST /admin/api/users/:id/erase — moderator notes", () => {
	// A note about a person is free text a moderator wrote about them, with no
	// expression interest on the other side of the scale — nobody outside the
	// mod team ever reads it. So erasure takes it, and takes only it.
	const noteIds = (): string[] =>
		(
			sqlite
				.prepare("SELECT id FROM moderator_notes ORDER BY id")
				.all() as { id: string }[]
		).map((r) => r.id);

	it("deletes notes about them and keeps the rest", async () => {
		expect(noteIds()).toEqual(["n-about", "n-authored", "n-comment"]);

		const res = await erase({ confirm: "ERASE", redact_bodies: false });
		expect(res.status).toBe(200);

		// n-comment annotates a piece of content; n-authored is their own
		// moderator work, kept for the reason their audit rows are.
		expect(noteIds()).toEqual(["n-authored", "n-comment"]);
	});
});

describe("POST /admin/api/users/:id/erase — audit trail", () => {
	it("records counts and never the erased values", async () => {
		await erase({ confirm: "ERASE", redact_bodies: true, reason: "GDPR request" });
		const audit = lastAudit();
		expect(audit?.action).toBe("user.erase");
		expect(audit?.target_id).toBe(TARGET_ID);
		const meta = JSON.parse(audit?.meta ?? "{}");
		expect(meta).toMatchObject({
			redact_bodies: true,
			comments_scrubbed: 1,
			bodies_redacted: 1,
			subscriptions_deleted: 1,
			reports_scrubbed: 1,
			telegram_links_deleted: 1,
			moderator_notes_deleted: 1,
		});
		// The point of the action is that this data is gone. Writing the name or
		// address into audit_log.meta would relocate it, not remove it — and audit
		// rows are the last thing an operator thinks to prune.
		const serialized = JSON.stringify(meta);
		expect(serialized).not.toContain("Real Name");
		expect(serialized).not.toContain(TARGET_EMAIL);
		expect(serialized).not.toContain(IP);
	});
});

describe("POST /admin/api/users/:id/erase — guards", () => {
	const untouched = () => {
		const u = userRow();
		expect(u.name).toBe("Real Name");
		expect(u.email).toBe(TARGET_EMAIL);
		expect(u.erased_at).toBeNull();
	};

	it("refuses without the typed confirmation", async () => {
		const res = await erase({ redact_bodies: false });
		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toEqual({
			error: "confirmation_required",
		});
		untouched();
	});

	it("refuses a wrong confirmation string", async () => {
		const res = await erase({ confirm: "erase", redact_bodies: false });
		expect(res.status).toBe(400);
		untouched();
	});

	it("refuses when redact_bodies is missing — the caller has to choose", async () => {
		const res = await erase({ confirm: "ERASE" });
		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toEqual({ error: "invalid_body" });
		untouched();
	});

	it("refuses to erase yourself", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: false }, {
			target: ADMIN_ID,
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toEqual({
			error: "cannot_erase_self",
		});
		expect(userRow(ADMIN_ID).name).toBe("Op");
	});

	it("refuses to erase another admin — demote them first", async () => {
		// An erasure clears provider_id, which is what their next login is matched
		// on, so this would lock a live admin out permanently.
		const res = await erase({ confirm: "ERASE", redact_bodies: false }, {
			target: SECOND_ADMIN_ID,
		});
		expect(res.status).toBe(400);
		expect((await res.json()) as unknown).toEqual({ error: "target_is_admin" });
		expect(userRow(SECOND_ADMIN_ID).name).toBe("Op2");
	});

	it("rejects a mod — admin-only", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: false }, {
			sid: MOD_SID,
		});
		expect(res.status).toBe(403);
		untouched();
	});

	it("rejects a cross-origin request", async () => {
		const res = await app().request(
			`/admin/api/users/${TARGET_ID}/erase`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: `__Host-garrul_sess=${ADMIN_SID}`,
					origin: "https://evil.example",
				},
				body: JSON.stringify({ confirm: "ERASE", redact_bodies: true }),
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);
		expect(res.status).toBe(403);
		untouched();
	});

	it("404s an unknown user", async () => {
		const res = await erase({ confirm: "ERASE", redact_bodies: false }, {
			target: "01HNOBODY000000000000NOB",
		});
		expect(res.status).toBe(404);
	});
});
