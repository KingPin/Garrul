/**
 * POST /admin/api/ops/import-disqus — the upload behind the Operator card.
 *
 * Exercised through the real Hono route against real SQLite, because what
 * matters here is the order the route does things in, and unit tests on the
 * pieces cannot see it:
 *
 *   - The gunzip runs *before* the `not_disqus_xml` format sniff. A `.xml.gz`
 *     whose first bytes are 1f 8b matches none of the XML patterns, so a
 *     decode placed after the sniff rejects every gzipped export with a
 *     misleading "not a Disqus export".
 *   - A decompression bomb answers 413, not 500-after-allocating. The two
 *     size checks above the decode bound the *compressed* body; if the
 *     inflate is not also capped, an authenticated admin upload of a few KB
 *     is an unbounded allocation inside the Worker.
 *   - Rows actually land, so the whole chain — decode, parse, adapter,
 *     core, D1 — is wired together rather than merely type-compatible.
 */
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_IMPORT_BYTES } from "../src/lib/import/core";
import type { Bindings } from "../src/index";
import { admin } from "../src/routes/admin";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const NOW = Date.now();

const ADMIN_SID = "a".repeat(64);
const ADMIN_ID = "01HADMIN0000000000000000AB";

const XML = `<disqus>
  <thread dsq:id="t1"><link>https://example.com/hello</link><title>Hello</title></thread>
  <post dsq:id="p1">
    <message><![CDATA[<p>first</p>]]></message>
    <createdAt>2026-01-01T00:00:00Z</createdAt>
    <isDeleted>false</isDeleted><isSpam>false</isSpam>
    <author><name>Ada</name><isAnonymous>true</isAnonymous></author>
    <thread dsq:id="t1" />
  </post>
</disqus>`;

const gzip = async (s: string): Promise<Uint8Array> => {
	const src = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(new TextEncoder().encode(s));
			c.close();
		},
	});
	const buf = await new Response(
		src.pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	return new Uint8Array(buf);
};

const makeD1 = (db: DatabaseSync): unknown => ({
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
			return JSON.stringify({
				user_id: ADMIN_ID,
				expires_at: 4_102_444_800_000,
			});
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
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
			                    is_admin, role, created_at)
			 VALUES (?, 'github', '1', 'Op', NULL, NULL, 1, 'admin', ?)`,
		)
		.run(ADMIN_ID, NOW);

	env = {
		DB: makeD1(sqlite),
		TREE_CACHE: makeKv(),
		SESSIONS: makeSessions(),
		IP_HASH_SECRET: "test-secret",
	} as unknown as Bindings;
});

afterEach(() => uninstallMockCaches());

const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
	new Hono<{ Bindings: Bindings }>().route("/admin", admin).request(
		"/admin/api/ops/import-disqus",
		{
			method: "POST",
			headers: {
				"content-type": "application/xml",
				cookie: `__Host-garrul_sess=${ADMIN_SID}`,
				origin: "http://localhost",
				...headers,
			},
			body,
		},
		env as unknown as Record<string, unknown>,
		execCtx,
	);

const commentCount = (): number =>
	(
		sqlite.prepare("SELECT COUNT(*) AS n FROM comments").get() as {
			n: number;
		}
	).n;

describe("POST /admin/api/ops/import-disqus", () => {
	it("imports a plain XML upload", async () => {
		const res = await upload(XML);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plan: { new_comments: number; new_pages: number };
		};
		expect(body.plan.new_comments).toBe(1);
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("imports a gzipped upload identically", async () => {
		// The decode has to run before the format sniff: a gzip member starts
		// 1f 8b and matches none of the <disqus|thread|post patterns.
		const res = await upload(await gzip(XML));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("answers 413 for a decompression bomb rather than inflating it", async () => {
		const bomb = await gzip("A".repeat(MAX_IMPORT_BYTES + 1024));
		// A few KB on the wire, so both size checks above the decode pass.
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		const res = await upload(bomb);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
		expect(commentCount()).toBe(0);
	});

	it("still rejects a file that is neither gzip nor a Disqus export", async () => {
		const res = await upload("just some notes");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_disqus_xml" });
	});

	it("rejects a corrupt gzip member as not-a-Disqus-export", async () => {
		const u8 = await gzip(XML);
		u8[u8.length - 5] = (u8.at(-5) ?? 0) ^ 0xff; // wreck the trailing CRC32
		const res = await upload(u8);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_disqus_xml" });
	});

	it("is idempotent across a plain and a gzipped upload of the same file", async () => {
		expect((await upload(XML)).status).toBe(200);
		const res = await upload(await gzip(XML));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(0);
		expect(commentCount()).toBe(1);
	});

	it("writes nothing on a dry run", async () => {
		const res = await upload(await gzip(XML), { "x-dry-run": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dry_run: boolean;
			plan: { new_comments: number };
		};
		expect(body.dry_run).toBe(true);
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(0);
	});
});
