/**
 * Disqus importer tests cover:
 *
 *   1. XML parsing — threads, posts, parent threading, CDATA / entity
 *      decoding, malformed input handling.
 *   2. HTML → markdown stripping — every Disqus tag is stripped, raw
 *      <script> / onerror attempts never survive, plain text and links
 *      are preserved.
 *   3. Idempotency — running the import twice over the same XML inserts
 *      zero new rows on the second run (the partial UNIQUE index on
 *      (import_source, import_id) does the work; we mock the existence
 *      check).
 *   4. Threading — second-pass parent_id assignment handles
 *      out-of-document-order replies.
 *
 * No Miniflare. Hand-rolled D1 stub with capture so tests assert SQL
 * directly.
 */
import { describe, it, expect } from "vitest";
import {
	disqusHtmlToMarkdown,
	parseDisqusXml,
	runDisqusImport,
	slugFromLink,
} from "../src/lib/disqus-import";

type Captured = { sql: string; binds: unknown[] };

// One DB stub that pretends every "SELECT ... WHERE id =" misses (so
// inserts always proceed) and records every statement.
const makeFreshDb = () => {
	const captured: Captured[] = [];
	const chain = (sql: string) => {
		const stmt = {
			_sql: sql,
			_binds: [] as unknown[],
			bind(...args: unknown[]) {
				this._binds = args;
				return this;
			},
			async first() {
				captured.push({ sql, binds: this._binds });
				return null;
			},
			async all() {
				captured.push({ sql, binds: this._binds });
				return { results: [] };
			},
			async run() {
				captured.push({ sql, binds: this._binds });
				return { meta: { changes: 1 } };
			},
		};
		return stmt;
	};
	const db = {
		prepare(sql: string) {
			return chain(sql);
		},
	};
	return { db, captured };
};

// A stub where the comment-existence check always returns a row (i.e.
// every dsq_id was previously imported). Used for the idempotency test.
const makeAlreadyImportedDb = () => {
	const captured: Captured[] = [];
	const chain = (sql: string) => {
		const stmt = {
			_sql: sql,
			_binds: [] as unknown[],
			bind(...args: unknown[]) {
				this._binds = args;
				return this;
			},
			async first() {
				captured.push({ sql, binds: this._binds });
				if (sql.includes("FROM comments WHERE import_source")) {
					return { id: "01HX0000000000000000000001" };
				}
				if (sql.includes("FROM posts WHERE slug")) {
					return { slug: "blog/hello" };
				}
				if (sql.includes("FROM users WHERE provider")) {
					return { id: "01HU0000000000000000000001" };
				}
				return null;
			},
			async all() {
				captured.push({ sql, binds: this._binds });
				return { results: [] };
			},
			async run() {
				captured.push({ sql, binds: this._binds });
				return { meta: { changes: 1 } };
			},
		};
		return stmt;
	};
	return {
		db: { prepare: (s: string) => chain(s) },
		captured,
	};
};

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<disqus xmlns:dsq="http://disqus.com/disqus-internals">
  <thread dsq:id="t100">
    <id>blog-hello</id>
    <link>https://example.com/blog/hello</link>
    <title><![CDATA[Hello, world]]></title>
    <createdAt>2023-04-01T10:00:00Z</createdAt>
  </thread>
  <post dsq:id="p1">
    <message><![CDATA[<p>First!</p>]]></message>
    <createdAt>2023-04-01T10:05:00Z</createdAt>
    <isDeleted>false</isDeleted>
    <isSpam>false</isSpam>
    <author>
      <name>Ada</name>
      <email>ada@example.com</email>
      <isAnonymous>false</isAnonymous>
    </author>
    <thread dsq:id="t100" />
  </post>
  <post dsq:id="p2">
    <message><![CDATA[<p>Reply!</p>]]></message>
    <createdAt>2023-04-01T10:10:00Z</createdAt>
    <isDeleted>false</isDeleted>
    <isSpam>false</isSpam>
    <author>
      <name>Bob</name>
      <email>bob@example.com</email>
      <isAnonymous>false</isAnonymous>
    </author>
    <thread dsq:id="t100" />
    <parent dsq:id="p1" />
  </post>
