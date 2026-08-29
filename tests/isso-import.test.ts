/**
 * isso importer tests cover:
 *
 *   1. `parseIssoDump` — refuses a non-array top level, a thread that isn't
 *      an object, a thread with no `comments` array, a thread with no usable
 *      id, a comment that isn't an object, a comment with no usable id or
 *      timestamp, a comment with an unusable `parent`, and an unrecognised
 *      `mode`; never puts a value (author, email, text) in an error, only an
 *      index; accepts a comment carrying only `created` (parsed as UTC) and
 *      computes the same milliseconds the adjacent `created_epoch` would;
 *      accepts a numeric-string `id`/`parent`, refuses a fractional one.
 *   1a. Hand-edited dumps — a dump is a file on disk between two commands,
 *      so the fields that used to fall open on a value the dumper never
 *      writes are pinned: a present-but-unreadable `mode`, an integer past
 *      the safe range or a string only `Number()` calls numeric, an epoch
 *      that overflows the millisecond conversion, and a `uri` that makes
 *      `new URL` throw.
 *   2. `issoSlug` — R2: strip/collapse slashes, `isso-root` for `/`; a `?`
 *      or `#` is part of the thread id, never cut.
 *   3. Export shape over the committed fixture (5 threads on disk, one
 *      empty and dropped, a `?page=2` thread kept apart from its sibling).
 *   4. Moderation — isso's `mode` maps to Garrul's status vocabulary;
 *      tombstones (`mode=4`) sit behind `include_deleted` like every other
 *      source, and their replies re-root when the tombstone is skipped.
 *   5. Identity — isso has no user accounts, so every author keys on
 *      name+email (never `source_id`), and a blank/absent name becomes the
 *      literal `"anonymous"`.
 *   6. Timestamps — isso's epoch float seconds become
 *      `Math.round(x * 1000)` milliseconds.
 *   7. Markdown passes through untouched and renders through the shared
 *      sanitizer.
 *   8. `site` — supplies the host isso itself has no concept of; an
 *      invalid or unparseable origin is refused eagerly, and a resolved link
 *      that lands off `site`'s own origin (R10, a client-declared `uri` can
 *      claim `//evil.example/x`) is nulled rather than trusted or thrown.
 *   9. Idempotency is the core's; pinned here because the source tag is
 *      this adapter's contribution to it.
 *  10. `include_spam` is a no-op — isso never emits a `spam` status.
 *
 * Fixture: tests/fixtures/isso/dump.json (Task 1, #108) — 5 threads, 12
 * comments, hand-written and identity-free (tests/fixtures/isso/
 * PROVENANCE.md). No Miniflare; hand-rolled capturing D1 stub, same as the
 * Disqus/Remark42/Comentario suites.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ISSO_ADAPTER,
	issoAdapter,
	issoSlug,
	issoStatus,
	parseIssoDump,
	runIssoImport,
} from "../src/lib/import/isso";
import { SLUG_RE } from "../src/routes/api.comments";
import { asD1 } from "./helpers/d1";

type Captured = { sql: string; binds: unknown[] };

// Every SELECT misses, so every insert proceeds.
const makeFreshDb = () => {
	const captured: Captured[] = [];
	const chain = (sql: string) => ({
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
	});
	return { db: asD1({ prepare: (sql: string) => chain(sql) }), captured };
};

// A stub where every existence check hits, so a re-run inserts nothing.
const makeAlreadyImportedDb = () => {
	const captured: Captured[] = [];
	const chain = (sql: string) => ({
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
			if (sql.includes("FROM posts WHERE slug")) return { slug: "hello-world" };
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
	});
	return { db: asD1({ prepare: (sql: string) => chain(sql) }), captured };
};

const inserts = (captured: Captured[], table: string) =>
	captured.filter((c) => c.sql.startsWith(`INSERT INTO ${table}`));
const updates = (captured: Captured[], table: string) =>
	captured.filter((c) => c.sql.startsWith(`UPDATE ${table}`));

const FIXTURE_PATH = join(__dirname, "fixtures/isso/dump.json");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

// ------------------------------ builders ------------------------------

const comment = (over: Partial<Record<string, unknown>> = {}) => ({
	id: 1,
	parent: null,
	mode: 1,
	created: "2023-11-14 22:13:20",
	created_epoch: 1700000000.123456,
	modified_epoch: null,
	author: "Alice Example",
	email: "alice@example.com",
	website: null,
	remote_addr: "127.0.0.0",
	text: "hello",
	...over,
});

const dump = (threads: Record<string, unknown>[]) => JSON.stringify(threads);

// -------------------------------- 1. parse --------------------------------

describe("parseIssoDump", () => {
	it("refuses a non-array top level", () => {
		expect(() => parseIssoDump(JSON.stringify({ id: "/x", comments: [] }))).toThrow(
			/top level is not an array/,
		);
	});

	it("refuses a thread with no comments array", () => {
		expect(() => parseIssoDump(dump([{ id: "/x", title: null }]))).toThrow(
			/threads\[0\] has no comments array/,
		);
	});

	it("refuses a comment with no usable id", () => {
		const c = comment();
		delete (c as Record<string, unknown>).id;
		expect(() =>
			parseIssoDump(dump([{ id: "/x", title: null, comments: [c] }])),
		).toThrow(/threads\[0\]\.comments\[0\]/);
	});

	it("refuses a thread whose id is not a string", () => {
		expect(() =>
			parseIssoDump(dump([{ id: 42, title: null, comments: [comment()] }])),
		).toThrow(/threads\[0\] has no usable id/);
	});

	it("refuses a fractional comment id", () => {
		const c = comment({ id: 1.5 });
		expect(() =>
			parseIssoDump(dump([{ id: "/x", title: null, comments: [c] }])),
		).toThrow(/threads\[0\]\.comments\[0\]/);
	});

	it("accepts a numeric-string comment id", () => {
		const [thread] = parseIssoDump(
			dump([{ id: "/x", title: null, comments: [comment({ id: "7" })] }]),
		);
		expect(thread!.comments[0]!.id).toBe(7);
	});

	it("imports a numeric-string comment id as import_id \"7\"", () => {
		const out = ISSO_ADAPTER.parse(
			dump([{ id: "/x", title: null, comments: [comment({ id: "7" })] }]),
		);
		expect(out.comments[0]!.source_id).toBe("7");
	});

	it("refuses an unusable parent", () => {
		const c = comment({ parent: "not-a-number" });
		expect(() =>
			parseIssoDump(dump([{ id: "/x", title: null, comments: [c] }])),
		).toThrow(/threads\[0\]\.comments\[0\]/);
	});

	it("accepts a numeric-string parent, same as id", () => {
		const [thread] = parseIssoDump(
			dump([{ id: "/x", title: null, comments: [comment({ id: 2, parent: "1" })] }]),
		);
		expect(thread!.comments[0]!.parent).toBe(1);
	});

	it("refuses a comment with no usable timestamp", () => {
		const c = comment({ created: undefined, created_epoch: undefined });
		expect(() =>
			parseIssoDump(dump([{ id: "/x", title: null, comments: [c] }])),
		).toThrow(/threads\[0\]\.comments\[0\]/);
	});

	it("accepts a comment with only created (UTC) and computes the same ms as the epoch", () => {
		const [thread] = parseIssoDump(
			dump([
				{
					id: "/x",
					title: null,
					comments: [comment({ created_epoch: undefined, created: "2023-11-14 22:13:20" })],
				},
			]),
		);
		const c = thread!.comments[0]!;
		expect(Math.round(c.created_epoch * 1000)).toBe(1700000000000);
	});

	it("never puts author, email or text content in a parse error", () => {
		const secret = "topsecret-author-name";
		let msg = "";
		try {
			parseIssoDump(
				dump([
					{
						id: "/x",
						title: null,
						comments: [{ author: secret, text: secret }],
					},
				]),
			);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/threads\[0\]\.comments\[0\]/);
		expect(msg).not.toContain(secret);
	});

	// The mode → status mapping lives in issoStatus/toExport, but a full
	// adapter parse over an unrecognised mode still refuses by index only.
	it("refuses an unknown mode via the full adapter parse", () => {
		expect(() =>
			ISSO_ADAPTER.parse(dump([{ id: "/x", title: null, comments: [comment({ mode: 3 })] }])),
		).toThrow(/threads\[0\]\.comments\[0\].*mode 3/);
	});
});

// ------------------- 1a. hand-edited dumps (hardening) ---------------------

/**
 * A dump is a file on an operator's disk between two commands, so it gets
 * hand-edited, re-serialised by other tools, and truncated. These pin the
 * fields that used to fall open on a value the dumper would never write:
 * a non-numeric `mode` silently becoming "approved", a string that only
 * looks numeric to `Number()`, an epoch big enough to overflow the
 * millisecond conversion, and a `uri` that makes `new URL` throw.
 */
