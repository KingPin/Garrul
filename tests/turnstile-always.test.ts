/**
 * `turnstile_always` — the operator opt-in that challenges signed-in
 * commenters too, instead of only anonymous ones.
 *
 * Three properties are worth pinning, and they are the three ways this can go
 * wrong rather than three restatements of the feature:
 *
 *   1. OFF is the upgrade-safe default. A signed-in author on an install that
 *      never touched the flag still posts without a token.
 *   2. ON actually verifies. Not just "a token was present" — a token siteverify
 *      rejects has to fail the POST, or the flag is theatre.
 *   3. ON without TURNSTILE_SITE_KEY is inert. The widget only renders a
 *      challenge when the config route hands it a site key, so an install that
 *      flipped the flag without configuring Turnstile would otherwise reject
 *      every comment from a composer that has no way to produce a token —
 *      turning a tightening dial into an outage.
 *
 * Real SQLite with every migration applied, so the accept path proves a row
 * actually landed rather than that a handler returned 201.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { comments } from "../src/routes/api.comments";
import { config } from "../src/routes/api.config";
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

const SLUG = "always";
const USER_ID = "01HU00000000000000ACTIVE";
const SID = "a".repeat(64);

const makeSessions = () => ({
	async get(key: string) {
		if (key.replace(/^sess:/, "") !== SID) return null;
		return JSON.stringify({
			user_id: USER_ID,
			expires_at: 4_102_444_800_000,
		});
	},
	async put() {},
	async delete() {},
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

let sqlite: DatabaseSync;
let siteverify: ReturnType<typeof vi.fn>;

/**
 * Stubs global fetch for the siteverify call. `ENV: "dev"` below is why the
 * fake answers with `example.com`: the handler expects Cloudflare's test-key
 * hostname in dev, and returning anything else would fail the hostname check
 * for a reason that has nothing to do with what each test is asserting.
 */
const stubSiteverify = (success: boolean) => {
	siteverify = vi.fn(async () =>
		Response.json({ success, hostname: "example.com" }),
	);
	vi.stubGlobal("fetch", siteverify);
};

const makeEnv = (extra: Record<string, unknown> = {}): Bindings =>
	({
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		EDIT_WINDOW_MINUTES: "15",
		IP_HASH_SECRET: "test-secret",
		TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
		TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
		...extra,
	}) as unknown as Bindings;

beforeEach(() => {
	installMockCaches();
	stubSiteverify(true);
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_banned, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(USER_ID, "github", "1", "Reader", 0, 1_700_000_000_000);
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Always", null, 1_700_000_000_000);
});

afterEach(() => {
	uninstallMockCaches();
	vi.unstubAllGlobals();
});

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const postSignedIn = async (
	env: Bindings,
	body: Record<string, unknown> = {},
): Promise<Response> =>
	new Hono<{ Bindings: Bindings }>().route("/", comments).request(
		"/",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: `garrul_sess=${SID}`,
			},
			body: JSON.stringify({ slug: SLUG, body: "hello", ...body }),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const countComments = (): number =>
	(sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number })
		.n;

describe("POST /comments — turnstile_always OFF (default)", () => {
	it("accepts a signed-in author with no token", async () => {
		const res = await postSignedIn(makeEnv());
		expect(res.status).toBe(201);
		expect(countComments()).toBe(1);
		// Nothing was asked of Cloudflare either — the default path must not
		// spend an outbound siteverify per signed-in comment.
		expect(siteverify).not.toHaveBeenCalled();
	});
});

describe("POST /comments — turnstile_always ON", () => {
	it("refuses a signed-in author with no token", async () => {
		const res = await postSignedIn(makeEnv({ TURNSTILE_ALWAYS: "true" }));
		expect(res.status).toBe(400);
		expect(countComments()).toBe(0);
	});

	it("refuses a token siteverify rejects", async () => {
		stubSiteverify(false);
		const res = await postSignedIn(makeEnv({ TURNSTILE_ALWAYS: "true" }), {
			turnstile_token: "forged",
		});
		expect(res.status).toBe(400);
		expect(countComments()).toBe(0);
		expect(siteverify).toHaveBeenCalled();
	});

	it("accepts a signed-in author with a verified token", async () => {
		const res = await postSignedIn(makeEnv({ TURNSTILE_ALWAYS: "true" }), {
			turnstile_token: "solved",
		});
		expect(res.status).toBe(201);
		expect(countComments()).toBe(1);
		expect(siteverify).toHaveBeenCalled();
	});

	it("stays inert without a site key, rather than blocking every comment", async () => {
		const res = await postSignedIn(
			makeEnv({ TURNSTILE_ALWAYS: "true", TURNSTILE_SITE_KEY: "" }),
		);
		expect(res.status).toBe(201);
		expect(countComments()).toBe(1);
	});
});

describe("GET /config — turnstile_always", () => {
	const getConfig = async (
		extra: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> => {
		const res = await new Hono<{ Bindings: Bindings }>()
			.route("/", config)
			.request(
				"/",
				{},
				makeEnv(extra) as unknown as Record<string, unknown>,
			);
		return (await res.json()) as Record<string, unknown>;
	};

	it("is false by default", async () => {
		expect((await getConfig()).turnstile_always).toBe(false);
	});

	it("is true when the operator opted in", async () => {
		expect(
			(await getConfig({ TURNSTILE_ALWAYS: "true" })).turnstile_always,
		).toBe(true);
	});

	it("stays false without a site key, matching what POST will enforce", async () => {
		// The widget decides whether to render a challenge from this field. If it
		// disagreed with the POST handler, one of the two would be wrong on every
		// request — so both resolve the same predicate.
		expect(
			(
				await getConfig({
					TURNSTILE_ALWAYS: "true",
					TURNSTILE_SITE_KEY: "",
				})
			).turnstile_always,
		).toBe(false);
	});
});
