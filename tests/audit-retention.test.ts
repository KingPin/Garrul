/**
 * Audit-log retention sweep, against real SQLite with every migration applied.
 *
 * Real SQLite rather than the substring-routing D1 stubs for the same reason as
 * ip-retention.test.ts: every assertion here is "which rows did this DELETE
 * actually reach", and a stub that pattern-matches SQL proves nothing about the
 * `WHERE id IN (SELECT ... LIMIT ?)` batching form.
 *
 * The load-bearing behaviour is the 30-day floor. It has to *refuse* rather than
 * substitute — a fat-fingered `1` must no-op loudly instead of shredding a
 * year of moderation history.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AUDIT_RETENTION_BATCH,
	MIN_AUDIT_RETENTION_DAYS,
	auditRetentionCutoff,
	auditRetentionStats,
	isAuditRetentionEnabled,
	pruneAuditLog,
	runAuditRetention,
} from "../src/db/audit-retention";
import { log } from "../src/lib/log";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

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

let sqlite: DatabaseSync;
let db: any;

const ageDays = (days: number): number => NOW - days * DAY;

const ADMIN_ID = "01HADMIN0000000000000000AB";

const addAudit = (id: string, createdAt: number, action = "ban") =>
	sqlite
		.prepare(
			`INSERT INTO audit_log (id, admin_id, action, target_kind, target_id,
			                        reason, meta, created_at)
			 VALUES (?, ?, ?, 'user', 'someone', NULL, '{}', ?)`,
		)
		.run(id, ADMIN_ID, action, createdAt);

const ids = (): string[] =>
	(sqlite.prepare("SELECT id FROM audit_log ORDER BY id").all() as { id: string }[]).map(
		(r) => r.id,
	);

const count = (): number =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'github', '1', 'Op', 1, 'admin', ?)`,
		)
		.run(ADMIN_ID, NOW - 500 * DAY);
	db = makeD1(sqlite);
});

describe("auditRetentionCutoff / isAuditRetentionEnabled", () => {
	it("puts the cutoff N days before now", () => {
		expect(auditRetentionCutoff(30, NOW)).toBe(NOW - 30 * DAY);
	});

	// 0 is "keep forever", not "delete everything older than now".
	it("treats 0 and anything below the floor as disabled", () => {
		expect(isAuditRetentionEnabled(0)).toBe(false);
		expect(isAuditRetentionEnabled(MIN_AUDIT_RETENTION_DAYS - 1)).toBe(false);
		expect(isAuditRetentionEnabled(MIN_AUDIT_RETENTION_DAYS)).toBe(true);
	});
});

describe("pruneAuditLog", () => {
	it("deletes rows at or past the cutoff and leaves newer ones", async () => {
		addAudit("a-ancient", ageDays(400));
		addAudit("a-exactly", NOW - 30 * DAY); // boundary is inclusive
		addAudit("a-recent", ageDays(29));
		addAudit("a-today", NOW);

		const res = await pruneAuditLog(db, 30, NOW);

		expect(res).toEqual({ deleted: 2, more: false });
		expect(ids()).toEqual(["a-recent", "a-today"]);
	});

	// The whole point of the floor: a typo must not be the most destructive
	// value in range.
	it("refuses below the floor rather than sweeping", async () => {
		addAudit("a-old", ageDays(400));

		for (const days of [0, 1, MIN_AUDIT_RETENTION_DAYS - 1]) {
			const res = await pruneAuditLog(db, days, NOW);
			expect(res).toEqual({ deleted: 0, more: false });
		}
		expect(count()).toBe(1);
	});

	it("caps a batch and reports there is more behind it", async () => {
		for (let i = 0; i < AUDIT_RETENTION_BATCH + 5; i++) {
			addAudit(`a-${String(i).padStart(4, "0")}`, ageDays(100));
		}

		const first = await pruneAuditLog(db, 30, NOW);
		expect(first).toEqual({ deleted: AUDIT_RETENTION_BATCH, more: true });

		// Self-draining: a deleted row stops matching its own WHERE clause, so an
		// identical second call makes progress without a cursor.
		const second = await pruneAuditLog(db, 30, NOW);
		expect(second).toEqual({ deleted: 5, more: false });
		expect(count()).toBe(0);
	});

	it("honours a caller-supplied batch size", async () => {
		for (let i = 0; i < 6; i++) addAudit(`a-${i}`, ageDays(100));

		expect(await pruneAuditLog(db, 30, NOW, 2)).toEqual({
			deleted: 2,
			more: true,
		});
		expect(count()).toBe(4);
	});

	it("deletes the oldest rows first", async () => {
		addAudit("a-newest", ageDays(31));
		addAudit("a-oldest", ageDays(900));
		addAudit("a-middle", ageDays(200));

		await pruneAuditLog(db, 30, NOW, 1);

		expect(ids()).toEqual(["a-middle", "a-newest"]);
	});
});

describe("auditRetentionStats", () => {
	it("reports totals and the oldest row", async () => {
		addAudit("a-old", ageDays(400));
		addAudit("a-new", ageDays(1));

		const stats = await auditRetentionStats(db, 30, NOW);

		expect(stats).toEqual({
			retention_days: 30,
			enabled: true,
			pending: 1,
			total: 2,
			oldest: ageDays(400),
		});
	});

	// With retention off the cutoff is `now`, so a live `pending` would count
	// nearly every row and read as a purge that will never run.
	it("zeroes pending when retention is off but keeps the totals live", async () => {
		addAudit("a-old", ageDays(400));

		const stats = await auditRetentionStats(db, 0, NOW);

		expect(stats).toMatchObject({
			enabled: false,
			pending: 0,
			total: 1,
			oldest: ageDays(400),
		});
	});

	it("reports a null oldest for an empty log", async () => {
		const stats = await auditRetentionStats(db, 30, NOW);

		expect(stats).toMatchObject({ total: 0, oldest: null, pending: 0 });
	});
});

describe("runAuditRetention", () => {
	// The cron pass stamps its own `now`, so the clock has to be pinned to the
	// instant the fixture rows are aged against.
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		// `vi.spyOn` on the same method returns the same spy across tests in a
		// file, so recorded calls survive unless they're cleared. Without this a
		// "logs nothing" assertion passes or fails based on what an earlier test
		// logged.
		vi.restoreAllMocks();
	});

	const mkEnv = (vars: Record<string, string> = {}) =>
		({
			DB: db,
			TREE_CACHE: { get: async () => null, put: async () => {} },
			...vars,
		}) as never;

	const setSetting = (key: string, value: string) =>
		sqlite
			.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)")
			.run(key, value, NOW);

	it("does nothing, and says nothing, when retention is unset", async () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		const info = vi.spyOn(log, "info").mockImplementation(() => {});
		addAudit("a-old", ageDays(400));

		await runAuditRetention(mkEnv());

		expect(count()).toBe(1);
		expect(warn).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
	});

	// An operator who asked for a sweep and isn't getting one needs to hear about
	// it — this is the one misconfiguration that fails silently otherwise.
	it("warns once per tick when the window is non-zero but below the floor", async () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		addAudit("a-old", ageDays(400));
		setSetting("audit_log_retention_days", "7");

		await runAuditRetention(mkEnv());

		expect(count()).toBe(1);
		expect(warn).toHaveBeenCalledWith("audit_retention.below_floor", {
			retention_days: 7,
			min_days: MIN_AUDIT_RETENTION_DAYS,
		});
	});

	it("prunes and logs when a valid window is set via the env var", async () => {
		const info = vi.spyOn(log, "info").mockImplementation(() => {});
		addAudit("a-old", ageDays(400));
		addAudit("a-new", ageDays(2));

		await runAuditRetention(mkEnv({ AUDIT_LOG_RETENTION_DAYS: "30" }));

		expect(ids()).toEqual(["a-new"]);
		expect(info).toHaveBeenCalledWith("audit_retention.swept", {
			retention_days: 30,
			deleted: 1,
			more: false,
		});
	});

	it("lets a settings row override the env default", async () => {
		addAudit("a-90d", ageDays(90));
		setSetting("audit_log_retention_days", "365");

		await runAuditRetention(mkEnv({ AUDIT_LOG_RETENTION_DAYS: "30" }));

		// 90 days old is inside a 365-day window, so the settings row won.
		expect(count()).toBe(1);
	});

	it("stays quiet on a tick that finds nothing to prune", async () => {
		const info = vi.spyOn(log, "info").mockImplementation(() => {});
		addAudit("a-new", ageDays(2));

		await runAuditRetention(mkEnv({ AUDIT_LOG_RETENTION_DAYS: "30" }));

		expect(count()).toBe(1);
		expect(info).not.toHaveBeenCalled();
	});

	// MAX_BATCHES_PER_TICK is 5, so one tick drains at most 5 * BATCH and leaves
	// the rest to the next tick rather than running unbounded.
	it("bounds one tick to five batches", async () => {
		vi.spyOn(log, "info").mockImplementation(() => {});
		const total = AUDIT_RETENTION_BATCH * 5 + 10;
		for (let i = 0; i < total; i++) {
			addAudit(`a-${String(i).padStart(5, "0")}`, ageDays(100));
		}

		await runAuditRetention(mkEnv({ AUDIT_LOG_RETENTION_DAYS: "30" }));

		expect(count()).toBe(10);
	});
});