</disqus>`;

// --------------------------- parseDisqusXml --------------------------------

describe("parseDisqusXml", () => {
	it("extracts threads with id, link, title, created_at", () => {
		const out = parseDisqusXml(SAMPLE_XML);
		expect(out.threads).toHaveLength(1);
		expect(out.threads[0]).toMatchObject({
			dsq_id: "t100",
			link: "https://example.com/blog/hello",
			title: "Hello, world",
		});
		expect(out.threads[0]!.created_at).toBe(Date.parse("2023-04-01T10:00:00Z"));
	});

	it("extracts posts with author, thread + parent dsq_id", () => {
		const out = parseDisqusXml(SAMPLE_XML);
		expect(out.posts).toHaveLength(2);
		expect(out.posts[0]).toMatchObject({
			dsq_id: "p1",
			thread_dsq_id: "t100",
			parent_dsq_id: null,
		});
		expect(out.posts[1]).toMatchObject({
			dsq_id: "p2",
			thread_dsq_id: "t100",
			parent_dsq_id: "p1",
		});
		expect(out.posts[0]!.author.name).toBe("Ada");
	});

	it("rejects an oversized document", () => {
		const huge = "<disqus>" + "x".repeat(51 * 1024 * 1024) + "</disqus>";
		expect(() => parseDisqusXml(huge)).toThrow(/too large/);
	});

	it("survives malformed posts without a thread reference (skips them)", () => {
		const bad = `<disqus>
		  <post dsq:id="p_bad">
		    <message>orphan</message>
		    <author><name>X</name></author>
		  </post>
		</disqus>`;
		const out = parseDisqusXml(bad);
		expect(out.posts).toHaveLength(0);
	});
});

// ----------------------- disqusHtmlToMarkdown ------------------------------

describe("disqusHtmlToMarkdown", () => {
	it("strips raw <script> tags", () => {
		const out = disqusHtmlToMarkdown(`<p>hi <script>alert(1)</script></p>`);
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("</script>");
	});

	it("strips <img onerror=...> attempts", () => {
		const out = disqusHtmlToMarkdown(`<p><img src=x onerror="alert(1)"></p>`);
		expect(out).not.toContain("onerror");
		expect(out).not.toContain("<img");
	});

	it("preserves plain text", () => {
		const out = disqusHtmlToMarkdown(`<p>Hello there, friend.</p>`);
		expect(out).toBe("Hello there, friend.");
	});

	it("rewrites anchor tags to markdown links", () => {
		const out = disqusHtmlToMarkdown(
			`<p>see <a href="https://example.com">my blog</a></p>`,
		);
		expect(out).toContain("[my blog](https://example.com)");
	});

	it("drops javascript: anchor URLs", () => {
		const out = disqusHtmlToMarkdown(
			`<p><a href="javascript:alert(1)">click</a></p>`,
		);
		expect(out).not.toContain("javascript:");
		// Label remains as inert text — no executable handler can reach it.
		expect(out).toContain("click");
	});

	it("decodes entities in the surviving text", () => {
		const out = disqusHtmlToMarkdown(`<p>5 &lt; 10 &amp; counting</p>`);
		expect(out).toContain("5 < 10 & counting");
	});
});

// ------------------------------ slugFromLink -------------------------------

describe("slugFromLink", () => {
	it("strips host + leading/trailing slashes", () => {
		expect(slugFromLink("https://x.com/blog/hello/", "fallback")).toBe(
			"blog/hello",
		);
	});

	it("falls back when link is null", () => {
		expect(slugFromLink(null, "fallback")).toBe("fallback");
	});

	it("falls back on malformed URLs", () => {
		expect(slugFromLink("not a url", "fallback")).toBe("fallback");
	});

	it("uses fallback when the link is just the host", () => {
		expect(slugFromLink("https://x.com/", "fallback")).toBe("fallback");
	});
});

// ------------------------------ runDisqusImport ----------------------------

describe("runDisqusImport", () => {
	it("dry-run reports counts without issuing INSERTs", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, SAMPLE_XML, "secret", {
			dry_run: true,
		});
		expect(plan.threads_total).toBe(1);
		expect(plan.posts_total).toBe(2);
		expect(plan.new_comments).toBe(2);
		expect(plan.new_posts).toBe(1);

		const inserts = captured.filter((c) =>
			/^INSERT INTO (comments|users|posts)\b/.test(c.sql),
		);
		expect(inserts).toHaveLength(0);
	});

	it("inserts posts, ghost users, and comments on a fresh DB", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, SAMPLE_XML, "secret", {});
		expect(plan.new_posts).toBe(1);
		expect(plan.new_users).toBe(2);
		expect(plan.new_comments).toBe(2);

		const commentInserts = captured.filter((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		expect(commentInserts).toHaveLength(2);
		// import_source + import_id are bound on every insert.
		for (const ins of commentInserts) {
			// Bind order ends with (..., 'disqus', dsq_id) at positions
			// [-2] and [-1].
			expect(ins.binds[ins.binds.length - 2]).toBe("disqus");
			expect(ins.binds[ins.binds.length - 1]).toMatch(/^p[12]$/);
		}
	});

	it("is idempotent — re-run on already-imported XML inserts zero comments", async () => {
		const { db, captured } = makeAlreadyImportedDb();
		const plan = await runDisqusImport(db, SAMPLE_XML, "secret", {});
		// Plan still reports the totals it saw, but the new_* counters
		// stay at 0 because every existence check returned a row.
		expect(plan.new_comments).toBe(0);
		expect(plan.new_users).toBe(0);
		expect(plan.new_posts).toBe(0);

		const inserts = captured.filter((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		expect(inserts).toHaveLength(0);
	});

	it("re-parents replies via the second pass UPDATE", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, SAMPLE_XML, "secret", {});
		const reparents = captured.filter((c) =>
			c.sql.startsWith("UPDATE comments SET parent_id"),
		);
		// Only p2 has a parent. p1 stays NULL.
		expect(reparents).toHaveLength(1);
	});

	it("skips deleted/spam by default and counts them in the plan", async () => {
		const xml = `<disqus>
		  <thread dsq:id="t1"><link>https://x.com/a</link></thread>
		  <post dsq:id="p1">
		    <message>visible</message>
		    <isDeleted>false</isDeleted><isSpam>false</isSpam>
		    <author><name>A</name></author>
		    <thread dsq:id="t1" />
		  </post>
		  <post dsq:id="p2">
		    <message>removed</message>
		    <isDeleted>true</isDeleted><isSpam>false</isSpam>
		    <author><name>B</name></author>
		    <thread dsq:id="t1" />
		  </post>
		  <post dsq:id="p3">
		    <message>spammy</message>
		    <isDeleted>false</isDeleted><isSpam>true</isSpam>
		    <author><name>C</name></author>
		    <thread dsq:id="t1" />
		  </post>
		</disqus>`;
		const { db } = makeFreshDb();
		const plan = await runDisqusImport(db, xml, "secret", {});
		expect(plan.new_comments).toBe(1);
		expect(plan.posts_skipped_deleted).toBe(1);
		expect(plan.posts_skipped_spam).toBe(1);
	});

	it("imported comment body is sanitized through the markdown allowlist", async () => {
		const xml = `<disqus>
		  <thread dsq:id="t1"><link>https://x.com/a</link></thread>
		  <post dsq:id="p1">
		    <message><![CDATA[<p>hello <script>alert(1)</script> there</p>]]></message>
		    <author><name>A</name></author>
		    <thread dsq:id="t1" />
		  </post>
		</disqus>`;
		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, xml, "secret", {});
		const comment = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		// Bind order: id, post_slug, user_id, body_md, body_html, ...
		const bodyHtml = comment!.binds[4] as string;
		expect(bodyHtml).not.toContain("<script>");
		expect(bodyHtml).not.toContain("</script>");
	});
});