describe("parseIssoDump — hand-edited dumps", () => {
	const parseOne = (over: Record<string, unknown>) =>
		parseIssoDump(dump([{ id: "/x", title: null, comments: [comment(over)] }]));
	const exportOne = (over: Record<string, unknown>) =>
		ISSO_ADAPTER.parse(dump([{ id: "/x", title: null, comments: [comment(over)] }]));

	// -- mode --

	it("reads a numeric-string mode the same as the number", () => {
		expect(exportOne({ mode: "2" }).comments[0]!.status).toBe("pending");
		expect(
			ISSO_ADAPTER.parse(
				dump([{ id: "/x", title: null, comments: [comment({ mode: "4" })] }]),
			).comments[0]!.status,
		).toBe("deleted");
	});

	it("defaults an absent mode to approved (the generic format has none)", () => {
		const c = comment();
		delete (c as Record<string, unknown>).mode;
		const out = ISSO_ADAPTER.parse(dump([{ id: "/x", title: null, comments: [c] }]));
		expect(out.comments[0]!.status).toBe("approved");
	});

	it("defaults a null mode to approved", () => {
		expect(exportOne({ mode: null }).comments[0]!.status).toBe("approved");
	});

	it("refuses a mode that is present but unreadable, naming the index", () => {
		expect(() => parseOne({ mode: true })).toThrow(
			/isso dump: threads\[0\]\.comments\[0\] has an unusable mode/,
		);
	});

	it("still refuses a readable but unrecognised mode", () => {
		expect(() => exportOne({ mode: 3 })).toThrow(/threads\[0\]\.comments\[0\].*mode 3/);
	});

	// -- readIssoInt --

	// Written as an expression rather than the literal 9007199254740993:
	// that literal does not survive JS number parsing (it *is* 2**53), and
	// spelling it out only invites a reader — or a linter — to think the
	// test means something it can't mean.
	it("refuses an id past the safe-integer range", () => {
		expect(() => parseOne({ id: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			/threads\[0\]\.comments\[0\] has no usable id/,
		);
	});

	it("refuses a numeric-string id past the safe-integer range", () => {
		expect(() => parseOne({ id: "9007199254740993" })).toThrow(
			/threads\[0\]\.comments\[0\] has no usable id/,
		);
	});

	it("refuses a hex-looking id string", () => {
		expect(() => parseOne({ id: "0x10" })).toThrow(
			/threads\[0\]\.comments\[0\] has no usable id/,
		);
	});

	it("refuses an exponent-notation id string", () => {
		expect(() => parseOne({ id: "1e21" })).toThrow(
			/threads\[0\]\.comments\[0\] has no usable id/,
		);
	});

	it("refuses a padded numeric id string rather than silently trimming it", () => {
		expect(() => parseOne({ id: " 12 " })).toThrow(
			/threads\[0\]\.comments\[0\] has no usable id/,
		);
	});

	// -- epoch range --

	it("refuses a created_epoch that overflows the millisecond conversion", () => {
		expect(() => exportOne({ created_epoch: 1e308 })).toThrow(
			/threads\[0\]\.comments\[0\].*created_epoch/,
		);
	});

	it("refuses a modified_epoch that overflows the millisecond conversion", () => {
		expect(() => exportOne({ modified_epoch: 1e308 })).toThrow(
			/threads\[0\]\.comments\[0\].*modified_epoch/,
		);
	});

	// -- unparseable uri --

	it("imports a thread whose uri makes new URL throw, with a null link", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(
			db,
			dump([{ id: "http://", title: null, comments: [comment({ id: 201 })] }]),
			"secret",
			{ site: "https://blog.example.com" },
		);
		const postInserts = inserts(captured, "posts");
		expect(postInserts).toHaveLength(1);
		expect(postInserts[0]!.binds[2]).toBeNull();
		const commentInserts = inserts(captured, "comments");
		expect(commentInserts.some((c) => c.binds[10] === "201")).toBe(true);
	});

	// -- error prefix --

	it("prefixes every parse error with 'isso dump:', including the thread id one", () => {
		expect(() =>
			parseIssoDump(dump([{ id: 42, title: null, comments: [comment()] }])),
		).toThrow(/^isso dump: threads\[0\] has no usable id/);
	});
});

// ------------------------------- 2. issoSlug -------------------------------

describe("issoSlug", () => {
	it("maps a plain path", () => {
		expect(issoSlug("/hello-world")).toBe("hello-world");
	});

	it("maps the root path to the isso-root sentinel", () => {
		expect(issoSlug("/")).toBe("isso-root");
	});

	it("collapses repeated slashes", () => {
		expect(issoSlug("//a//b/")).toBe("a/b");
	});

	// An isso `uri` is the thread's identity verbatim, not a URL. A `?` or
	// `#` is only ever in one because the site owner put it in
	// `data-isso-id`, so it separates threads — `/?p=1` and `/?p=2` are two
	// pages on a WordPress-default-permalink site, `gallery#12` and
	// `gallery#13` two anchors. Cutting there merged them all onto one page.
	it("keeps a query string as part of the thread id", () => {
		const a = issoSlug("/?p=1");
		const b = issoSlug("/?p=2");
		expect(a).not.toBe(b);
		expect(a).not.toBe("isso-root");
		expect(issoSlug("/posts/deep/nested/path/?page=2")).not.toBe(
			issoSlug("/posts/deep/nested/path/"),
		);
	});

	it("keeps a fragment as part of the thread id", () => {
		expect(issoSlug("/gallery#12")).not.toBe(issoSlug("/gallery#13"));
		expect(issoSlug("/gallery#12")).not.toBe("gallery");
	});
});

// ------------------- 2a. slugs the read API can address ---------------------

/**
 * isso's `uri` is client-declared free text, but a Garrul slug is the path
 * segment `GET /api/v1/comments?slug=…` validates against SLUG_RE. A uri
 * carrying a space, a non-ASCII character, a `:` or more than 200 characters
 * used to pass straight through, so the comments imported and then no reader
 * could ever load them — a 400 on every request for that page.
 *
 * Pinned against the real SLUG_RE rather than a copy, so the adapter's
 * mirrored constant cannot drift away from the route that enforces it.
 */
describe("issoSlug — addressability", () => {
	const FALLBACK_RE = /^isso-[0-9a-f]{16}$/;

	it("leaves a slug the read API already accepts alone", () => {
		expect(issoSlug("/posts/2023/hello-world")).toBe("posts/2023/hello-world");
		expect(SLUG_RE.test(issoSlug("/posts/2023/hello-world"))).toBe(true);
	});

	it.each([
		["a space", "/hello world"],
		["a non-ASCII character", "/über"],
		["a colon", "/a:b"],
		["over 200 characters", `/${"a".repeat(250)}`],
	])("falls back for a uri with %s", (_label, uri) => {
		const slug = issoSlug(uri);
		expect(slug).toMatch(FALLBACK_RE);
		expect(SLUG_RE.test(slug)).toBe(true);
	});

	it("is stable for the same uri and distinct for a different one", () => {
		expect(issoSlug("/hello world")).toBe(issoSlug("/hello world"));
		expect(issoSlug("/hello world")).not.toBe(issoSlug("/goodbye world"));
	});

	it("still merges two uris that differ only by slashes", () => {
		// The fallback keys on the derived slug, not the raw uri, so the
		// slash normalisation applies to a digest slug as much as a plain one.
		expect(issoSlug("/hello world/")).toBe(issoSlug("hello world"));
	});

	it("gives a query-string thread its own digest slug", () => {
		expect(issoSlug("/?p=1")).toMatch(FALLBACK_RE);
		expect(issoSlug("/posts/deep/nested/path/?page=2")).toMatch(FALLBACK_RE);
	});

	it("imports an unaddressable thread onto the fallback slug end to end", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(
			db,
			dump([{ id: "/hello world", title: null, comments: [comment({ id: 301 })] }]),
			"secret",
		);
		const postInserts = inserts(captured, "posts");
		expect(postInserts).toHaveLength(1);
		const slug = postInserts[0]!.binds[0] as string;
		expect(slug).toMatch(FALLBACK_RE);
		const commentInserts = inserts(captured, "comments");
		expect(commentInserts[0]!.binds[1]).toBe(slug);
	});
});

