/**
 * Importer core tests — the source-agnostic half of src/lib/import/.
 *
 * The Disqus adapter's own parsing and end-to-end behaviour is covered by
 * tests/disqus-import.test.ts. What lives here is everything the core does
 * for *every* adapter, exercised through a synthetic adapter so a Disqus
 * parsing change can't mask a core regression (or vice versa).
 *
 * No Miniflare. Hand-rolled D1 stub with capture, same shape as the Disqus
 * suite's.
 */
import { describe, expect, it } from "vitest";
import {
	type ImportAdapter,
	type SourceAuthor,
	type SourceExport,
	type SourceStatus,
	ImportTooLargeError,
	MAX_IMPORT_BYTES,
	authorSeed,
	decodeImportInput,
	listIdentifiers,
	requireKnownIdentifier,
	runImport,
	slugDigest,
	slugFromPath,
} from "../src/lib/import/core";
import { asD1 } from "./helpers/d1";

type Captured = { sql: string; binds: unknown[] };

// Every "SELECT ... WHERE" misses, so inserts always proceed; every
// statement is recorded.
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
	return { db: asD1({ prepare: chain }), captured };
};

/** An adapter that hands the core a literal export, no parsing involved. */
const stubAdapter = (source: string, exported: SourceExport): ImportAdapter => ({
	source,
	slugFallbackPrefix: `${source}-`,
	parse: () => exported,
});

const AT = 1_700_000_000_000;

/** One page, one comment per author, from a source with no author ids. */
const exportOf = (
	authors: SourceAuthor[],
	link: string | null = "https://example.com/hello",
): SourceExport => ({
	threads: [{ source_id: "t1", link, title: "Hello", created_at: AT }],
	comments: authors.map((author, i) => ({
		source_id: `c${i + 1}`,
		thread_source_id: "t1",
		parent_source_id: null,
		created_at: AT,
		status: "approved" as const,
		body_md: "hi",
		author,
	})),
});

const oneComment = (author: SourceAuthor): SourceExport => exportOf([author]);

/** The provider_id the core derived, read off the users INSERT. */
const providerIdFrom = (captured: Captured[]): string => {
	const insert = captured.find((c) => c.sql.startsWith("INSERT INTO users"));
	// Bind order: id, provider_id, name, is_banned, created_at, import_source
	// ('anon' is a literal).
	return insert!.binds[1] as string;
};

describe("authorSeed", () => {
	it("keys on name + email when the source has no author id", () => {
		expect(
			authorSeed("disqus", {
				name: "Alice",
				email: "alice@example.com",
				is_anonymous: true,
			}),
		).toBe("Alice|alice@example.com");
	});

	it("treats a missing email as empty, not as the string 'null'", () => {
		expect(
			authorSeed("disqus", { name: "Alice", email: null, is_anonymous: true }),
		).toBe("Alice|");
	});

	it("keys on the source's id when it has one, namespaced by source", () => {
		expect(
			authorSeed("remark42", {
				name: "Alice",
				email: "alice@example.com",
				is_anonymous: true,
				source_id: "github_abc123",
			}),
		).toBe("remark42:id:github_abc123");
	});

	it("ignores name and email entirely once an id is present", () => {
		// The point of the id branch: a Remark42 user who renames themselves is
		// still one ghost, and two people who pick the same display name stay
		// two.
		const a = authorSeed("remark42", {
			name: "Alice",
			email: "alice@example.com",
			is_anonymous: true,
			source_id: "u1",
		});
		const renamed = authorSeed("remark42", {
			name: "Alice Smith",
			email: null,
			is_anonymous: true,
			source_id: "u1",
		});
		const namesake = authorSeed("remark42", {
			name: "Alice",
			email: "alice@example.com",
			is_anonymous: true,
			source_id: "u2",
		});
		expect(renamed).toBe(a);
		expect(namesake).not.toBe(a);
	});

	it("namespaces the id branch so two sources' user #1 do not collide", () => {
		const seed = { name: "A", email: null, is_anonymous: true, source_id: "1" };
		expect(authorSeed("remark42", seed)).not.toBe(authorSeed("isso", seed));
	});

	it("does not namespace the name+email branch", () => {
		// Load-bearing: existing installs' provider_ids were derived from these
		// exact bytes. Prefixing them would orphan every imported ghost, so a
		// re-import would double every commenter instead of deduping.
		const seed = { name: "A", email: null, is_anonymous: true };
		expect(authorSeed("disqus", seed)).toBe(authorSeed("remark42", seed));
	});
});

