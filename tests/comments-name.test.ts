/**
 * validName strips control characters (M14).
 *
 * `.trim()` only removes whitespace, so a display name could carry a C0 control
 * into `users.name` — and from there into the Atom feed, where XML 1.0 cannot
 * represent it at all and one occurrence is a fatal well-formedness error for
 * the whole document (see tests/feed-xml.test.ts). The feed strips again at
 * serialization because OAuth display names never pass through here, but a
 * stored name shouldn't carry them in the first place.
 *
 * The name check runs before the Turnstile-token check, so an anonymous POST is
 * enough to exercise it without a siteverify stub.
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

// loadFlags reads and writes the resolved-settings entry on TREE_CACHE.
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

const SLUG = "named";
const CTRL = String.fromCharCode(1);

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
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "Named", null, 1_700_000_000_000);
	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		ANALYTICS: { writeDataPoint() {} },
		ENV: "dev",
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});
afterEach(() => uninstallMockCaches());

const execCtx = {
	waitUntil() {},
	passThroughOnException() {},
} as unknown as ExecutionContext;

const post = (bodyObj: Record<string, unknown>) =>
	new Hono<{ Bindings: Bindings }>().route("/", comments).request(
		"/",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(bodyObj),
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

describe("POST /comments — name validation", () => {
	it("rejects a name made only of control characters", async () => {
		// Proof the strip runs: without it this name is non-empty and passes.
		const res = await post({
			slug: SLUG,
			name: `${CTRL}${CTRL}`,
			body: "a perfectly ordinary comment",
		});
		expect(res.status).toBe(400);
	});

	it("still rejects an empty name the same way", async () => {
		const res = await post({ slug: SLUG, name: "  ", body: "ordinary body" });
		expect(res.status).toBe(400);
	});

	it("lets a clean name through to the Turnstile check", async () => {
		// 400 either way, but a *different* 400 — this one is the missing token,
		// which means the name was accepted.
		const withCtrl = await post({
			slug: SLUG,
			name: `Bob${CTRL}`,
			body: "ordinary body",
		});
		const clean = await post({ slug: SLUG, name: "Bob", body: "ordinary body" });
		expect(await withCtrl.json()).toEqual(await clean.json());
	});
});