// --------------------------- issoStatus (direct) ---------------------------

describe("issoStatus", () => {
	it("maps the three known modes", () => {
		expect(issoStatus(1, "x")).toBe("approved");
		expect(issoStatus(2, "x")).toBe("pending");
		expect(issoStatus(4, "x")).toBe("deleted");
	});

	it("throws on anything else, naming the index", () => {
		expect(() => issoStatus(3, "threads[0].comments[5]")).toThrow(
			/threads\[0\]\.comments\[5\]/,
		);
	});
});

// -------------------------- 3. export shape over fixture -------------------

describe("ISSO_ADAPTER over the fixture", () => {
	it("drops the empty thread and keeps the rest", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		expect(out.threads).toHaveLength(4);
		expect(out.comments).toHaveLength(12);
		expect(out.threads.some((t) => t.source_id === "/empty")).toBe(false);
	});

	it("keeps the query-string thread apart from its no-query sibling", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const withQuery = out.threads.find(
			(t) => t.source_id === "/posts/deep/nested/path/?page=2",
		)!;
		const withoutQuery = out.threads.find(
			(t) => t.source_id === "/posts/deep/nested/path/",
		)!;
		expect(withoutQuery.slug).toBe("posts/deep/nested/path");
		expect(withQuery.slug).toMatch(/^isso-[0-9a-f]{16}$/);
	});

	it("reports pages_total 4 and merged_pages 0 on a fresh-db dry run", async () => {
		const { db } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret", { dry_run: true });
		expect(plan.pages_total).toBe(4);
		expect(plan.merged_pages).toBe(0);
		expect(plan.new_pages).toBe(4);
	});

	it("slug_override beats the adapter's own slug for every thread", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret", { slug_override: "forced" });
		// `pages_total` is core's count of source threads (`parsed.threads.
		// length`), not distinct slugs, so it stays 4 even here — what
		// slug_override actually collapses onto one page is `new_pages` and
		// `merged_pages`, which core's own doc comment says reads 0 under
		// slug_override (a merge only counts as a surprise when the operator
		// didn't ask for one).
		expect(plan.pages_total).toBe(4);
		expect(plan.merged_pages).toBe(0);
		expect(plan.new_pages).toBe(1);

		const commentInserts = inserts(captured, "comments");
		// 12 comments in the fixture minus the tombstone (mode 4), which stays
		// behind include_deleted like any other run.
		expect(commentInserts).toHaveLength(11);
		for (const c of commentInserts) {
			expect(c.binds[1]).toBe("forced");
		}
	});
});