describe("ghost identity derivation", () => {
	// Literal digests, not recomputed from authorSeed — that would pass even if
	// the seed changed. These are the bytes a self-hoster's `users` table
	// already holds; if this test goes red, imports stopped deduping against
	// rows they previously matched.
	it("derives provider_id from the name+email seed", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"disqus",
				oneComment({
					name: "Alice",
					email: "alice@example.com",
					is_anonymous: true,
				}),
			),
			"",
			"test-secret",
		);
		expect(providerIdFrom(captured)).toBe("830d31056a671036b5303fe223975675");
	});

	it("derives provider_id from the source-id seed", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"remark42",
				oneComment({
					name: "Alice",
					email: "alice@example.com",
					is_anonymous: true,
					source_id: "github_abc123",
				}),
			),
			"",
			"test-secret",
		);
		expect(providerIdFrom(captured)).toBe("aa205213947759360ea52aace2cb2e13");
	});

	it("collapses two comments by the same author onto one ghost", async () => {
		const alice = { name: "Alice", email: null, is_anonymous: true };
		const exported = exportOf([alice, { ...alice }]);
		const { db, captured } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("disqus", exported),
			"",
			"test-secret",
		);
		expect(plan.new_users).toBe(1);
		expect(plan.new_comments).toBe(2);
		expect(captured.filter((c) => c.sql.startsWith("INSERT INTO users")).length)
			.toBe(1);
	});

	it("tags every row with the adapter's source, not a hard-coded 'disqus'", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter(
				"remark42",
				oneComment({ name: "A", email: null, is_anonymous: true }),
			),
			"",
			"test-secret",
		);
		const comment = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		expect(comment!.binds).toContain("remark42");
		expect(comment!.binds).not.toContain("disqus");
		const user = captured.find((c) => c.sql.startsWith("INSERT INTO users"));
		expect(user!.binds).toContain("remark42");
	});

	it("counts a thread that merged onto a slug an earlier thread claimed", async () => {
		// Same path, different query strings. Slugs drop the query, so both
		// threads want "hello" and the second is absorbed.
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		exported.threads.push({
			source_id: "t2",
			link: "https://example.com/hello?page=2",
			title: "Hello, page 2",
			created_at: AT,
		});
		const { db } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("remark42", exported),
			"",
			"test-secret",
		);
		expect(plan.pages_total).toBe(2);
		expect(plan.new_pages).toBe(1);
		expect(plan.merged_pages).toBe(1);
	});

	it("reports no merges under slug_override, where collapsing is the point", async () => {
		// Every thread is forced onto one page by the operator. That is not a
		// surprise to report; new_pages already says one page came out.
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		exported.threads.push({
			source_id: "t2",
			link: "https://example.com/unrelated",
			title: "Unrelated",
			created_at: AT,
		});
		const { db } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("remark42", exported),
			"",
			"test-secret",
			{ slug_override: "one-page" },
		);
		expect(plan.pages_total).toBe(2);
		expect(plan.new_pages).toBe(1);
		expect(plan.merged_pages).toBe(0);
	});

	// The read API answers 400 for any slug outside SLUG_RE, so a posts row
	// with such a slug is a page no reader can load. The core refuses to
	// create one rather than reporting a successful import of unreachable
	// comments.
	it("refuses an empty slug_override (`--slug=`) before touching the database", async () => {
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		const { db, captured } = makeFreshDb();
		await expect(
			runImport(db, stubAdapter("remark42", exported), "", "test-secret", {
				slug_override: "",
			}),
		).rejects.toThrow('import: slug override "" is not a valid slug');
		expect(captured).toEqual([]);
	});

	it("refuses a slug_override the read API would reject", async () => {
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		const { db, captured } = makeFreshDb();
		await expect(
			runImport(db, stubAdapter("remark42", exported), "", "test-secret", {
				slug_override: "bad slug",
			}),
		).rejects.toThrow('import: slug override "bad slug" is not a valid slug');
		expect(captured).toEqual([]);
	});

	it("uses an adapter-supplied thread slug over one derived from the link", async () => {
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		exported.threads[0]!.slug = "from/the/source";
		const { db, captured } = makeFreshDb();
		await runImport(db, stubAdapter("isso", exported), "", "test-secret");
		const post = captured.find((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(post!.binds[0]).toBe("from/the/source");
	});

	it("refuses an adapter-supplied thread slug the read API would reject, naming the thread", async () => {
		const exported = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		exported.threads[0]!.slug = "has a space";
		const { db, captured } = makeFreshDb();
		await expect(
			runImport(db, stubAdapter("isso", exported), "", "test-secret"),
		).rejects.toThrow("import: threads[0] carries a slug the read API would reject");
		expect(captured).toEqual([]);
	});

	it("still passes a link-derived slug through unchecked, as it always has", async () => {
		// Pre-existing behavior, pinned so the adapter-slug check above cannot
		// quietly grow to cover it: a percent-encoded path imported before this
		// check existed and must keep importing.
		const exported = exportOf(
			[{ name: "A", email: null, is_anonymous: true }],
			"https://example.com/caf%C3%A9",
		);
		const { db, captured } = makeFreshDb();
		await runImport(db, stubAdapter("disqus", exported), "", "test-secret");
		const post = captured.find((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(post!.binds[0]).toBe("caf%C3%A9");
	});

	it("falls back to a source-prefixed slug when a thread has no link", async () => {
		const exported = exportOf(
			[{ name: "A", email: null, is_anonymous: true }],
			null,
		);
		const { db, captured } = makeFreshDb();
		await runImport(db, stubAdapter("remark42", exported), "", "test-secret");
		const post = captured.find((c) => c.sql.startsWith("INSERT INTO posts"));
		expect(post!.binds[0]).toBe("remark42-t1");
	});
});

describe("source moderation state", () => {
	const withStatus = (status: SourceStatus): SourceExport => {
		const e = exportOf([{ name: "A", email: null, is_anonymous: true }]);
		e.comments[0] = { ...e.comments[0]!, status };
		return e;
	};

	const importWith = async (
		status: SourceStatus,
		opts: Parameters<typeof runImport>[4] = {},
	) => {
		const { db, captured } = makeFreshDb();
		const plan = await runImport(
			db,
			stubAdapter("remark42", withStatus(status)),
			"",
			"test-secret",
			opts,
		);
		const insert = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		// Bind order: id, post_slug, user_id, body_md, body_html,
		// renderer_version, status, created_at, edited_at, import_source,
		// import_id.
		return { plan, status: insert?.binds[6] as string | undefined };
	};

	it("carries the source's status onto comments.status", async () => {
		expect((await importWith("approved")).status).toBe("approved");
		expect((await importWith("pending")).status).toBe("pending");
	});

	it("imports a pending comment without needing a flag", async () => {
		// Not gated: a comment awaiting moderation is unfinished work, not junk.
		// Dropping it silently loses a call the operator never got to make.
		const { plan, status } = await importWith("pending");
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_deleted).toBe(0);
		expect(plan.skipped_spam).toBe(0);
		expect(status).toBe("pending");
	});

	it("skips spam and deleted by default", async () => {
		const spam = await importWith("spam");
		expect(spam.plan.new_comments).toBe(0);
		expect(spam.plan.skipped_spam).toBe(1);
		const gone = await importWith("deleted");
		expect(gone.plan.new_comments).toBe(0);
		expect(gone.plan.skipped_deleted).toBe(1);
	});

	it("lands spam in the spam status when include_spam is set", async () => {
		const { plan, status } = await importWith("spam", { include_spam: true });
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_spam).toBe(0);
		// Not 'approved'. The whole point of importing spam is to review it, so
		// it has to arrive somewhere a moderator looks — not published.
		expect(status).toBe("spam");
	});

	it("imports a tombstone as deleted when include_deleted is set", async () => {
		const { plan, status } = await importWith("deleted", {
			include_deleted: true,
		});
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_deleted).toBe(0);
		expect(status).toBe("deleted");
	});

	it("does not invent a deleted_at for an imported tombstone", async () => {
		const { db, captured } = makeFreshDb();
		await runImport(
			db,
			stubAdapter("remark42", withStatus("deleted")),
			"",
			"test-secret",
			{ include_deleted: true },
		);
		const insert = captured.find((c) =>
			c.sql.startsWith("INSERT INTO comments"),
		);
		// No source says when or by whom; the read path prunes on status alone.
		expect(insert!.sql).not.toContain("deleted_at");
		expect(insert!.sql).not.toContain("deleted_by");
	});
});

