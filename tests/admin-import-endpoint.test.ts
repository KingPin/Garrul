/**
 * POST /admin/api/ops/import-<source> — the uploads behind the Operator card.
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
 *
 * Every source endpoint is exercised here rather than in a file each,
 * because the three properties above are properties of the *route shape*,
 * not of any one adapter: they were established once for Disqus and a
 * later endpoint that quietly got the order wrong would look identical
 * from the outside. One harness, every source, so the same questions get
 * asked each time one is added.
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

const uploadTo =
	(source: string, contentType: string) =>
	(body: BodyInit, headers: Record<string, string> = {}) =>
		new Hono<{ Bindings: Bindings }>().route("/admin", admin).request(
			`/admin/api/ops/import-${source}`,
			{
				method: "POST",
				headers: {
					"content-type": contentType,
					cookie: `__Host-garrul_sess=${ADMIN_SID}`,
					origin: "http://localhost",
					...headers,
				},
				body,
			},
			env as unknown as Record<string, unknown>,
			execCtx,
		);

const upload = uploadTo("disqus", "application/xml");
const uploadJsonl = uploadTo("remark42", "application/x-ndjson");
const uploadJson = uploadTo("comentario", "application/json");
const uploadIssoJson = uploadTo("isso", "application/json");
const uploadCusdisJson = uploadTo("cusdis", "application/json");

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

// A four-line export: the metadata header, one comment, and the trailing
// newline a JSONL writer leaves behind. Identity-free, like every fixture
// here — invented names on example.com.
const JSONL = [
	JSON.stringify({
		version: 1,
		users: [],
		posts: [{ url: "https://example.com/hello", read_only: false }],
	}),
	JSON.stringify({
		id: "c1",
		pid: "",
		text: "<p>first</p>",
		orig: "first",
		user: { id: "github_9f1", name: "Ada" },
		locator: { site: "lab", url: "https://example.com/hello" },
		time: "2026-01-01T00:00:00Z",
	}),
	"",
].join("\n");

describe("POST /admin/api/ops/import-remark42", () => {
	it("imports a plain JSONL upload", async () => {
		const res = await uploadJsonl(JSONL);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plan: { new_comments: number; new_pages: number };
		};
		expect(body.plan.new_comments).toBe(1);
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("imports a gzipped backup identically", async () => {
		// The shape an operator actually has on disk: `backup` writes
		// userbackup-<site>-<ts>.gz and never a plain file. If the decode sat
		// after the format sniff, the nightly backup — the one artifact this
		// endpoint exists to accept — would be the one it rejected.
		const res = await uploadJsonl(await gzip(JSONL));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("answers 413 for a decompression bomb rather than inflating it", async () => {
		const bomb = await gzip("A".repeat(MAX_IMPORT_BYTES + 1024));
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		const res = await uploadJsonl(bomb);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
		expect(commentCount()).toBe(0);
	});

	it("rejects a file that is neither gzip nor a Remark42 export", async () => {
		const res = await uploadJsonl("just some notes");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_remark42_export" });
	});

	it("rejects a Disqus export sent to the Remark42 endpoint", async () => {
		// Two upload buttons on one card is two chances to pick the wrong
		// one. The sniff has to name the mismatch rather than hand the XML
		// to a JSONL parser and surface whatever it says about line 1.
		const res = await uploadJsonl(XML);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_remark42_export" });
	});

	it("accepts an export whose metadata header was stripped", async () => {
		// The stream API can be pointed at a site and yield comments with no
		// header at all, so the sniff recognises a bare comment object too.
		const res = await uploadJsonl(JSONL.split("\n")[1] ?? "");
		expect(res.status).toBe(200);
		expect(commentCount()).toBe(1);
	});

	it("is idempotent across a plain and a gzipped upload of the same file", async () => {
		expect((await uploadJsonl(JSONL)).status).toBe(200);
		const res = await uploadJsonl(await gzip(JSONL));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(0);
		expect(commentCount()).toBe(1);
	});

	it("writes nothing on a dry run", async () => {
		const res = await uploadJsonl(JSONL, { "x-dry-run": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dry_run: boolean;
			plan: { new_comments: number };
		};
		expect(body.dry_run).toBe(true);
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(0);
	});

	it("reports a malformed line by number, never by content", async () => {
		const bad = [JSONL.split("\n")[0], "{ not json"].join("\n");
		const res = await uploadJsonl(bad);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("line 2");
		expect(body.error).not.toContain("not json");
	});
});

// A minimal Comentario v3 document. Identity-free: invented names on
// example.com, and UUIDs that are structurally valid but plainly fake.
const COMENTARIO = JSON.stringify({
	version: 3,
	pages: [
		{
			id: "p0000000-0000-4000-8000-000000000001",
			domainId: "d0000000-0000-4000-8000-000000000001",
			path: "/hello",
			title: "Hello",
			isReadonly: false,
			createdTime: "2026-01-01T00:00:00Z",
		},
	],
	comments: [
		{
			id: "c0000000-0000-4000-8000-000000000001",
			pageId: "p0000000-0000-4000-8000-000000000001",
			markdown: "first",
			html: "<p>first</p>",
			url: "https://example.com/hello#comentario-c0000000-0000-4000-8000-000000000001",
			userCreated: "u0000000-0000-4000-8000-000000000001",
			createdTime: "2026-01-01T00:00:00Z",
			editedTime: "0001-01-01T00:00:00Z",
			isApproved: true,
			isPending: false,
			isDeleted: false,
		},
	],
	commenters: [
		{
			id: "u0000000-0000-4000-8000-000000000001",
			name: "Ada",
			email: "ada@example.com",
			createdTime: "2026-01-01T00:00:00Z",
		},
	],
});

describe("POST /admin/api/ops/import-comentario", () => {
	it("imports a plain JSON upload", async () => {
		const res = await uploadJson(COMENTARIO);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plan: { new_comments: number; new_pages: number };
		};
		expect(body.plan.new_comments).toBe(1);
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("imports a gzipped export identically", async () => {
		// Comentario's admin UI offers the download gzipped, so this is the
		// file an operator actually has. A decode placed after the format
		// sniff would reject exactly that one.
		const res = await uploadJson(await gzip(COMENTARIO));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("answers 413 for a decompression bomb rather than inflating it", async () => {
		const bomb = await gzip("A".repeat(MAX_IMPORT_BYTES + 1024));
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		const res = await uploadJson(bomb);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "too_large" });
		expect(commentCount()).toBe(0);
	});

	it("rejects a file that is neither gzip nor a Comentario export", async () => {
		const res = await uploadJson("just some notes");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_comentario_export" });
	});

	it("rejects a Disqus export sent to the Comentario endpoint", async () => {
		// Three upload targets behind one card is three chances to pick the
		// wrong one, and the sniff has to name the mismatch rather than hand
		// XML to a JSON parser.
		const res = await uploadJson(XML);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_comentario_export" });
	});

	it("rejects a Cusdis dump sent to the Comentario endpoint", async () => {
		// A Cusdis dump is also an object with a `version` key, and the v1
		// adapter parses it as an empty export: no throw, a plan of zeros, an
		// import.comentario audit row. The `source` key is what tells them apart.
		const res = await uploadJson(CUSDIS);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_comentario_export" });
		expect(commentCount()).toBe(0);
	});

	it("is idempotent across a plain and a gzipped upload of the same file", async () => {
		expect((await uploadJson(COMENTARIO)).status).toBe(200);
		const res = await uploadJson(await gzip(COMENTARIO));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(0);
		expect(commentCount()).toBe(1);
	});

	it("writes nothing on a dry run", async () => {
		const res = await uploadJson(COMENTARIO, { "x-dry-run": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dry_run: boolean;
			plan: { new_comments: number };
		};
		expect(body.dry_run).toBe(true);
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(0);
	});

	it("refuses a two-domain export, and names the domains rather than a body", async () => {
		const doc = JSON.parse(COMENTARIO);
		doc.pages.push({
			...doc.pages[0],
			id: "p0000000-0000-4000-8000-000000000002",
			domainId: "d0000000-0000-4000-8000-000000000002",
			path: "/other",
		});
		const res = await uploadJson(JSON.stringify(doc));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("2 distinct domains");
		expect(body.error).not.toContain("first");
		expect(commentCount()).toBe(0);
	});

	it("imports one domain of a two-domain export when the header names it", async () => {
		// The escape hatch the refusal above points at. Without it an
		// operator with a multi-domain export cannot use this card at all.
		const doc = JSON.parse(COMENTARIO);
		doc.pages.push({
			...doc.pages[0],
			id: "p0000000-0000-4000-8000-000000000002",
			domainId: "d0000000-0000-4000-8000-000000000002",
			path: "/other",
		});
		const res = await uploadJson(JSON.stringify(doc), {
			"x-import-domain": "d0000000-0000-4000-8000-000000000001",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_pages: number } };
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("reads a legacy Commento v1 document through the same endpoint", async () => {
		// The version field picks the reader, so both products' exports go to
		// one route. An operator leaving Commento should not have to know it
		// is a different format underneath.
		const v1 = JSON.stringify({
			version: 1,
			comments: [
				{
					commentHex: "aa11",
					commenterHex: "bb22",
					host: "example.com",
					path: "/hello",
					url: "",
					markdown: "first",
					parentHex: "root",
					state: "approved",
					deleted: false,
					creationDate: "2026-01-01T00:00:00Z",
				},
			],
			commenters: [
				{ commenterHex: "bb22", name: "Ada", email: "ada@example.com" },
			],
		});
		const res = await uploadJson(v1);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(1);
		expect(commentCount()).toBe(1);
	});

	it("reports a bad record by position, never by content", async () => {
		const secret = "a-body-that-must-not-come-back";
		const res = await uploadJson(
			`{"version":1,"comments":[{"markdown":"${secret}"}]}`,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("comments[0]");
		expect(body.error).not.toContain(secret);
	});
});

// One thread: a root, a reply to it, a tombstone (mode 4), and a reply to
// the tombstone — the shape --include-deleted exists to preserve.
// Identity-free: invented names on example.com/.org, and the same
// "127.0.0.0" isso itself writes for every anonymised remote_addr.
const ISSO = JSON.stringify([
	{
		id: "/hello",
		title: "Hello",
		comments: [
			{
				id: 1,
				parent: null,
				mode: 1,
				created: "2026-01-01 00:00:00",
				created_epoch: 1767225600,
				modified_epoch: null,
				author: "Ada Example",
				email: "ada@example.com",
				website: null,
				remote_addr: "127.0.0.0",
				text: "first",
			},
			{
				id: 2,
				parent: 1,
				mode: 1,
				created: "2026-01-01 00:05:00",
				created_epoch: 1767225900,
				modified_epoch: null,
				author: "Bob Example",
				email: "bob@example.org",
				website: null,
				remote_addr: "127.0.0.0",
				text: "a reply",
			},
			{
				id: 3,
				parent: null,
				mode: 4,
				created: "2026-01-01 00:10:00",
				created_epoch: 1767226200,
				modified_epoch: null,
				author: null,
				email: null,
				website: null,
				remote_addr: "127.0.0.0",
				text: "",
			},
			{
				id: 4,
				parent: 3,
				mode: 1,
				created: "2026-01-01 00:15:00",
				created_epoch: 1767226500,
				modified_epoch: null,
				author: "Carol Example",
				email: "carol@example.com",
				website: null,
				remote_addr: "127.0.0.0",
				text: "a reply to a deleted comment",
			},
		],
	},
]);

describe("POST /admin/api/ops/import-isso", () => {
	it("imports a plain JSON upload", async () => {
		const res = await uploadIssoJson(ISSO);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plan: { new_comments: number; new_pages: number };
		};
		// Comment 3 is a tombstone, skipped by default (no --include-deleted).
		expect(body.plan.new_comments).toBe(3);
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(3);
	});

	it("imports a gzipped upload identically", async () => {
		const res = await uploadIssoJson(await gzip(ISSO));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(3);
		expect(commentCount()).toBe(3);
	});

	it("accepts a dump whose first thread pushes the comments key past the sniff window", async () => {
		// The sniff reads the first 4 KB. A long title (or a long uri) in the
		// first thread sits before its `comments` key, so a sniff that looked
		// for that key would turn away a dump the adapter reads fine.
		const doc = JSON.parse(ISSO) as Array<{ title: string | null }>;
		doc[0]!.title = "t".repeat(8192);
		const res = await uploadIssoJson(JSON.stringify(doc));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(3);
	});

	it("rejects a Comentario document sent to the isso endpoint", async () => {
		const res = await uploadIssoJson(JSON.stringify({ version: 3 }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_isso_dump" });
	});

	it("rejects a Remark42 export (NDJSON) sent to the isso endpoint", async () => {
		const res = await uploadIssoJson('{"id":"1"}\n{"id":"2"}\n');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_isso_dump" });
	});

	it("rejects a top-level array that is not an array of objects", async () => {
		const res = await uploadIssoJson("[1, 2, 3]");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_isso_dump" });
	});

	it("rejects a Disqus export sent to the isso endpoint", async () => {
		const res = await uploadIssoJson(XML);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_isso_dump" });
	});

	it("rejects an empty body", async () => {
		const res = await uploadIssoJson("");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "empty_body" });
	});

	it("writes nothing on a dry run", async () => {
		const res = await uploadIssoJson(ISSO, { "x-dry-run": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dry_run: boolean;
			plan: { new_comments: number };
		};
		expect(body.dry_run).toBe(true);
		expect(body.plan.new_comments).toBe(3);
		expect(commentCount()).toBe(0);
	});

	it("include-deleted inserts the tombstone and re-parents its child onto it", async () => {
		const res = await uploadIssoJson(ISSO, { "x-include-deleted": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(4);
		expect(commentCount()).toBe(4);

		const tombstone = sqlite
			.prepare(
				"SELECT id, status FROM comments WHERE import_source = 'isso' AND import_id = '3'",
			)
			.get() as { id: string; status: string } | undefined;
		expect(tombstone?.status).toBe("deleted");

		const child = sqlite
			.prepare(
				"SELECT parent_id FROM comments WHERE import_source = 'isso' AND import_id = '4'",
			)
			.get() as { parent_id: string | null } | undefined;
		expect(child?.parent_id).toBe(tombstone?.id);
	});

	it("sets posts.url from x-import-site", async () => {
		const res = await uploadIssoJson(ISSO, {
			"x-import-site": "https://blog.example.com",
		});
		expect(res.status).toBe(200);
		const post = sqlite
			.prepare("SELECT url FROM posts WHERE slug = 'hello'")
			.get() as { url: string | null } | undefined;
		expect(post?.url).toBe("https://blog.example.com/hello");
	});

	it("rejects an unparseable x-import-site rather than importing with no permalinks", async () => {
		const res = await uploadIssoJson(ISSO, { "x-import-site": "not-a-url" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error.startsWith("import_failed:")).toBe(true);
		expect(body.error).toContain("site must be an http(s) origin (--site / x-import-site)");
		expect(commentCount()).toBe(0);
	});

	it("is idempotent across a plain and a gzipped upload of the same file", async () => {
		expect((await uploadIssoJson(ISSO)).status).toBe(200);
		const res = await uploadIssoJson(await gzip(ISSO));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(0);
		expect(commentCount()).toBe(3);
	});

	it("writes an import.isso audit row", async () => {
		const res = await uploadIssoJson(ISSO);
		expect(res.status).toBe(200);
		const row = sqlite
			.prepare("SELECT action FROM audit_log WHERE action = 'import.isso'")
			.get() as { action: string } | undefined;
		expect(row?.action).toBe("import.isso");
	});
});

// A Cusdis dump as `npm run dump-cusdis` writes it: `source` first, then
// projects → pages → comments. Two projects, so the endpoint's project
// selection (x-import-domain) is exercised; comment 3 is soft-deleted with
// a live reply, so include-deleted is too.
const CUSDIS_BLOG = "11111111-1111-4111-8111-111111111111";
const CUSDIS_DOCS = "22222222-2222-4222-8222-222222222222";
const cusdisComment = (
	id: string,
	over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
	id,
	parent_id: null,
	created_at: 1767225600000,
	updated_at: 1767225600000,
	deleted_at: null,
	approved: true,
	by_nickname: "Ada Example",
	by_email: "ada@example.com",
	content: `comment ${id}`,
	...over,
});
const CUSDIS = JSON.stringify({
	source: "cusdis",
	version: 1,
	projects: [
		{
			id: CUSDIS_BLOG,
			title: "Blog",
			pages: [
				{
					id: "p-1",
					slug: "/hello",
					url: null,
					title: "Hello",
					comments: [
						cusdisComment("c-1"),
						cusdisComment("c-2", {
							parent_id: "c-1",
							created_at: 1767225900000,
							by_nickname: "Bob Example",
							by_email: "bob@example.org",
						}),
						cusdisComment("c-3", {
							created_at: 1767226200000,
							deleted_at: 1767230000000,
							by_nickname: "Carol Example",
							by_email: "carol@example.com",
						}),
						cusdisComment("c-4", {
							parent_id: "c-3",
							created_at: 1767226500000,
							approved: false,
							by_nickname: "Dan Example",
							by_email: null,
						}),
					],
				},
			],
		},
		{
			id: CUSDIS_DOCS,
			title: "Docs",
			pages: [
				{
					id: "p-2",
					slug: "/hello",
					url: "https://docs.example.com/hello",
					title: null,
					comments: [cusdisComment("c-5", { by_nickname: "Erin Example", by_email: null })],
				},
			],
		},
	],
});
const CUSDIS_ONE_PROJECT = JSON.stringify({
	...(JSON.parse(CUSDIS) as { projects: unknown[] }),
	projects: (JSON.parse(CUSDIS) as { projects: unknown[] }).projects.slice(0, 1),
});

describe("POST /admin/api/ops/import-cusdis", () => {
	const blog = { "x-import-domain": CUSDIS_BLOG };

	it("imports a single-project dump with no project header", async () => {
		const res = await uploadCusdisJson(CUSDIS_ONE_PROJECT);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			plan: { new_comments: number; new_pages: number };
		};
		// c-3 is soft-deleted, skipped by default.
		expect(body.plan.new_comments).toBe(3);
		expect(body.plan.new_pages).toBe(1);
		expect(commentCount()).toBe(3);
	});

	it("refuses a two-project dump without a project header, naming both projects", async () => {
		const res = await uploadCusdisJson(CUSDIS);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("import_failed:cusdis dump: 2 projects in one file");
		expect(body.error).toContain(`${CUSDIS_BLOG} (Blog)`);
		expect(body.error).toContain(`${CUSDIS_DOCS} (Docs)`);
		expect(commentCount()).toBe(0);
	});

	it("selects a project by id through x-import-domain", async () => {
		const res = await uploadCusdisJson(CUSDIS, { "x-import-domain": CUSDIS_DOCS });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(1);
		const post = sqlite
			.prepare("SELECT url FROM posts WHERE slug = 'hello'")
			.get() as { url: string | null } | undefined;
		expect(post?.url).toBe("https://docs.example.com/hello");
	});

	it("refuses an unknown project id and lists the ids the dump has", async () => {
		const res = await uploadCusdisJson(CUSDIS, { "x-import-domain": "nope" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('no project with id "nope"');
		expect(body.error).toContain(CUSDIS_BLOG);
		expect(commentCount()).toBe(0);
	});

	it("imports a gzipped upload identically", async () => {
		const res = await uploadCusdisJson(await gzip(CUSDIS), blog);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(3);
		expect(commentCount()).toBe(3);
	});

	it("rejects a Comentario document sent to the Cusdis endpoint", async () => {
		const res = await uploadCusdisJson(JSON.stringify({ version: 3 }));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_cusdis_dump" });
	});

	it("rejects an isso dump sent to the Cusdis endpoint", async () => {
		const res = await uploadCusdisJson(ISSO);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_cusdis_dump" });
	});

	it("rejects a Remark42 export (NDJSON) sent to the Cusdis endpoint", async () => {
		const res = await uploadCusdisJson('{"id":"1"}\n{"id":"2"}\n');
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_cusdis_dump" });
	});

	it("rejects a Disqus export sent to the Cusdis endpoint", async () => {
		const res = await uploadCusdisJson(XML);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_cusdis_dump" });
	});

	it("rejects a Cusdis dump sent to the isso endpoint", async () => {
		const res = await uploadIssoJson(CUSDIS);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "not_isso_dump" });
	});

	it("accepts a dump whose keys were re-sorted, as the CLI does", async () => {
		// `jq -S` and `json.dumps(sort_keys=True)` put `projects` before
		// `source`. The CLI does no sniff and the adapter.s check is order-free,
		// so the upload has to agree with them on the same bytes.
		const sorted = JSON.stringify(
			Object.fromEntries(
				Object.entries(JSON.parse(CUSDIS_ONE_PROJECT) as Record<string, unknown>).sort(),
			),
		);
		expect(sorted.startsWith('{"projects"')).toBe(true);
		const res = await uploadCusdisJson(sorted);
		expect(res.status).toBe(200);
		expect(commentCount()).toBe(3);
	});

	it("rejects an empty body", async () => {
		const res = await uploadCusdisJson("");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "empty_body" });
	});

	it("writes nothing on a dry run", async () => {
		const res = await uploadCusdisJson(CUSDIS, { ...blog, "x-dry-run": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			dry_run: boolean;
			plan: { new_comments: number };
		};
		expect(body.dry_run).toBe(true);
		expect(body.plan.new_comments).toBe(3);
		expect(commentCount()).toBe(0);
	});

	it("lands the unapproved comment in the queue as pending", async () => {
		const res = await uploadCusdisJson(CUSDIS, blog);
		expect(res.status).toBe(200);
		const row = sqlite
			.prepare(
				"SELECT status FROM comments WHERE import_source = 'cusdis' AND import_id = 'c-4'",
			)
			.get() as { status: string } | undefined;
		expect(row?.status).toBe("pending");
	});

	it("include-deleted inserts the soft-deleted comment and re-parents its child onto it", async () => {
		const res = await uploadCusdisJson(CUSDIS, { ...blog, "x-include-deleted": "1" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(4);

		const deleted = sqlite
			.prepare(
				"SELECT id, status FROM comments WHERE import_source = 'cusdis' AND import_id = 'c-3'",
			)
			.get() as { id: string; status: string } | undefined;
		expect(deleted?.status).toBe("deleted");

		const child = sqlite
			.prepare(
				"SELECT parent_id FROM comments WHERE import_source = 'cusdis' AND import_id = 'c-4'",
			)
			.get() as { parent_id: string | null } | undefined;
		expect(child?.parent_id).toBe(deleted?.id);
	});

	it("sets posts.url from x-import-site for a page with no url", async () => {
		const res = await uploadCusdisJson(CUSDIS, {
			...blog,
			"x-import-site": "https://blog.example.com",
		});
		expect(res.status).toBe(200);
		const post = sqlite
			.prepare("SELECT url FROM posts WHERE slug = 'hello'")
			.get() as { url: string | null } | undefined;
		expect(post?.url).toBe("https://blog.example.com/hello");
	});

	it("rejects an unparseable x-import-site rather than importing with no permalinks", async () => {
		const res = await uploadCusdisJson(CUSDIS, { ...blog, "x-import-site": "not-a-url" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("site must be an http(s) origin (--site / x-import-site)");
		expect(commentCount()).toBe(0);
	});

	it("is idempotent across a plain and a gzipped upload of the same file", async () => {
		expect((await uploadCusdisJson(CUSDIS, blog)).status).toBe(200);
		const res = await uploadCusdisJson(await gzip(CUSDIS), blog);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { plan: { new_comments: number } };
		expect(body.plan.new_comments).toBe(0);
		expect(commentCount()).toBe(3);
	});

	it("writes an import.cusdis audit row", async () => {
		const res = await uploadCusdisJson(CUSDIS, blog);
		expect(res.status).toBe(200);
		const row = sqlite
			.prepare("SELECT action FROM audit_log WHERE action = 'import.cusdis'")
			.get() as { action: string } | undefined;
		expect(row?.action).toBe("import.cusdis");
	});
});