// -------------------------------- 4. status ---------------------------------

describe("moderation status", () => {
	it("maps the fixture's pending and deleted comments, others approved", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c5 = out.comments.find((c) => c.source_id === "5")!;
		const c6 = out.comments.find((c) => c.source_id === "6")!;
		const c1 = out.comments.find((c) => c.source_id === "1")!;
		expect(c5.status).toBe("pending");
		expect(c6.status).toBe("deleted");
		expect(c1.status).toBe("approved");
	});

	it("skips the tombstone by default", async () => {
		const { db } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret");
		expect(plan.skipped_deleted).toBe(1);
	});

	it("inserts the tombstone under include_deleted and resolves its replies onto it", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret", { include_deleted: true });

		const commentInserts = inserts(captured, "comments");
		// id, post_slug, user_id, body_md, body_html, renderer_version, status,
		// created_at, edited_at, import_source, import_id
		const tombstoneInsert = commentInserts.find((c) => c.binds[10] === "6");
		expect(tombstoneInsert).toBeDefined();
		expect(tombstoneInsert!.binds[6]).toBe("deleted");
		expect(tombstoneInsert!.binds[3]).toBe("");
		const tombstoneId = tombstoneInsert!.binds[0];

		const commentUpdates = updates(captured, "comments");
		const c7Insert = commentInserts.find((c) => c.binds[10] === "7")!;
		const c7Id = c7Insert.binds[0];
		const c7Update = commentUpdates.find((u) => u.binds[2] === c7Id)!;
		expect(c7Update.binds[0]).toBe(tombstoneId);
		expect(c7Update.binds[1]).toBe(2);
	});

	it("leaves the tombstone's replies as roots without include_deleted", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret");

		const commentInserts = inserts(captured, "comments");
		const c7Insert = commentInserts.find((c) => c.binds[10] === "7")!;
		const c7Id = c7Insert.binds[0];
		const commentUpdates = updates(captured, "comments");
		expect(commentUpdates.some((u) => u.binds[2] === c7Id)).toBe(false);
	});
});