describe("source fidelity mappings", () => {
	const AUTHOR: SourceAuthor = { name: "A", email: null, is_anonymous: true };

	const importOf = async (exported: SourceExport) => {
		const { db, captured } = makeFreshDb();
		await runImport(db, stubAdapter("remark42", exported), "", "test-secret");
		const find = (table: string) =>
			captured.find((c) => c.sql.startsWith(`INSERT INTO ${table}`));
		return {
			captured,
			// posts:    slug, title, url, created_at, closed
			// users:    id, provider_id, name, is_banned, created_at, import_source
			// comments: id, post_slug, user_id, body_md, body_html,
			//           renderer_version, status, created_at, edited_at,
			//           import_source, import_id
			closed: find("posts")?.binds[4],
			banned: find("users")?.binds[3],
			editedAt: find("comments")?.binds[8],
		};
	};

	it("carries a closed source thread onto posts.closed", async () => {
		const e = exportOf([AUTHOR]);
		e.threads[0] = { ...e.threads[0]!, closed: true };
		expect((await importOf(e)).closed).toBe(1);
	});

	it("leaves posts.closed at 0 when the source does not say", async () => {
		// Absent is "no information", and the schema default for an open page is
		// the same value, so a source with no notion of closing is a no-op.
		expect((await importOf(exportOf([AUTHOR]))).closed).toBe(0);
	});

	it("carries a blocked author onto users.is_banned", async () => {
		expect(
			(await importOf(exportOf([{ ...AUTHOR, is_banned: true }]))).banned,
		).toBe(1);
	});

	it("leaves users.is_banned at 0 when the source does not say", async () => {
		expect((await importOf(exportOf([AUTHOR]))).banned).toBe(0);
	});

	it("bans the ghost if any one of the author's comments reports it", async () => {
		// Same person, disagreeing rows — an export taken mid-moderation, or a
		// source that only stamps the flag on rows written after the block. The
		// ban has to survive regardless of which comment the core sees first.
		const e = exportOf([AUTHOR]);
		e.comments.push({
			...e.comments[0]!,
			source_id: "c2",
			author: { ...AUTHOR, is_banned: true },
		});
		const { captured, banned } = await importOf(e);
		expect(banned).toBe(1);
		// And it is still one ghost, not two.
		expect(
			captured.filter((c) => c.sql.startsWith("INSERT INTO users")),
		).toHaveLength(1);
	});

	it("never writes ban state onto a user that already exists", async () => {
		// The ghost may have been banned or unbanned on this side since the last
		// import. Overwriting an operator's decision with the source's stale one
		// is a moderation regression, so the import only ever writes on INSERT.
		const captured: { sql: string; binds: unknown[] }[] = [];
		const db = asD1({
			prepare: (sql: string) => ({
				_binds: [] as unknown[],
				bind(...args: unknown[]) {
					this._binds = args;
					return this;
				},
				async first() {
					captured.push({ sql, binds: this._binds });
					// The author already has a ghost; nothing else exists.
					return sql.includes("FROM users") ? { id: "u-existing" } : null;
				},
				async all() {
					captured.push({ sql, binds: this._binds });
					return { results: [] };
				},
				async run() {
					captured.push({ sql, binds: this._binds });
					return { meta: { changes: 1 } };
				},
			}),
		});
		await runImport(
			db,
			stubAdapter("remark42", exportOf([{ ...AUTHOR, is_banned: true }])),
			"",
			"test-secret",
		);
		expect(captured.filter((c) => /^INSERT INTO users/.test(c.sql))).toEqual(
			[],
		);
		expect(captured.filter((c) => /^UPDATE users/.test(c.sql))).toEqual([]);
	});

	// No argument = the adapter left the field off entirely, which under
	// exactOptionalPropertyTypes is a different thing from setting it undefined.
	const withEdit = (...edited_at: [number | null] | []): SourceExport => {
		const e = exportOf([AUTHOR]);
		const c = e.comments[0]!;
		e.comments[0] = edited_at.length ? { ...c, edited_at: edited_at[0] } : c;
		return e;
	};

	it("carries a real edit timestamp onto comments.edited_at", async () => {
		expect((await importOf(withEdit(AT + 60_000))).editedAt).toBe(AT + 60_000);
	});

	it("stores no edit timestamp when the source reports none", async () => {
		expect((await importOf(withEdit())).editedAt).toBe(null);
		expect((await importOf(withEdit(null))).editedAt).toBe(null);
	});

	it("drops an edit timestamp that is not after creation", async () => {
		// A source that copies created_at into its edit field for every row, or
		// zeroes it, would otherwise mark the whole archive as edited and flatten
		// the feed's <updated> onto <published>.
		expect((await importOf(withEdit(AT))).editedAt).toBe(null);
		expect((await importOf(withEdit(AT - 1))).editedAt).toBe(null);
		expect((await importOf(withEdit(0))).editedAt).toBe(null);
	});
});

