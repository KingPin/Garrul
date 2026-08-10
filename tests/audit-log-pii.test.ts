/**
 * `audit_log.meta` must not carry personal data about anyone other than the
 * acting admin.
 *
 * Several actions used to copy a value in that erasure could never reach:
 * `sub.unsubscribe` / `sub.resend` recorded the subscriber's address, and the
 * role-change and ban/unban actions recorded the target's display name. Erasing
 * a user anonymizes `users.name` and deletes their subscriptions, but nothing
 * has ever touched the audit log — so those copies survived a completed Art. 17
 * request.
 *
 * Two halves, both needed:
 *
 *   - the routes stop writing the fields (asserted through the real handlers, so
 *     a future edit that reintroduces `email` in a meta payload fails here);
 *   - migration 0019 clears the rows already written. That half is exercised by
 *     replaying migrations 0001–0018, inserting the legacy shapes, and *then*
 *     applying 0019 — the usual "apply everything to a fresh DB" harness can't
 *     test a backfill, because there is nothing to back-fill.
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
const DAY = 86_400_000;
const NOW = Date.now();

const ADMIN_SID = "a".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";
const TARGET_ID = "01HTARGET00000000000000TA";
const SUB_ID = "01HSUB000000000000000SUB0";
const SLUG = "hello";
const PII_EMAIL = "subscriber@example.com";
const PII_NAME = "Real Name";
const ROLE_ACTIONS = [
	"role.grant_mod",
	"role.revoke_mod",
	"role.grant_admin",
	"role.revoke_admin",
] as const;

const migrationFiles = (): string[] =>
	readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

const applyMigrations = (db: DatabaseSync, files: string[]) => {
	for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
};

// ---------------------------------------------------------------------------
// Migration 0019 — backfill over rows written before the routes were fixed.
// ---------------------------------------------------------------------------

describe("migration 0019_audit_log_pii", () => {
	let sqlite: DatabaseSync;

	const insertLegacy = (id: string, action: string, meta: string | null) =>
		sqlite
			.prepare(
				`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id,
				                        reason, meta, created_at)
				 VALUES (?, ?, ?, 'subscription', 'x', NULL, ?, ?)`,
			)
			.run(id, ADMIN_ID, action, meta, NOW - 10 * DAY);

	const meta = (id: string): string | null =>
		(
			sqlite.prepare("SELECT meta FROM audit_log WHERE id = ?").get(id) as {
				meta: string | null;
			}
		).meta;

	const apply0019 = () =>
		applyMigrations(
			sqlite,
			migrationFiles().filter((f) => f.startsWith("0019_")),
		);

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		// Everything up to but NOT including 0019 — the state a real instance is in
		// before the upgrade.
		applyMigrations(
			sqlite,
			migrationFiles().filter((f) => f < "0019"),
		);
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
				 VALUES (?, 'github', '1', 'Op', 1, 'admin', ?)`,
			)
			.run(ADMIN_ID, NOW - 500 * DAY);
	});

	it("removes the subscriber address and keeps post_slug", () => {
		insertLegacy(
			"a-unsub",
			"sub.unsubscribe",
			JSON.stringify({ email: PII_EMAIL, post_slug: SLUG }),
		);
		insertLegacy(
			"a-resend",
			"sub.resend",
			JSON.stringify({ email: PII_EMAIL, post_slug: SLUG }),
		);

		apply0019();

		expect(JSON.parse(meta("a-unsub") ?? "{}")).toEqual({ post_slug: SLUG });
		expect(JSON.parse(meta("a-resend") ?? "{}")).toEqual({ post_slug: SLUG });
	});

	it("removes target_name from role changes and keeps from/to", () => {
		for (const action of ROLE_ACTIONS) {
			insertLegacy(
				`a-${action}`,
				action,
				JSON.stringify({ target_name: PII_NAME, from: "user", to: "mod" }),
			);
		}

		apply0019();

		for (const action of ROLE_ACTIONS) {
			expect(JSON.parse(meta(`a-${action}`) ?? "{}")).toEqual({
				from: "user",
				to: "mod",
			});
		}
	});

	// ban/unban carried the same field. It's the action an operator is most
	// likely to retain longest, which makes it the worst place to leave a name.
	it("removes target_name from bans and keeps from_comment", () => {
		insertLegacy(
			"a-ban",
			"ban",
			JSON.stringify({ target_name: PII_NAME, from_comment: "c-1" }),
		);
		insertLegacy("a-unban", "unban", JSON.stringify({ target_name: PII_NAME }));

		apply0019();

		expect(JSON.parse(meta("a-ban") ?? "{}")).toEqual({ from_comment: "c-1" });
		expect(JSON.parse(meta("a-unban") ?? "{}")).toEqual({});
	});

	// A NULL meta must stay NULL rather than becoming the string 'null', which is
	// what an unguarded json_remove would produce.
	it("leaves NULL and already-clean rows alone", () => {
		insertLegacy("a-null", "sub.resend", null);
		insertLegacy("a-clean", "sub.resend", JSON.stringify({ post_slug: SLUG }));
		insertLegacy("a-other", "user.erase", JSON.stringify({ email: PII_EMAIL }));

		apply0019();

		expect(meta("a-null")).toBeNull();
		expect(JSON.parse(meta("a-clean") ?? "{}")).toEqual({ post_slug: SLUG });
		// Untouched: no action outside the listed set ever wrote an address, so
		// widening the WHERE would be rewriting rows on speculation.
		expect(JSON.parse(meta("a-other") ?? "{}")).toEqual({ email: PII_EMAIL });
	});

	it("is idempotent on re-run", () => {
		insertLegacy(
			"a-unsub",
			"sub.unsubscribe",
			JSON.stringify({ email: PII_EMAIL, post_slug: SLUG }),
		);

		apply0019();
		apply0019();

		expect(JSON.parse(meta("a-unsub") ?? "{}")).toEqual({ post_slug: SLUG });
	});

	// Not a hypothetical: json_remove is a JSON1 function, and the whole
	// migration is a no-op-and-silent-failure if D1's engine lacks it.
	it("proves json_remove is available in the engine under test", () => {
		const row = sqlite
			.prepare(`SELECT json_remove('{"email":"a@b.c","post_slug":"x"}','$.email') AS out`)
			.get() as { out: string };

		expect(JSON.parse(row.out)).toEqual({ post_slug: "x" });
	});
});

// ---------------------------------------------------------------------------
// The routes — the source of the problem.
// ---------------------------------------------------------------------------

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
		return null;
	},
	async put() {},
	async delete() {},
});

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

describe("audit meta written by the routes", () => {
	let sqlite: DatabaseSync;
	let env: Record<string, unknown>;

	const post = (path: string, body: unknown) =>
		new Hono<{ Bindings: Bindings }>()
			.route("/admin", admin)
			.request(
				path,
				{
					method: "POST",
					headers: {
						cookie: `__Host-garrul_sess=${ADMIN_SID}`,
						origin: "http://localhost",
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
				env,
				execCtx,
			);

	const metaFor = (action: string): Record<string, unknown> => {
		const row = sqlite
			.prepare("SELECT meta FROM audit_log WHERE action = ?")
			.get(action) as { meta: string | null } | undefined;
		expect(row, `no audit row for ${action}`).toBeDefined();
		return JSON.parse(row?.meta ?? "{}");
	};

	beforeEach(() => {
		installMockCaches();
		sqlite = new DatabaseSync(":memory:");
		applyMigrations(sqlite, migrationFiles());
		const seedUser = sqlite.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, is_admin, role, created_at)
			 VALUES (?, 'github', ?, ?, ?, ?, ?, ?)`,
		);
		seedUser.run(ADMIN_ID, "1", "Op", null, 1, "admin", NOW - 500 * DAY);
		seedUser.run(TARGET_ID, "2", PII_NAME, null, 0, "user", NOW - 100 * DAY);
		sqlite
			.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?,?,?,?)")
			.run(SLUG, "Hello", null, NOW - 500 * DAY);
		sqlite
			.prepare(
				`INSERT INTO subscriptions (id, post_slug, email, token, confirmed_at, created_at)
				 VALUES (?, ?, ?, 'tok', ?, ?)`,
			)
			.run(SUB_ID, SLUG, PII_EMAIL, NOW - 90 * DAY, NOW - 90 * DAY);

		env = {
			DB: makeD1(sqlite),
			TREE_CACHE: makeKv(),
			SESSIONS: makeSessions(),
		};
	});

	afterEach(() => uninstallMockCaches());

	it("records a role change without the target's display name", async () => {
		const res = await post(`/admin/api/users/${TARGET_ID}/role`, { role: "mod" });
		expect(res.status).toBe(200);

		const m = metaFor("role.grant_mod");
		expect(m).toEqual({ from: "user", to: "mod" });
		expect(JSON.stringify(m)).not.toContain(PII_NAME);
	});

	it("records an unsubscribe without the subscriber's address", async () => {
		const res = await post(`/admin/api/subscriptions/${SUB_ID}`, {
			action: "unsubscribe",
		});
		expect(res.status).toBe(200);

		const m = metaFor("sub.unsubscribe");
		expect(m).toEqual({ post_slug: SLUG });
		expect(JSON.stringify(m)).not.toContain(PII_EMAIL);
	});

	// The address is still reachable where it belongs — on the subscription row —
	// so dropping it from the audit meta loses nothing an operator needs.
	it("leaves the address on the subscription row itself", async () => {
		await post(`/admin/api/subscriptions/${SUB_ID}`, { action: "unsubscribe" });

		const sub = sqlite
			.prepare("SELECT email, unsubscribed_at FROM subscriptions WHERE id = ?")
			.get(SUB_ID) as { email: string; unsubscribed_at: number | null };
		expect(sub.email).toBe(PII_EMAIL);
		expect(sub.unsubscribed_at).not.toBeNull();
	});
});