// -------------------------------- 5. identity -------------------------------

describe("identity", () => {
	it("shares one ghost between c1 and c3 (same name+email), a second for c4", async () => {
		const { db } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret");
		// 5 distinct seeds when the tombstone is skipped (default): Alice/alice,
		// Bob/bob, Alice/alice2, Carol/carol, anonymous/null.
		expect(plan.new_users).toBe(5);
	});

	it("binds c1's and c3's comment INSERTs to the same user_id, and c4's to a different one", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret");
		const commentInserts = inserts(captured, "comments");
		const userInserts = inserts(captured, "users");
		expect(userInserts.length).toBe(5);

		const c1 = commentInserts.find((c) => c.binds[10] === "1")!;
		const c3 = commentInserts.find((c) => c.binds[10] === "3")!;
		const c4 = commentInserts.find((c) => c.binds[10] === "4")!;
		// user_id is bind index 2 on the comments INSERT.
		expect(c3.binds[2]).toBe(c1.binds[2]);
		expect(c4.binds[2]).not.toBe(c1.binds[2]);
	});

	// isso's delete() nulls `author` but leaves `email`, so a tombstone
	// arrives as anonymous|alice@example.com — a name+email seed nothing else
	// shares. Keeping the email would mint one ghost per deleted author and
	// re-attach a comment isso already stripped of its identity to that
	// identity. The adapter drops it, so every tombstone lands on the same
	// anonymous ghost c8 already uses.
	it("lands the tombstone on the existing anonymous ghost under include_deleted", async () => {
		const { db } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret", { include_deleted: true });
		expect(plan.new_users).toBe(5);
	});

	it("binds the tombstone and the anonymous comment to the same user_id", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret", { include_deleted: true });
		const commentInserts = inserts(captured, "comments");
		const tombstone = commentInserts.find((c) => c.binds[10] === "6")!;
		const anonymous = commentInserts.find((c) => c.binds[10] === "8")!;
		expect(tombstone.binds[2]).toBe(anonymous.binds[2]);
	});

	it("drops the tombstone's leftover email from the export", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c6 = out.comments.find((c) => c.source_id === "6")!;
		expect(c6.author.name).toBe("anonymous");
		expect(c6.author.email).toBeNull();
	});

	it("names a null author anonymous and never sets source_id", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c8 = out.comments.find((c) => c.source_id === "8")!;
		expect(c8.author.name).toBe("anonymous");
		expect(c8.author.is_anonymous).toBe(true);
		expect(c8.author.source_id).toBeUndefined();
		for (const c of out.comments) {
			expect(c.author.source_id).toBeUndefined();
		}
	});
});