describe("decodeImportInput", () => {
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

	it("passes plain bytes through as UTF-8", async () => {
		const xml = "<disqus><thread dsq:id=\"t1\"/></disqus>";
		expect(await decodeImportInput(new TextEncoder().encode(xml))).toBe(xml);
	});

	it("round-trips a gzipped export", async () => {
		const xml = "<disqus><post dsq:id=\"p1\"><message>hi</message></post></disqus>";
		expect(await decodeImportInput(await gzip(xml))).toBe(xml);
	});

	it("does not split a multibyte character across inflate chunks", async () => {
		// The streaming TextDecoder has to hold a partial sequence over. Long
		// enough that the decompressor emits more than one chunk.
		const xml = `<disqus>${"café — ☕".repeat(20_000)}</disqus>`;
		expect(await decodeImportInput(await gzip(xml))).toBe(xml);
	});

	it("accepts an ArrayBuffer as well as a Uint8Array", async () => {
		const xml = "<disqus/>";
		const u8 = await gzip(xml);
		const ab = u8.buffer.slice(
			u8.byteOffset,
			u8.byteOffset + u8.byteLength,
		) as ArrayBuffer;
		expect(await decodeImportInput(ab)).toBe(xml);
	});

	it("sniffs the gzip magic rather than trusting a name or header", async () => {
		// A gzip member always starts 1f 8b (RFC 1952). Text that does not is
		// decoded as-is even if the caller thought it was compressed.
		const notGz = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c]);
		expect(await decodeImportInput(notGz)).toBe("<?xml");
	});

	it("reports a corrupt gzip member without echoing its content", async () => {
		const u8 = await gzip("<disqus>secret@example.com</disqus>");
		u8[u8.length - 5] = (u8.at(-5) ?? 0) ^ 0xff; // wreck the trailing CRC32
		await expect(decodeImportInput(u8)).rejects.toThrow(
			/could not gunzip import/,
		);
		// An export carries names, emails and IPs. None of it belongs in an
		// error string that reaches a log or an HTTP body.
		await expect(decodeImportInput(u8)).rejects.not.toThrow(/example\.com/);
	});

	it("aborts a decompression bomb instead of inflating it", async () => {
		// Compresses to a few KB, expands past the cap. Without the streaming
		// check this allocates the whole thing before any limit is consulted.
		const bomb = await gzip("A".repeat(MAX_IMPORT_BYTES + 1024));
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		await expect(decodeImportInput(bomb)).rejects.toThrow(ImportTooLargeError);
	});
});

