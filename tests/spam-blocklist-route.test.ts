/**
 * The muted-words list on the live POST path.
 *
 * tests/spam-blocklist.test.ts covers the matcher in isolation; this covers the
 * two things only an end-to-end run can prove: that a hit actually routes the
 * comment to `pending` (and that a miss does not), and that the list travels
 * the full precedence chain — a `settings` row beating the env-var default —
 * now that `texts` is a fourth settings group with its own resolver and its own
 * slot in the cached blob.
 *
 * Real SQLite with every migration applied, so the persisted verdict rows are
 * the real ones. A session cookie is used rather than an anonymous post
 * because the Turnstile check only guards the anonymous branch.
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

// Counts reads of the resolved-settings entry, which is what makes the
// "one settings read per request" test below possible. Every `load*` helper is
// its own `get` against this one key, so the counter is the only thing that can
// tell "read the blob once and destructured it" apart from "called three
// helpers" — both produce identical responses.
const settingsReads = { count: 0 };

const makeKv = () => {
	const store = new Map<string, string>();
	return {
		async get(key: string, type?: "json") {
			if (key === "settings:resolved") settingsReads.count++;
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

const SID = "a".repeat(64);
const USER = "01HU000000000000000000";
const SPAMMER_SID = "b".repeat(64);
const SPAMMER = "01HU0000000000000000SP";
const SLUG = "muted";

const makeSessions = () => ({
	async get(key: string) {
		const userId =
			key === `sess:${SID}` ? USER : key === `sess:${SPAMMER_SID}` ? SPAMMER : null;
		if (!userId) return null;
		return JSON.stringify({ user_id: userId, expires_at: 4_102_444_800_000 });
	},
	async put() {},
	async delete() {},
});

let sqlite: DatabaseSync;
let env: Bindings;

beforeEach(() => {
	installMockCaches();
	settingsReads.count = 0;
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
	user.run(SPAMMER, "anon", null, "Casino Bot", 0, "user", 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Muted", "https://blog.example/muted", 1_700_000_000_000);
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
		SPAM_BLOCKLIST: "# operator notes\nviagra\n*casino*\nt.me/*",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const post = (body: string, sid = SID) =>
	new Hono<{ Bindings: Bindings }>().route("/", comments).request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json", cookie: `garrul_sess=${sid}` },
			body: JSON.stringify({ slug: SLUG, body }),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const setSetting = (key: string, value: string) =>
	sqlite
		.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
		.run(key, value, Date.now());

const latest = (): { id: string; status: string } =>
	sqlite
		.prepare("SELECT id, status FROM comments ORDER BY created_at DESC, id DESC LIMIT 1")
		.get() as { id: string; status: string };

const verdictsFor = (id: string) =>
	sqlite
		.prepare("SELECT source, verdict, raw FROM spam_verdicts WHERE comment_id = ?")
		.all(id) as { source: string; verdict: string; raw: string | null }[];

describe("POST /comments — muted words", () => {
	it("holds a comment whose body trips a term", async () => {
		const res = await post("cheap viagra here");
		expect(res.status).toBe(201);
		const row = latest();
		expect(row.status).toBe("pending");
		// Held, not dropped — the text is still stored for the moderator to see.
		const verdict = verdictsFor(row.id).find((v) => v.source === "heuristics");
		expect(verdict?.verdict).toBe("spam");
		expect(JSON.parse(verdict?.raw ?? "{}").blocklist).toEqual({
			term: "viagra",
			field: "body",
		});
	});

	it("approves a comment that trips nothing", async () => {
		const res = await post("a perfectly ordinary comment about gardening");
		expect(res.status).toBe(201);
		expect(latest().status).toBe("approved");
	});

	it("does not fire on a substring of a longer word", async () => {
		// `viagra` is bare, so it is word-anchored. Without that anchoring this is
		// the Scunthorpe problem with extra steps.
		expect((await post("the viagraceous compound")).status).toBe(201);
		expect(latest().status).toBe("approved");
	});

	it("matches the author name, not just the body", async () => {
		await post("hello, nice post", SPAMMER_SID);
		const row = latest();
		expect(row.status).toBe("pending");
		const verdict = verdictsFor(row.id).find((v) => v.source === "heuristics");
		expect(JSON.parse(verdict?.raw ?? "{}").blocklist.field).toBe("name");
	});

	it("lets a settings row override the env-var default", async () => {
		// The precedence chain end to end for the new `texts` group: the env list
		// above does not contain "gardening" and does contain "viagra".
		setSetting("spam_blocklist", "gardening");
		expect((await post("cheap viagra here")).status).toBe(201);
		expect(latest().status).toBe("approved");
		expect((await post("a post about gardening")).status).toBe(201);
		expect(latest().status).toBe("pending");
	});

	it("records a clean heuristics verdict when the list is empty", async () => {
		// An empty list must not add a `blocklist` key at all — an operator
		// reading a verdict should not see a signal that never ran.
		setSetting("spam_blocklist", "");
		const res = await post("cheap viagra here");
		expect(res.status).toBe(201);
		const row = latest();
		expect(row.status).toBe("approved");
		const verdict = verdictsFor(row.id).find((v) => v.source === "heuristics");
		expect(verdict === undefined || !("blocklist" in JSON.parse(verdict.raw ?? "{}"))).toBe(
			true,
		);
	});

	it("resolves settings with a single KV read", async () => {
		// The handler needs three groups: `flags` to gate comments_enabled,
		// `numbers` for the thread-close rules, `texts` for this list. They live in
		// one KV entry, but `loadFlags`/`loadNumbers`/`loadTexts` each fetch it
		// separately — so reaching for a per-group helper here (or inside
		// `evaluateSpam`, which is where the muted-words check would most naturally
		// have loaded it) silently adds a round trip to the hottest write path.
		//
		// Pinned as a count rather than left to review: the failure is invisible in
		// every response body, so nothing else in this suite can catch it.
		expect((await post("a perfectly ordinary comment about gardening")).status).toBe(201);
		expect(settingsReads.count).toBe(1);
	});
});