// ------------------------------- 6. timestamps ------------------------------

describe("timestamps", () => {
	it("converts created_epoch to milliseconds", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c1 = out.comments.find((c) => c.source_id === "1")!;
		expect(c1.created_at).toBe(Math.round(1700000000.123456 * 1000));
	});

	it("converts modified_epoch to milliseconds for an edited comment", () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c9 = out.comments.find((c) => c.source_id === "9")!;
		expect(c9.edited_at).toBe(Math.round(1700000900.666666 * 1000));
	});

	it("binds edited_at NULL for an unedited comment", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret");
		const commentInserts = inserts(captured, "comments");
		const c1Insert = commentInserts.find((c) => c.binds[10] === "1")!;
		expect(c1Insert.binds[8]).toBeNull();
	});
});

// -------------------------------- 7. markdown -------------------------------

describe("markdown", () => {
	it("passes the fixture body through verbatim as body_md and renders it", async () => {
		const out = ISSO_ADAPTER.parse(FIXTURE);
		const c1 = out.comments.find((c) => c.source_id === "1")!;
		expect(c1.body_md).toBe(
			"This is **bold** text, with a list:\n\n- one\n- two\n\na [link](https://example.com/), a blockquote:\n\n> quoted text\n\nand `inline code`.",
		);

		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret");
		const commentInserts = inserts(captured, "comments");
		const c1Insert = commentInserts.find((c) => c.binds[10] === "1")!;
		const html = c1Insert.binds[4] as string;
		expect(html).toContain("<strong>");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<code>");
		expect(html).toMatch(/<a [^>]*rel="nofollow ugc noopener"/);
	});
});