/**
 * `slugFromPath` is the shared rule for sources that store a path rather than
 * a URL (isso `threads.uri`, Cusdis `pages.slug`). It was written inside the
 * isso adapter and lifted here when Cusdis needed it; the isso suite still
 * pins it through `issoSlug`, this pins the helper's own contract.
 */
describe("slugFromPath", () => {
	it("strips and collapses slashes", () => {
		expect(slugFromPath("/posts/deep//nested/", "x-", "x-root")).toBe("posts/deep/nested");
		expect(slugFromPath("hello-world", "x-", "x-root")).toBe("hello-world");
	});

	it("names an empty path after the given root", () => {
		expect(slugFromPath("/", "x-", "x-root")).toBe("x-root");
		expect(slugFromPath("", "x-", "x-root")).toBe("x-root");
		expect(slugFromPath("///", "x-", "x-root")).toBe("x-root");
	});

	it("keeps ? and # as part of the identity, and digests the result", () => {
		const paged = slugFromPath("/posts/a?page=2", "x-", "x-root");
		expect(paged).toMatch(/^x-[0-9a-f]{16}$/);
		expect(paged).not.toBe(slugFromPath("/posts/a", "x-", "x-root"));
		expect(slugFromPath("/gallery#12", "x-", "x-root")).not.toBe(
			slugFromPath("/gallery#13", "x-", "x-root"),
		);
	});

	it("digests a path the read API would reject", () => {
		for (const bad of ["/a b", "/über", "/a:b", `/${"x".repeat(201)}`]) {
			expect(slugFromPath(bad, "x-", "x-root")).toMatch(/^x-[0-9a-f]{16}$/);
		}
	});

	it("digests the derived candidate, so slash variants share a page", () => {
		expect(slugFromPath("/a b", "x-", "x-root")).toBe(slugFromPath("/a b/", "x-", "x-root"));
		expect(slugFromPath("/a b", "x-", "x-root")).toBe(`x-${slugDigest("a b")}`);
	});

	it("is stable — the digest is part of the idempotency contract", () => {
		// FNV-1a 64 of "a b". Changing this value re-pages every digested
		// thread on re-import; if this test fails, that is the bug.
		expect(slugDigest("a b")).toBe("e63f991904833892");
	});
});

describe("requireKnownIdentifier", () => {
	it("passes silently when the value is present", () => {
		expect(() => requireKnownIdentifier("m", "a", new Set(["a", "b"]))).not.toThrow();
	});

	it("names the available identifiers when the value is absent", () => {
		expect(() => requireKnownIdentifier("no site", "z", new Set(["b", "a"]))).toThrow(
			'no site "z" — nothing would be imported. This file has: a, b',
		);
	});

	it("says so when the file names none at all", () => {
		expect(() => requireKnownIdentifier("no site", "z", new Set())).toThrow(
			/names none at all/,
		);
	});

	it("caps the listing at ten", () => {
		const many = new Set(Array.from({ length: 12 }, (_, i) => `s${String(i).padStart(2, "0")}`));
		expect(listIdentifiers(many)).toBe(
			"s00, s01, s02, s03, s04, s05, s06, s07, s08, s09, …",
		);
	});
});
