/**
 * IP-hash retention sweep, against real SQLite with every migration applied.
 *
 * Real SQLite rather than the substring-routing D1 stubs, for two reasons the
 * stubs structurally can't cover:
 *
 *   - Every assertion here is "did this column actually get cleared, and did
 *     that one survive". A stub that pattern-matches SQL proves nothing about
 *     which rows an UPDATE ... WHERE id IN (SELECT ... LIMIT ?) touched.
 *   - The sweep NULLs a column inside `UNIQUE (comment_id, reporter_ip_hash)`.
 *     That it doesn't trip depends on SQLite counting NULLs as distinct, which
 *     is a property of the engine, not of our code.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	MIN_RETENTION_DAYS,
	isRetentionEnabled,
	retentionCutoff,
	retentionStats,
	runIpRetention,
	sweepExpiredIpHashes,
} from "../src/db/ip-retention";
import { log } from "../src/lib/log";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

// Minimal D1Database adapter over node:sqlite — prepare().bind().run()/first().
// `meta.changes` matters here: the sweep's batching decision reads it.
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

const addUser = (id: string, provider = "github", providerId = `${id}-pid`) =>
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(id, provider, providerId, id, NOW - 365 * DAY);

const addComment = (
	id: string,
	opts: {
		created_at: number;
		edited_at?: number | null;
		ip_hash?: string | null;
		user_agent?: string | null;
	},
) =>
	sqlite
		.prepare(
			`INSERT INTO comments
			   (id, post_slug, parent_id, user_id, body_md, body_html,
			    renderer_version, status, edited_at, ip_hash, user_agent, created_at)
			 VALUES (?, 'hello', NULL, 'u1', 'hi', '<p>hi</p>', 1, 'approved', ?, ?, ?, ?)`,
		)
		.run(
			id,
			opts.edited_at ?? null,
			opts.ip_hash === undefined ? "iphash" : opts.ip_hash,
			opts.user_agent === undefined ? "ua" : opts.user_agent,
			opts.created_at,
		);

const addReport = (
	id: string,
	opts: {
		comment_id?: string;
		created_at: number;
		ip_hash?: string | null;
		status?: string;
	},
) =>
	sqlite
		.prepare(
			`INSERT INTO reports
			   (id, comment_id, reporter_user_id, reporter_ip_hash, reason,
			    status, created_at)
			 VALUES (?, ?, NULL, ?, 'spam', ?, ?)`,
		)
		.run(
			id,
			opts.comment_id ?? "c1",
			opts.ip_hash === undefined ? `rh-${id}` : opts.ip_hash,
			opts.status ?? "open",
			opts.created_at,
		);

const comment = (id: string) =>
	sqlite
		.prepare("SELECT ip_hash, user_agent FROM comments WHERE id = ?")
		.get(id) as { ip_hash: string | null; user_agent: string | null };

const report = (id: string) =>
	sqlite
		.prepare("SELECT reporter_ip_hash FROM reports WHERE id = ?")
		.get(id) as { reporter_ip_hash: string | null };

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?,?,?,?)")
		.run("hello", "Hello", null, NOW - 400 * DAY);
	addUser("u1");
	db = makeD1(sqlite);
});

describe("retention window arithmetic", () => {
	it("puts the cutoff N days before now", () => {
		expect(retentionCutoff(30, NOW)).toBe(NOW - 30 * DAY);
	});

	// The floor is a refusal, not a clamp — see the comment on MIN_RETENTION_DAYS.
	// A `min: 7` on the setting itself would have rewritten an operator's explicit
	// 0 ("off") into the most destructive value in range.
	it("treats 0 and anything under the floor as not-enabled", () => {
		expect(isRetentionEnabled(0)).toBe(false);
		expect(isRetentionEnabled(1)).toBe(false);
		expect(isRetentionEnabled(MIN_RETENTION_DAYS - 1)).toBe(false);
		expect(isRetentionEnabled(MIN_RETENTION_DAYS)).toBe(true);
		expect(isRetentionEnabled(365)).toBe(true);
	});
});

describe("sweepExpiredIpHashes", () => {
	it("clears ip_hash and user_agent on rows past the window", async () => {
		addComment("c-old", { created_at: ageDays(60) });
		addComment("c-new", { created_at: ageDays(1) });

		const res = await sweepExpiredIpHashes(db, 30, NOW);

		expect(res.comments).toBe(1);
		expect(comment("c-old")).toEqual({ ip_hash: null, user_agent: null });
		expect(comment("c-new")).toEqual({ ip_hash: "iphash", user_agent: "ua" });
	});

	// The clock restarts on an edit: a comment someone just changed is live
	// moderation surface, whatever its original post date.
	it("anchors on edited_at when the comment has been edited", async () => {
		addComment("c-edited", { created_at: ageDays(60), edited_at: ageDays(2) });
		addComment("c-stale-edit", {
			created_at: ageDays(90),
			edited_at: ageDays(60),
		});

		await sweepExpiredIpHashes(db, 30, NOW);

		expect(comment("c-edited").ip_hash).toBe("iphash");
		expect(comment("c-stale-edit").ip_hash).toBeNull();
	});

	// Age only. Gating on status='resolved' would let an open-and-forgotten
	// report keep its reporter's hash forever, which is the exact problem
	// retention exists to bound.
	it("clears report hashes on age alone, open or resolved", async () => {
		addComment("c1", { created_at: ageDays(60) });
		addReport("r-open", { created_at: ageDays(60), status: "open" });
		addReport("r-done", { created_at: ageDays(60), status: "resolved" });
		addReport("r-fresh", { created_at: ageDays(1) });

		const res = await sweepExpiredIpHashes(db, 30, NOW);

		expect(res.reports).toBe(2);
		expect(report("r-open").reporter_ip_hash).toBeNull();
		expect(report("r-done").reporter_ip_hash).toBeNull();
		expect(report("r-fresh").reporter_ip_hash).toBe("rh-r-fresh");
	});

	// UNIQUE (comment_id, reporter_ip_hash) would reject a second NULL row if
	// SQLite treated NULLs as equal. It doesn't — and the sweep depends on that,
	// since a popular comment can carry many expired reports.
	it("collapses several reports on one comment to NULL without a UNIQUE conflict", async () => {
		addComment("c1", { created_at: ageDays(60) });
		addReport("r1", { created_at: ageDays(60) });
		addReport("r2", { created_at: ageDays(60) });
		addReport("r3", { created_at: ageDays(60) });

		const res = await sweepExpiredIpHashes(db, 30, NOW);

		expect(res.reports).toBe(3);
		for (const id of ["r1", "r2", "r3"]) {
			expect(report(id).reporter_ip_hash).toBeNull();
		}
	});

	// The load-bearing exclusion. For a signed-out visitor the hashed IP *is*
	// the account: (provider, provider_id) is how a returning visitor resolves
	// to their existing ghost, so expiring it on a timer would delete accounts,
	// stop ghost bans applying, and reset vote/reaction dedup for everyone.
	it("never touches anonymous ghost provider_id", async () => {
		addUser("ghost", "anon", "ghost-ip-hash");
		addComment("c-old", { created_at: ageDays(400) });

		await sweepExpiredIpHashes(db, MIN_RETENTION_DAYS, NOW);

		const row = sqlite
			.prepare("SELECT provider_id FROM users WHERE id = 'ghost'")
			.get() as { provider_id: string | null };
		expect(row.provider_id).toBe("ghost-ip-hash");
	});

	it("does nothing when retention is off or below the floor", async () => {
		addComment("c-ancient", { created_at: ageDays(3650) });
		addReport("r-ancient", {
			comment_id: "c-ancient",
			created_at: ageDays(3650),
		});

		for (const days of [0, 1, MIN_RETENTION_DAYS - 1]) {
			const res = await sweepExpiredIpHashes(db, days, NOW);
			expect(res).toEqual({ comments: 0, reports: 0, more: false });
		}
		expect(comment("c-ancient").ip_hash).toBe("iphash");
		expect(report("r-ancient").reporter_ip_hash).toBe("rh-r-ancient");
	});

	// No cursor: the predicate is self-draining, because a swept row stops
	// matching its own WHERE clause. Repeating the identical batch has to make
	// progress and eventually report nothing left.
	it("reports more work after a full batch and drains on repeat calls", async () => {
		for (let i = 0; i < 5; i++) {
			addComment(`c${i}`, { created_at: ageDays(60) });
		}

		const first = await sweepExpiredIpHashes(db, 30, NOW, 2);
		expect(first).toEqual({ comments: 2, reports: 0, more: true });

		const second = await sweepExpiredIpHashes(db, 30, NOW, 2);
		expect(second.comments).toBe(2);
		expect(second.more).toBe(true);

		const third = await sweepExpiredIpHashes(db, 30, NOW, 2);
		expect(third).toEqual({ comments: 1, reports: 0, more: false });

		const drained = sqlite
			.prepare("SELECT COUNT(*) AS n FROM comments WHERE ip_hash IS NOT NULL")
			.get() as { n: number };
		expect(drained.n).toBe(0);
	});

	// A row with the hash already gone but a user_agent still set is past the
	// window too — the two columns are written together and cleared together.
	it("sweeps a row whose user_agent outlived its ip_hash", async () => {
		addComment("c-ua-only", {
			created_at: ageDays(60),
			ip_hash: null,
			user_agent: "ua",
		});

		const res = await sweepExpiredIpHashes(db, 30, NOW);

		expect(res.comments).toBe(1);
		expect(comment("c-ua-only").user_agent).toBeNull();
	});
});

describe("retentionStats", () => {
	it("counts what is past the window, what still holds a hash, and ghosts", async () => {
		addComment("c-old", { created_at: ageDays(60) });
		addComment("c-new", { created_at: ageDays(1) });
		addReport("r-old", { comment_id: "c-old", created_at: ageDays(60) });
		addUser("g1", "anon", "gh1");
		addUser("g2", "anon", "gh2");

		const s = await retentionStats(db, 30, NOW);

		expect(s).toEqual({
			retention_days: 30,
			enabled: true,
			comments_pending: 1,
			reports_pending: 1,
			comments_total: 2,
			ghosts_total: 2,
		});
	});

	// With retention off the cutoff is `now`, so a raw pending count would match
	// essentially every row and read on the operator page as a purge about to
	// happen. It never will. The totals stay live — those are what an operator
	// deciding whether to switch this on actually needs.
	it("zeroes the pending counts while retention is off, keeping the totals", async () => {
		addComment("c-old", { created_at: ageDays(60) });
		addReport("r-old", { comment_id: "c-old", created_at: ageDays(60) });
		addUser("g1", "anon", "gh1");

		const off = await retentionStats(db, 0, NOW);

		expect(off.enabled).toBe(false);
		expect(off.comments_pending).toBe(0);
		expect(off.reports_pending).toBe(0);
		expect(off.comments_total).toBe(1);
		expect(off.ghosts_total).toBe(1);
	});

	it("zeroes the pending counts for a below-floor window too", async () => {
		addComment("c-old", { created_at: ageDays(60) });

		const s = await retentionStats(db, MIN_RETENTION_DAYS - 1, NOW);

		expect(s.enabled).toBe(false);
		expect(s.comments_pending).toBe(0);
		expect(s.comments_total).toBe(1);
	});
});

// The cron pass: settings resolution + the per-tick batch loop. `loadNumbers`
// runs for real against the settings table, so "env var drives it" and "a DB
// row beats the env var" are exercised end to end rather than assumed.
describe("runIpRetention", () => {
	// The cron pass stamps its own `now` (unlike the sweep, which takes one), so
	// the clock has to be pinned to the same instant the fixture rows are aged
	// against or every row reads as decades expired.
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const mkEnv = (vars: Record<string, string> = {}) =>
		({
			DB: db,
			// Cold cache every call; the put is where loadNumbers would warm it.
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
		addComment("c-old", { created_at: ageDays(400) });

		await runIpRetention(mkEnv());

		expect(comment("c-old").ip_hash).toBe("iphash");
		// Off is the default, so an instance that never opted in must not log
		// every 15 minutes forever.
		expect(warn).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
		warn.mockRestore();
		info.mockRestore();
	});

	it("sweeps on the env-var window", async () => {
		addComment("c-old", { created_at: ageDays(400) });
		addComment("c-new", { created_at: ageDays(2) });

		await runIpRetention(mkEnv({ IP_HASH_RETENTION_DAYS: "30" }));

		expect(comment("c-old").ip_hash).toBeNull();
		expect(comment("c-new").ip_hash).toBe("iphash");
	});

	it("lets a settings row override the env var", async () => {
		setSetting("ip_hash_retention_days", "0");
		addComment("c-old", { created_at: ageDays(400) });

		await runIpRetention(mkEnv({ IP_HASH_RETENTION_DAYS: "30" }));

		expect(comment("c-old").ip_hash).toBe("iphash");
	});

	// A non-zero value under the floor means the operator asked for a sweep and
	// isn't getting one. That's the one case worth a log line every tick.
	it("warns instead of sweeping when the window is below the floor", async () => {
		const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
		addComment("c-old", { created_at: ageDays(400) });

		await runIpRetention(mkEnv({ IP_HASH_RETENTION_DAYS: "1" }));

		expect(comment("c-old").ip_hash).toBe("iphash");
		expect(warn).toHaveBeenCalledWith(
			"ip_retention.below_floor",
			expect.objectContaining({ retention_days: 1 }),
		);
		warn.mockRestore();
	});
});
