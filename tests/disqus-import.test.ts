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
 *   5. Shapes measured in a real forum-wide export — comment-less
 *      threads, query-string slug collisions, a malformed link. Still
 *      hand-written and identity-free; only the shapes came from the
 *      wild. See the block at the foot of this file.
 *
 * No Miniflare. Hand-rolled D1 stub with capture so tests assert SQL
 * directly.
 */
import { describe, it, expect } from "vitest";
import { safePostUrl, slugFromLink } from "../src/lib/import/core";
import { parseDisqusXml, runDisqusImport } from "../src/lib/import/disqus";
import { htmlToMarkdown } from "../src/lib/import/html-to-markdown";
import { renderMarkdown } from "../src/lib/markdown";
import { MAX_POST_TITLE } from "../src/lib/post-title";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import { asD1 } from "./helpers/d1";

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
	return { db: asD1(db), captured };
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
		db: asD1({ prepare: (s: string) => chain(s) }),
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

	it("reads <isClosed>, defaulting to open when the tag is absent", () => {
		// Older exports omit the tag entirely, and open is the right reading of
		// silence — it matches the posts.closed schema default.
		expect(parseDisqusXml(SAMPLE_XML).threads[0]!.is_closed).toBe(false);
		const closed = parseDisqusXml(
			`<disqus><thread dsq:id="t1"><link>https://example.com/a</link>
			  <isClosed>true</isClosed></thread></disqus>`,
		);
		expect(closed.threads[0]!.is_closed).toBe(true);
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
		const huge = `<disqus>${"x".repeat(51 * 1024 * 1024)}</disqus>`;
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

// ----------------------- htmlToMarkdown ------------------------------

describe("htmlToMarkdown", () => {
	it("strips raw <script> tags", () => {
		const out = htmlToMarkdown(`<p>hi <script>alert(1)</script></p>`);
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("</script>");
	});

	it("strips <img onerror=...> attempts", () => {
		const out = htmlToMarkdown(`<p><img src=x onerror="alert(1)"></p>`);
		expect(out).not.toContain("onerror");
		expect(out).not.toContain("<img");
	});

	it("preserves plain text", () => {
		const out = htmlToMarkdown(`<p>Hello there, friend.</p>`);
		expect(out).toBe("Hello there, friend.");
	});

	it("rewrites anchor tags to markdown links", () => {
		const out = htmlToMarkdown(
			`<p>see <a href="https://example.com">my blog</a></p>`,
		);
		expect(out).toContain("[my blog](https://example.com)");
	});

	it("drops javascript: anchor URLs", () => {
		const out = htmlToMarkdown(
			`<p><a href="javascript:alert(1)">click</a></p>`,
		);
		expect(out).not.toContain("javascript:");
		// Label remains as inert text — no executable handler can reach it.
		expect(out).toContain("click");
	});

	it("decodes entities in the surviving text", () => {
		const out = htmlToMarkdown(`<p>5 &lt; 10 &amp; counting</p>`);
		// The ampersand decodes to itself; the angle bracket decodes and is
		// then markdown-escaped, because a bare `<` here is markup to the
		// renderer downstream rather than the character the author typed.
		expect(out).toContain("5 \\< 10 & counting");
		expect(renderMarkdown(out)).toContain("5 &lt; 10 &amp; counting");
	});

	// Every case below is a body that USED to arrive at the reader with text
	// missing. A source that stores rendered HTML stores literal angle
	// brackets as entities; decoding them without re-escaping handed `marked`
	// something it read as a tag, and the strict allowlist then dropped it.
	// The bodies most likely to contain angle brackets — code samples, a post
	// about HTML — were the ones that lost the most, and one lost everything.
	describe("angle brackets survive into the rendered body", () => {
		const roundTrip = (html: string): string =>
			renderMarkdown(htmlToMarkdown(html));

		it("keeps a tag name written as prose", () => {
			expect(roundTrip(`<p>use &lt;span&gt; for inline</p>`)).toContain(
				"use &lt;span&gt; for inline",
			);
		});

		it("keeps a generic type", () => {
			expect(roundTrip(`<p>generic: List&lt;T&gt;</p>`)).toContain(
				"generic: List&lt;T&gt;",
			);
		});

		it("does not turn a whole code sample into an empty comment", () => {
			// The worst case, and not a rare one: a comment that is nothing
			// but a pasted snippet used to import as "".
			const out = roundTrip(
				`<pre><code>&lt;div class="x"&gt;hi&lt;/div&gt;</code></pre>`,
			);
			expect(out).not.toBe("");
			expect(out).toContain("&lt;div");
			expect(out).toContain("hi");
		});

		it("keeps a link label made of angle brackets", () => {
			// The label is stripped of tags after the substitution runs, so
			// decoding it early left "[](url)" — a link with no text at all.
			const out = roundTrip(
				`<p>see <a href="https://example.com/">&lt;the docs&gt;</a></p>`,
			);
			expect(out).toContain("&lt;the docs&gt;");
			expect(out).toContain('href="https://example.com/"');
		});

		it("does not read a leading > as a blockquote", () => {
			expect(roundTrip(`<p>&gt; not a quote</p>`)).toContain(
				"&gt; not a quote",
			);
		});

		it("still renders nothing executable for a real script tag", () => {
			// The escape must not become a way to smuggle markup back in: the
			// text arrives visible, as text, and the allowlist is untouched.
			const out = roundTrip(`<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`);
			expect(out).toContain("&lt;script&gt;");
			expect(out).not.toContain("<script");
		});

		// CodeQL js/incomplete-sanitization, and it was right: escaping `<` with
		// a backslash is only sound if the backslashes already in the text are
		// escaped first. These three are what that costs and what it buys.
		it("does not let a source backslash re-open the tag it escaped", () => {
			const out = roundTrip(`<p>\\&lt;script&gt;alert(1)\\&lt;/script&gt;</p>`);
			expect(out).toContain("\\&lt;script&gt;");
			expect(out).not.toContain("<script");
		});

		it("round-trips a Windows path unchanged", () => {
			expect(roundTrip(`<p>path is C:\\Users\\ada</p>`)).toContain(
				"path is C:\\Users\\ada",
			);
		});

		it("keeps a backslash it used to drop", () => {
			// Pre-fix this rendered "foo*bar*baz" — the backslash vanished. The
			// emphasis still fires because `*` is not escaped; that is the
			// acknowledged fidelity gap, and it is not content loss.
			expect(roundTrip(`<p>foo\\*bar*baz</p>`)).toContain("foo\\<em>bar</em>baz");
		});

		it("leaves a bare link collapsing to its own URL", () => {
			expect(
				htmlToMarkdown(
					`<p><a href="https://example.com/x">https://example.com/x</a></p>`,
				),
			).toBe("https://example.com/x");
		});
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

// ------------------------------- safePostUrl -------------------------------

describe("safePostUrl", () => {
	it("keeps http and https links", () => {
		expect(safePostUrl("https://example.com/blog/hello")).toBe(
			"https://example.com/blog/hello",
		);
		expect(safePostUrl("http://example.com/x")).toBe("http://example.com/x");
	});

	it("drops every other scheme", () => {
		// posts.url is what the permalink route redirects to, so these are
		// open-redirect and script-execution gadgets, not cosmetic issues.
		for (const bad of [
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"//evil.example.com/x",
			"not a url",
		]) {
			expect(safePostUrl(bad)).toBeNull();
		}
	});

	it("treats a missing link as no url", () => {
		expect(safePostUrl(null)).toBeNull();
	});
});

// ------------------------------ runDisqusImport ----------------------------

describe("runDisqusImport", () => {
	// The importer INSERTs into posts directly rather than going through
	// upsertPost, so it bypassed both guards the Worker's write path applies to
	// the same two columns. A hand-edited export — or a Disqus forum whose
	// thread links were attacker-supplied — is untrusted input either way.
	const postInsert = (captured: Captured[]) => {
		const ins = captured.filter((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(ins).toHaveLength(1);
		return ins[0]!.binds;
	};

	const xmlWith = (link: string, title: string) => `<disqus>
  <thread dsq:id="t100">
    <link>${link}</link>
    <title><![CDATA[${title}]]></title>
    <createdAt>2023-04-01T10:00:00Z</createdAt>
  </thread>
</disqus>`;

	it("stores an http thread link as the post url", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, SAMPLE_XML, "secret", {});
		expect(postInsert(captured)[2]).toBe("https://example.com/blog/hello");
	});

	it("imports a closed Disqus thread as a closed page", async () => {
		// posts.closed is otherwise operator-set. A forum the author froze years
		// ago should not reopen to new comments just because it changed hosts.
		const { db, captured } = makeFreshDb();
		await runDisqusImport(
			db,
			`<disqus><thread dsq:id="t100"><link>https://example.com/a</link>
			   <title>A</title><isClosed>true</isClosed></thread></disqus>`,
			"secret",
			{},
		);
		// slug, title, url, created_at, closed
		expect(postInsert(captured)[4]).toBe(1);
	});

	it("leaves a page open when the thread has no <isClosed>", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, SAMPLE_XML, "secret", {});
		expect(postInsert(captured)[4]).toBe(0);
	});

	it("nulls a non-http thread link instead of storing it", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(
			db,
			xmlWith("javascript:alert(1)", "Hello"),
			"secret",
			{},
		);
		// Binds are (slug, title, url, created_at). The slug still derives from
		// the link's fallback path, so the row is usable — only the redirect
		// target is dropped.
		expect(postInsert(captured)[2]).toBeNull();
	});

	it("strips control characters from an imported title", async () => {
		// posts.title reaches mail subject lines via the digest, where a CR or
		// LF is a header-injection primitive. See src/lib/post-title.ts.
		const { db, captured } = makeFreshDb();
		await runDisqusImport(
			db,
			xmlWith("https://example.com/p", "Hi\r\nBcc: victim@example.com"),
			"secret",
			{},
		);
		const title = postInsert(captured)[1] as string;
		expect(title).not.toMatch(/[\r\n]/);
		expect(title).toBe("Hi Bcc: victim@example.com");
	});

	it("caps an over-long imported title", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(
			db,
			xmlWith("https://example.com/p", "T".repeat(MAX_POST_TITLE + 50)),
			"secret",
			{},
		);
		expect((postInsert(captured)[1] as string).length).toBe(MAX_POST_TITLE);
	});

	it("falls back to the slug when a title sanitizes to nothing", async () => {
		const { db, captured } = makeFreshDb();
		await runDisqusImport(
			db,
			xmlWith("https://example.com/blog/hi", ""),
			"secret",
			{},
		);
		const binds = postInsert(captured);
		expect(binds[1]).toBe(binds[0]);
		expect(binds[1]).toBe("blog/hi");
	});

	it("dry-run reports counts without issuing INSERTs", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, SAMPLE_XML, "secret", {
			dry_run: true,
		});
		expect(plan.pages_total).toBe(1);
		expect(plan.comments_total).toBe(2);
		expect(plan.new_comments).toBe(2);
		expect(plan.new_pages).toBe(1);

		const inserts = captured.filter((c) =>
			/^INSERT INTO (comments|users|posts)\b/.test(c.sql),
		);
		expect(inserts).toHaveLength(0);
	});

	it("inserts posts, ghost users, and comments on a fresh DB", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, SAMPLE_XML, "secret", {});
		expect(plan.new_pages).toBe(1);
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
		expect(plan.new_pages).toBe(0);

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
		// The same pass resolves depth: p1 is a root (1), so p2 is 2. Binds are
		// (parent_native_id, depth, child_native_id).
		expect(reparents[0]!.binds[1]).toBe(2);
	});

	it("flattens an over-deep imported chain onto the deepest allowed ancestor", async () => {
		// A chain longer than MAX_REPLY_DEPTH must not land in the DB as-is: the
		// read path's cost is bounded only if every row satisfies
		// depth <= MAX_REPLY_DEPTH. Nothing is dropped — over-deep links are
		// re-parented upward, the same flattening the renderer already does.
		const CHAIN = MAX_REPLY_DEPTH + 4;
		const posts = Array.from({ length: CHAIN }, (_, i) => {
			const n = i + 1;
			return `  <post dsq:id="p${n}">
    <message><![CDATA[<p>m${n}</p>]]></message>
    <createdAt>2023-04-01T10:0${n % 10}:00Z</createdAt>
    <isDeleted>false</isDeleted><isSpam>false</isSpam>
    <author><name>A${n}</name><isAnonymous>true</isAnonymous></author>
    <thread dsq:id="t100" />
    ${n > 1 ? `<parent dsq:id="p${n - 1}" />` : ""}
  </post>`;
		}).join("\n");
		const xml = `<disqus>
  <thread dsq:id="t100">
    <link>https://example.com/blog/deep</link>
    <createdAt>2023-04-01T10:00:00Z</createdAt>
  </thread>
${posts}
</disqus>`;

		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, xml, "secret", {});
		const depths = captured
			.filter((c) => c.sql.startsWith("UPDATE comments SET parent_id"))
			.map((c) => c.binds[1] as number);

		// p2..p{MAX} get their true depth; everything past the cap pins to it.
		expect(depths).toHaveLength(CHAIN - 1);
		expect(depths.slice(0, MAX_REPLY_DEPTH - 1)).toEqual(
			Array.from({ length: MAX_REPLY_DEPTH - 1 }, (_, i) => i + 2),
		);
		expect(Math.max(...depths)).toBe(MAX_REPLY_DEPTH);
		// Every comment survived — the flattening re-parents, it doesn't drop.
		expect(
			captured.filter((c) => c.sql.startsWith("INSERT INTO comments")),
		).toHaveLength(CHAIN);
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
		expect(plan.skipped_deleted).toBe(1);
		expect(plan.skipped_spam).toBe(1);
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

// ------------------------ shapes measured in the wild ------------------------
//
// Everything above this point was written from Disqus's documented export
// format. These four were written from a real one — a 351,289-character export
// of a live forum, run through this adapter unmodified in a separate harness.
// They are hand-written and identity-free like every other fixture here; what
// the real file contributed is the *shapes*, which are the part nobody invents.
//
// Each one pins current behaviour rather than asserting a fix. Two of them
// describe things worth changing, and say so; a test that quietly encodes a
// surprise as correct is how a surprise becomes permanent.

describe("runDisqusImport — shapes measured in a real export", () => {
	// A Disqus export is FORUM-wide. There is no per-thread or per-page export
	// mode, so an operator importing one page's comments hands us every thread
	// the forum ever had — in the measured file, 870 threads of which exactly
	// one carried a comment. The core creates a page per thread regardless,
	// which is right for a per-site export (a thread is a page whether or not
	// anyone commented) and is a surprise for this source specifically.
	//
	// Pinned, not fixed: whether to drop comment-less threads, or offer a
	// domain filter, is a product decision. What matters here is that
	// pages_total tells an operator the number before they commit to it — a
	// dry run is the place this is supposed to be visible.
	it("creates a page for every thread, including the ones with no comments", async () => {
		const xml = `<disqus>
		  <thread dsq:id="t1"><link>https://example.com/kept</link></thread>
		  <thread dsq:id="t2"><link>https://example.com/silent-a</link></thread>
		  <thread dsq:id="t3"><link>https://example.com/silent-b</link></thread>
		  <post dsq:id="p1">
		    <message>the only comment in the file</message>
		    <author><name>A</name></author>
		    <thread dsq:id="t1" />
		  </post>
		</disqus>`;
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, xml, "secret", {});
		expect(plan.pages_total).toBe(3);
		expect(plan.new_pages).toBe(3);
		expect(plan.new_comments).toBe(1);

		const slugs = captured
			.filter((c) => c.sql.startsWith("INSERT INTO posts"))
			.map((c) => c.binds[0]);
		expect(slugs).toEqual(["kept", "silent-a", "silent-b"]);
	});

	// slugFromLink drops the query string, so every ?page= and ?q= variant of
	// one path reduces to one slug and the first thread in document order wins.
	// The measured export had three such collisions on a single path.
	//
	// This is a trade-off, not a defect: keeping the query would fragment one
	// page across every ?utm_source= it was ever shared with, which is the
	// worse failure in the common case. The defect is that the merge is
	// SILENT — comments relocate from ?page=2 onto page 1 and the ImportPlan
	// reports the same numbers either way, so an operator has nothing to
	// notice. Counting collisions would cost nothing; that change is not made
	// here, and this test is what will fail loudly when it is.
	it("merges query-string variants onto one page, first thread winning", async () => {
		const xml = `<disqus>
		  <thread dsq:id="t1">
		    <link>https://example.com/search</link>
		    <title><![CDATA[Search]]></title>
		  </thread>
		  <thread dsq:id="t2">
		    <link>https://example.com/search?q=comments&amp;page=2</link>
		    <title><![CDATA[Search — page 2]]></title>
		  </thread>
		  <post dsq:id="p1">
		    <message>posted on page two</message>
		    <author><name>A</name></author>
		    <thread dsq:id="t2" />
		  </post>
		</disqus>`;
		const { db, captured } = makeFreshDb();
		const plan = await runDisqusImport(db, xml, "secret", {});

		// Two threads in, one page out — and nothing in the plan says so.
		expect(plan.pages_total).toBe(2);
		expect(plan.new_pages).toBe(1);

		const posts = captured.filter((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(posts).toHaveLength(1);
		// The FIRST thread supplies the title and url, so the surviving page is
		// the one nobody commented on.
		expect(posts[0]!.binds[0]).toBe("search");
		expect(posts[0]!.binds[1]).toBe("Search");

		// The comment still lands, on the merged slug.
		const comment = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		expect(comment!.binds[1]).toBe("search");
	});

	// Straight out of the measured export, minus the host. Double-encoded
	// slashes plus a literal space — a URL no one would think to write into a
	// synthetic fixture, produced by the world. Both guards hold: the slug
	// falls back to the synthetic one, and safePostUrl refuses to store it.
	it("survives a double-encoded, space-bearing thread link", async () => {
		const link = "https://%2f%2fexample.com%2fi%2fbkmi web/";
		expect(slugFromLink(link, "disqus-t9")).toBe("disqus-t9");
		expect(safePostUrl(link)).toBeNull();

		const xml = `<disqus>
		  <thread dsq:id="t9"><link>${link}</link></thread>
		  <post dsq:id="p1">
		    <message>attached to a broken link</message>
		    <author><name>A</name></author>
		    <thread dsq:id="t9" />
		  </post>
		</disqus>`;
		const { db, captured } = makeFreshDb();
		await runDisqusImport(db, xml, "secret", {});
		const post = captured.find((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(post!.binds[0]).toBe("disqus-t9");
		expect(post!.binds[2]).toBeNull();
	});

	// The other collision in the measured export, and this one is desirable.
	// A protocol-relative link and its absolute twin name the same page, so
	// reducing both to one slug is normalisation rather than data loss. It sits
	// next to the query-string case deliberately: the mechanism is identical
	// and only one of the two outcomes is a problem.
	it("folds a protocol-relative link onto the same slug as its absolute twin", async () => {
		expect(slugFromLink("https://example.com/i/yL3a", "fb")).toBe("i/yL3a");
		expect(slugFromLink("https://example.net/i/yL3a", "fb")).toBe("i/yL3a");
	});
});