// ---------------------------------- 8. site ---------------------------------

describe("site", () => {
	it("resolves a page link against the site origin", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret", { site: "https://blog.example.com" });
		const postInserts = inserts(captured, "posts");
		const hello = postInserts.find((p) => p.binds[0] === "hello-world")!;
		expect(hello.binds[2]).toBe("https://blog.example.com/hello-world");
		const deep = postInserts.find((p) => p.binds[0] === "posts/deep/nested/path")!;
		expect(deep.binds[2]).toBe("https://blog.example.com/posts/deep/nested/path/");
		// The `?page=2` thread is its own page, and keeps its own link.
		const paged = postInserts.find((p) => /^isso-[0-9a-f]{16}$/.test(p.binds[0] as string))!;
		expect(paged.binds[2]).toBe("https://blog.example.com/posts/deep/nested/path/?page=2");
	});

	it("leaves url null without a site", async () => {
		const { db, captured } = makeFreshDb();
		await runIssoImport(db, FIXTURE, "secret");
		const postInserts = inserts(captured, "posts");
		const hello = postInserts.find((p) => p.binds[0] === "hello-world")!;
		expect(hello.binds[2]).toBeNull();
	});

	it("throws on a non-http(s) site", () => {
		expect(() => issoAdapter({ site: "ftp://x" })).toThrow(
			"isso import: site must be an http(s) origin (--site / x-import-site)",
		);
	});

	it("throws the same message for an unparseable site", () => {
		expect(() => issoAdapter({ site: "not a url" })).toThrow(
			"isso import: site must be an http(s) origin (--site / x-import-site)",
		);
	});
});

// ------------------------- site origin pinning (R10) ------------------------

describe("site origin pinning (R10)", () => {
	it("nulls the link for an off-origin uri but still imports its comments", async () => {
		const { db, captured } = makeFreshDb();
		const evilDump = dump([
			{ id: "//evil.example/x", title: null, comments: [comment({ id: 101 })] },
		]);
		await runIssoImport(db, evilDump, "secret", { site: "https://blog.example.com" });

		const postInserts = inserts(captured, "posts");
		const evilPost = postInserts.find((p) => p.binds[0] === "evil.example/x")!;
		expect(evilPost).toBeDefined();
		expect(evilPost.binds[2]).toBeNull();

		const commentInserts = inserts(captured, "comments");
		expect(commentInserts.some((c) => c.binds[10] === "101")).toBe(true);
	});
});

// ------------------------------ 9. idempotency ------------------------------

describe("runIssoImport idempotency", () => {
	it("inserts nothing on a re-run of the same export", async () => {
		const { db, captured } = makeAlreadyImportedDb();
		const plan = await runIssoImport(db, FIXTURE, "secret");
		expect(plan.new_comments).toBe(0);
		expect(plan.new_pages).toBe(0);
		expect(plan.new_users).toBe(0);
		expect(inserts(captured, "comments")).toHaveLength(0);
	});
});

// ------------------------------ 10. include_spam ----------------------------

describe("include_spam", () => {
	it("is a no-op — isso never emits a spam status", async () => {
		const { db } = makeFreshDb();
		const plan = await runIssoImport(db, FIXTURE, "secret", { include_spam: true });
		expect(plan.skipped_spam).toBe(0);
	});
});

// ------------------------------ adapter identity ----------------------------

describe("ISSO_ADAPTER identity", () => {
	it("tags with source isso and its own slug fallback prefix", () => {
		expect(ISSO_ADAPTER.source).toBe("isso");
		expect(ISSO_ADAPTER.slugFallbackPrefix).toBe("isso-");
	});
});

