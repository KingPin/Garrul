/**
 * PATCH /api/v1/comments/:id re-runs the anti-spam pass (M4).
 *
 * The edit path used to run none of `evaluateSpam`, never reset `status` and
 * never looked at the current one. So the play was: post something benign, get
 * `approved`, then rewrite the body into anything at all inside
 * `edit_window_minutes` — `bustTreeCache` published it immediately, with no
 * moderator in the loop. An edit can now send a comment back to the queue, but
 * never pull one out of it.
 *
 * Real SQLite (every migration applied) + the mock Cache API the limiter needs,
 * so both the status transitions and the persisted verdict rows are the real
 * ones.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
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

const SID = "a".repeat(64);
const USER = "01HU000000000000000000";
const ADMIN_SID = "c".repeat(64);
const ADMIN = "01HU0000000000000000AD";
const SLUG = "edited";
const COMMENT = "01HC000000000000000000";

const makeSessions = () => ({
	async get(key: string) {
		const userId =
			key === `sess:${SID}` ? USER : key === `sess:${ADMIN_SID}` ? ADMIN : null;
		if (!userId) return null;
		return JSON.stringify({ user_id: userId, expires_at: 4_102_444_800_000 });
	},
	async put() {},
	async delete() {},
});

let sqlite: DatabaseSync;
let env: Bindings;

const baseEnv = (): Record<string, unknown> => ({
	DB: makeD1(sqlite),
	TREE_CACHE: makeKv(),
	SESSIONS: makeSessions(),
	ANALYTICS: { writeDataPoint() {} },
	ENV: "dev",
	EDIT_WINDOW_MINUTES: "15",
	IP_HASH_SECRET: "test-secret",
	// 0 = flag any comment carrying a link. The cheapest deterministic heuristic
	// to drive the pass with — no network, no provider credentials.
	SPAM_LINK_THRESHOLD: "0",
});

beforeEach(() => {
	installMockCaches();
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	const user = sqlite.prepare(
		`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	user.run(USER, "anon", null, "Tester", 0, "user", 1_700_000_000_000);
	user.run(ADMIN, "github", "9", "Op", 1, "admin", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Edited", "https://blog.example/edited", 1_700_000_000_000);
	env = baseEnv() as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const patch = (id: string, body: string, sid = SID) =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", comments)
		.request(
			`/${id}`,
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					cookie: `garrul_sess=${sid}`,
				},
				body: JSON.stringify({ body }),
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);

const seed = (opts: { status?: string; owner?: string; id?: string } = {}) => {
	const id = opts.id ?? COMMENT;
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'harmless', '<p>harmless</p>', 1, ?, ?, 1)`,
		)
		.run(id, SLUG, opts.owner ?? USER, opts.status ?? "approved", Date.now());
	return id;
};

const statusOf = (id: string): string =>
	(sqlite.prepare("SELECT status FROM comments WHERE id = ?").get(id) as {
		status: string;
	}).status;

const bodyOf = (id: string): string =>
	(sqlite.prepare("SELECT body_md FROM comments WHERE id = ?").get(id) as {
		body_md: string;
	}).body_md;

const verdictsFor = (id: string): { source: string; verdict: string }[] =>
	sqlite
		.prepare("SELECT source, verdict FROM spam_verdicts WHERE comment_id = ?")
		.all(id) as { source: string; verdict: string }[];

describe("PATCH /comments/:id — spam re-evaluation", () => {
	it("sends an approved comment back to the queue when the edit trips a heuristic", async () => {
		const id = seed();
		const res = await patch(id, "now with https://spam.example/buy");
		expect(res.status).toBe(200);
		expect(statusOf(id)).toBe("pending");
		// The body is still saved — it's held for moderation, not rejected.
		expect(bodyOf(id)).toBe("now with https://spam.example/buy");
		// And the response reflects the new status rather than the stale one.
		const payload = (await res.json()) as { comment: { status: string } };
		expect(payload.comment.status).toBe("pending");
	});

	it("leaves a clean edit approved", async () => {
		const id = seed();
		expect((await patch(id, "still harmless, just longer")).status).toBe(200);
		expect(statusOf(id)).toBe("approved");
	});

	it("cannot promote a pending comment to approved", async () => {
		// The laundering case in reverse: a quarantined comment edited into
		// something benign still needs a moderator.
		const id = seed({ status: "pending" });
		expect((await patch(id, "totally fine now, honest")).status).toBe(200);
		expect(statusOf(id)).toBe("pending");
	});

	it("persists the verdict so the moderator sees why it was held", async () => {
		const id = seed();
		await patch(id, "link: https://spam.example/buy");
		const rows = verdictsFor(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ source: "heuristics", verdict: "spam" });
	});

	it("does not flag an edit for a missing form timestamp", async () => {
		// The timing heuristic is a submission-time signal and a *missing* token
		// flags. An edit carries no freshly-rendered form, so leaving the check on
		// would quarantine every single edit.
		env = {
			...baseEnv(),
			SPAM_LINK_THRESHOLD: "-1",
			SPAM_FORM_TS_SECRET: "form-secret",
			SPAM_HONEYPOT_MIN_MS: "2000",
		} as unknown as Bindings;
		const id = seed();
		expect((await patch(id, "an ordinary correction")).status).toBe(200);
		expect(statusOf(id)).toBe("approved");
		expect(verdictsFor(id)).toHaveLength(0);
	});

	it("skips the pass for an admin author", async () => {
		const id = seed({ owner: ADMIN });
		expect(
			(await patch(id, "admin link https://spam.example/buy", ADMIN_SID)).status,
		).toBe(200);
		expect(statusOf(id)).toBe("approved");
		expect(verdictsFor(id)).toHaveLength(0);
	});

	it("404s an edit to a deleted comment", async () => {
		const id = seed({ status: "deleted" });
		const res = await patch(id, "resurrect me");
		expect(res.status).toBe(404);
		expect(bodyOf(id)).toBe("harmless");
	});

	it("404s an edit to a spam-marked comment", async () => {
		// 404, not 403: the response must not confirm what a moderator decided.
		const id = seed({ status: "spam" });
		const res = await patch(id, "try again");
		expect(res.status).toBe(404);
		expect(bodyOf(id)).toBe("harmless");
	});
});
