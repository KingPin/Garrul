/**
 * Cusdis adapter (src/lib/import/cusdis.ts, #109) over the dumper's JSON
 * intermediate. Covers:
 *
 *   1. parse — shape refusals with the `cusdis dump:` prefix, and that no
 *      error ever carries a nickname, email or body.
 *   2. slug — `slugFromPath` under the `cusdis-` prefix; the fixture's
 *      `/what is this?` page lands on a digest the read API accepts.
 *   3. status — `deleted_at` wins, then `approved` → approved / pending.
 *   4. project selection — a two-project file is refused by id *and* title,
 *      `project` selects one by id, an unknown id lists what the file has,
 *      an empty filter is no filter.
 *   5. links — `url` when http(s), else `site` resolution (same-origin
 *      only), else null.
 *   6. authors — blank nickname → "anonymous", null email stays null, a
 *      soft-deleted row keeps its real author, `edited_at` is never set.
 *   7. threading — parents resolve on the same page only; a ten-deep chain
 *      flattens to MAX_REPLY_DEPTH; a deleted parent's replies survive.
 *   8. runCusdisImport — dry-run counts, identity dedupe, idempotent re-run,
 *      `include_spam` is a no-op.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CUSDIS_ADAPTER,
	cusdisAdapter,
	cusdisSlug,
	cusdisStatus,
	parseCusdisDump,
	runCusdisImport,
} from "../src/lib/import/cusdis";
import { MAX_REPLY_DEPTH } from "../src/lib/tree";
import { SLUG_RE } from "../src/routes/api.comments";
import { asD1 } from "./helpers/d1";

type Captured = { sql: string; binds: unknown[] };

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

const FIXTURE = readFileSync(join(__dirname, "fixtures/cusdis/dump.json"), "utf8");

const BLOG = "11111111-1111-4111-8111-111111111111";
const DOCS = "22222222-2222-4222-8222-222222222222";
const cid = (n: number): string => `c${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const did = (n: number): string => `d${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pid = (n: number): string => `p${String(n).padStart(7, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The fixture holds two projects, so every whole-fixture parse selects one.
const BLOG_ADAPTER = cusdisAdapter({ project: BLOG });

// ------------------------------ synthetic dumps -----------------------------

const comment = (over: Partial<Record<string, unknown>> = {}) => ({
	id: "c-1",
	parent_id: null,
	created_at: 1700000000000,
	updated_at: 1700000000000,
	deleted_at: null,
	approved: true,
	by_nickname: "Alice Example",
	by_email: "alice@example.com",
	content: "hello",
	...over,
});

const page = (over: Partial<Record<string, unknown>> = {}) => ({
	id: "p-1",
	slug: "/hello",
	url: null,
	title: null,
	comments: [comment()],
	...over,
});

const project = (over: Partial<Record<string, unknown>> = {}) => ({
	id: "proj-1",
	title: "Site",
	pages: [page()],
	...over,
});

const dump = (projects: Record<string, unknown>[]) =>
	JSON.stringify({ source: "cusdis", version: 1, projects });

// ---------------------------------- 1. parse --------------------------------

describe("parseCusdisDump", () => {
	it("parses the committed fixture", () => {
		const parsed = parseCusdisDump(FIXTURE);
		expect(parsed.projects.map((p) => p.id)).toEqual([BLOG, DOCS]);
		expect(parsed.projects[0]?.pages).toHaveLength(5);
	});

	it("refuses non-JSON", () => {
		expect(() => parseCusdisDump("nope")).toThrow("cusdis dump: not valid JSON");
	});

	it("refuses a non-object top level", () => {
		expect(() => parseCusdisDump("[]")).toThrow("cusdis dump: top level is not an object");
	});

	it("refuses a document whose source is not cusdis", () => {
		expect(() => parseCusdisDump('{"source":"isso","version":1,"projects":[]}')).toThrow(
			'cusdis dump: source is not "cusdis"',
		);
	});

	it("refuses an unknown version", () => {
		expect(() => parseCusdisDump('{"source":"cusdis","version":2,"projects":[]}')).toThrow(
			"cusdis dump: unsupported version",
		);
	});

	it("refuses a missing projects array", () => {
		expect(() => parseCusdisDump('{"source":"cusdis","version":1}')).toThrow(
			"cusdis dump: no projects array",
		);
	});

	it("refuses a page with no comments array, naming the path", () => {
		expect(() => parseCusdisDump(dump([project({ pages: [{ id: "p", slug: "/x" }] })]))).toThrow(
			"cusdis dump: projects[0].pages[0] has no comments array",
		);
	});

	it("refuses a non-boolean approved (the dumper emits a real boolean, never 0/1)", () => {
		const d = dump([project({ pages: [page({ comments: [comment({ approved: 1 })] })] })]);
		expect(() => parseCusdisDump(d)).toThrow(
			"cusdis dump: projects[0].pages[0].comments[0].approved is not a boolean",
		);
	});

	it("refuses a non-integer created_at", () => {
		const d = dump([
			project({ pages: [page({ comments: [comment({ created_at: "2023-11-14" })] })] }),
		]);
		expect(() => parseCusdisDump(d)).toThrow(
			"cusdis dump: projects[0].pages[0].comments[0].created_at is not an epoch-millisecond integer",
		);
	});

	it("carries null updated_at, deleted_at, by_email, url and title", () => {
		const d = dump([
			project({
				pages: [
					page({
						url: null,
						title: null,
						comments: [comment({ updated_at: null, deleted_at: null, by_email: null })],
					}),
				],
			}),
		]);
		const c = parseCusdisDump(d).projects[0]?.pages[0]?.comments[0];
		expect(c).toMatchObject({ updated_at: null, deleted_at: null, by_email: null });
	});

	it("never puts nickname, email or content in a parse error", () => {
		const secret = "SECRET-SENTINEL";
		const bad = [
			comment({ by_nickname: secret, content: secret, by_email: secret, created_at: "x" }),
			comment({ by_nickname: secret, content: secret, by_email: secret, approved: "yes" }),
			comment({ by_nickname: secret, content: secret, by_email: secret, id: 7 }),
		];
		for (const c of bad) {
			let message = "";
			try {
				parseCusdisDump(dump([project({ pages: [page({ comments: [c] })] })]));
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toMatch(/^cusdis dump: /);
			expect(message).not.toContain(secret);
		}
	});
});

// ---------------------------------- 2. slug ---------------------------------

describe("cusdisSlug", () => {
	it("maps a plain path", () => {
		expect(cusdisSlug("/hello-world")).toBe("hello-world");
	});

	it("maps the root path to the cusdis-root sentinel", () => {
		expect(cusdisSlug("/")).toBe("cusdis-root");
		expect(cusdisSlug("")).toBe("cusdis-root");
	});

	it("collapses repeated slashes", () => {
		expect(cusdisSlug("//posts///a/")).toBe("posts/a");
	});

	it("digests a slug the read API would reject, under the cusdis- prefix", () => {
		const s = cusdisSlug("/what is this?");
		expect(s).toMatch(/^cusdis-[0-9a-f]{16}$/);
		expect(SLUG_RE.test(s)).toBe(true);
		expect(cusdisSlug("/what is this?")).toBe(s);
	});

	it("leaves a slug the read API already accepts alone", () => {
		expect(cusdisSlug("/posts/2024/hello_world.html")).toBe("posts/2024/hello_world.html");
	});
});

// --------------------------------- 3. status --------------------------------

describe("cusdisStatus", () => {
	it("deleted_at wins over approved", () => {
		expect(cusdisStatus({ approved: true, deleted_at: 1 })).toBe("deleted");
		expect(cusdisStatus({ approved: false, deleted_at: 1 })).toBe("deleted");
	});

	it("maps approved and unapproved", () => {
		expect(cusdisStatus({ approved: true, deleted_at: null })).toBe("approved");
		expect(cusdisStatus({ approved: false, deleted_at: null })).toBe("pending");
	});

	it("maps the fixture: c5 and c11 pending, c6 and c10 deleted, c1 approved", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const status = (id: string) => out.comments.find((c) => c.source_id === id)?.status;
		expect(status(cid(5))).toBe("pending");
		expect(status(cid(11))).toBe("pending");
		expect(status(cid(6))).toBe("deleted");
		expect(status(cid(10))).toBe("deleted");
		expect(status(cid(1))).toBe("approved");
	});
});

// ---------------------------- 4. project selection --------------------------

describe("project selection", () => {
	it("refuses a two-project file, naming each project by id and title", () => {
		expect(() => CUSDIS_ADAPTER.parse(FIXTURE)).toThrow(
			`cusdis dump: 2 projects in one file — Garrul slugs are single-site, so import one project at a time (pass a project id to select one): ${BLOG} (Example Blog), ${DOCS} (Example Docs)`,
		);
	});

	it("selects one project by id", () => {
		const out = cusdisAdapter({ project: DOCS }).parse(FIXTURE);
		expect(out.threads.map((t) => t.source_id)).toEqual([pid(6)]);
		expect(out.threads[0]?.link).toBe("https://docs.example.com/about");
		expect(out.comments.map((c) => c.source_id)).toEqual([cid(14)]);
	});

	it("refuses an unknown project id and lists what the file has", () => {
		expect(() => cusdisAdapter({ project: "nope" }).parse(FIXTURE)).toThrow(
			`cusdis dump: no project with id "nope" — nothing would be imported. This file has: ${BLOG}, ${DOCS}`,
		);
	});

	it("treats an empty project filter as no filter", () => {
		const one = dump([project()]);
		expect(cusdisAdapter({ project: "" }).parse(one).threads).toHaveLength(1);
		expect(() => cusdisAdapter({ project: "" }).parse(FIXTURE)).toThrow(/2 projects in one file/);
	});

	it("imports a single-project file without a filter", () => {
		expect(CUSDIS_ADAPTER.parse(dump([project()])).threads).toHaveLength(1);
	});

	it("imports nothing from a file with no projects", () => {
		expect(CUSDIS_ADAPTER.parse(dump([]))).toEqual({ threads: [], comments: [] });
	});
});

// --------------------------------- 5. threads -------------------------------

describe("threads", () => {
	it("drops the empty page and keys threads on page id", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		expect(out.threads.map((t) => t.source_id)).toEqual([pid(1), pid(2), pid(3), pid(4)]);
		expect(out.threads.map((t) => t.slug)).toEqual([
			"hello-world",
			"about",
			"deep-thread",
			cusdisSlug("/what is this?"),
		]);
	});

	it("uses the page url as the link and its title as the title", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const hello = out.threads.find((t) => t.source_id === pid(1));
		expect(hello?.link).toBe("https://blog.example.com/hello-world");
		expect(hello?.title).toBe("Hello World");
	});

	it("leaves link and title null on a page with neither, without a site", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const about = out.threads.find((t) => t.source_id === pid(2));
		expect(about?.link).toBeNull();
		expect(about?.title).toBeNull();
	});

	it("resolves a url-less page against the site, and does not override a page that has one", () => {
		const out = cusdisAdapter({ project: BLOG, site: "https://blog.example.com" }).parse(FIXTURE);
		expect(out.threads.find((t) => t.source_id === pid(2))?.link).toBe(
			"https://blog.example.com/about",
		);
		expect(out.threads.find((t) => t.source_id === pid(1))?.link).toBe(
			"https://blog.example.com/hello-world",
		);
		// The odd slug still resolves to a real URL on the site origin.
		expect(out.threads.find((t) => t.source_id === pid(4))?.link).toBe(
			"https://blog.example.com/what%20is%20this?",
		);
	});

	it("nulls the link for an off-origin slug under a site (origin pinning)", () => {
		const d = dump([project({ pages: [page({ slug: "//evil.example/x", url: null })] })]);
		const out = cusdisAdapter({ site: "https://blog.example.com" }).parse(d);
		expect(out.threads[0]?.link).toBeNull();
		expect(out.threads[0]?.slug).toBe("evil.example/x");
		expect(out.comments).toHaveLength(1);
	});

	it("ignores a page url that is not http(s)", () => {
		const d = dump([project({ pages: [page({ url: "javascript:alert(1)" })] })]);
		expect(CUSDIS_ADAPTER.parse(d).threads[0]?.link).toBeNull();
		const rel = dump([project({ pages: [page({ url: "/relative" })] })]);
		expect(CUSDIS_ADAPTER.parse(rel).threads[0]?.link).toBeNull();
	});

	it("dates a thread from its earliest comment", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		expect(out.threads.find((t) => t.source_id === pid(1))?.created_at).toBe(1700000000000);
	});

	it("throws on a non-http(s) site, and the same for an unparseable one", () => {
		const msg = "cusdis import: site must be an http(s) origin (--site / x-import-site)";
		expect(() => cusdisAdapter({ site: "ftp://x" })).toThrow(msg);
		expect(() => cusdisAdapter({ site: "not a url" })).toThrow(msg);
	});
});

// --------------------------------- 6. authors -------------------------------

describe("authors", () => {
	it("is anonymous with no source_id on every comment", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		for (const c of out.comments) {
			expect(c.author.is_anonymous).toBe(true);
			expect(c.author.source_id).toBeUndefined();
		}
	});

	it("names a blank nickname anonymous and keeps a null email null", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const c8 = out.comments.find((c) => c.source_id === cid(8));
		expect(c8?.author).toEqual({ name: "anonymous", email: null, is_anonymous: true });
		const c4 = out.comments.find((c) => c.source_id === cid(4));
		expect(c4?.author).toEqual({ name: "Alice Example", email: null, is_anonymous: true });
	});

	it("keeps the real author and body on a soft-deleted row", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const c6 = out.comments.find((c) => c.source_id === cid(6));
		expect(c6?.status).toBe("deleted");
		expect(c6?.author).toEqual({
			name: "Dave Example",
			email: "dave@example.net",
			is_anonymous: true,
		});
		expect(c6?.body_md.length).toBeGreaterThan(0);
	});

	it("never sets edited_at — updated_at is a moderation bump, not an edit", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const c9 = out.comments.find((c) => c.source_id === cid(9));
		expect(c9?.edited_at).toBeNull();
		expect(out.comments.every((c) => c.edited_at === null)).toBe(true);
	});

	it("passes content through verbatim as body_md", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		const c1 = out.comments.find((c) => c.source_id === cid(1));
		expect(c1?.body_md).toContain("> quoted text");
		expect(c1?.body_md).toContain("`inline code`");
	});
});

// -------------------------------- 7. threading ------------------------------

describe("threading", () => {
	it("keeps a same-page parent", () => {
		const out = BLOG_ADAPTER.parse(FIXTURE);
		expect(out.comments.find((c) => c.source_id === cid(3))?.parent_source_id).toBe(cid(1));
	});

	it("passes a cross-page parent through; the core re-roots it", () => {
		const d = dump([
			project({
				pages: [
					page({ id: "p-1", slug: "/a", comments: [comment({ id: "a-1" })] }),
					page({
						id: "p-2",
						slug: "/b",
						comments: [comment({ id: "b-1", parent_id: "a-1" })],
					}),
				],
			}),
		]);
		const out = CUSDIS_ADAPTER.parse(d);
		// Adapters do not second-guess threading: `thread_source_id` is the
		// page id, and the core drops a parent link that crosses threads (see
		// tests/import-core.test.ts, "parent guards").
		expect(out.comments.find((c) => c.source_id === "b-1")?.parent_source_id).toBe("a-1");
	});

	it("passes a parent that exists nowhere through; the core re-roots it", () => {
		const d = dump([project({ pages: [page({ comments: [comment({ parent_id: "ghost" })] })] })]);
		expect(CUSDIS_ADAPTER.parse(d).comments[0]?.parent_source_id).toBe("ghost");
	});

	it("flattens the ten-deep chain to MAX_REPLY_DEPTH", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		const commentInserts = inserts(captured, "comments");
		const idOf = (importId: string) =>
			commentInserts.find((c) => c.binds[10] === importId)?.binds[0];
		const commentUpdates = updates(captured, "comments");
		// UPDATE binds: parent_id, depth, id
		for (const u of commentUpdates) {
			expect(u.binds[1] as number).toBeLessThanOrEqual(MAX_REPLY_DEPTH);
		}
		const d10 = commentUpdates.find((u) => u.binds[2] === idOf(did(10)));
		expect(d10?.binds[1]).toBe(MAX_REPLY_DEPTH);
		const d2 = commentUpdates.find((u) => u.binds[2] === idOf(did(2)));
		expect(d2?.binds[0]).toBe(idOf(did(1)));
		expect(d2?.binds[1]).toBe(2);
	});

	it("inserts the deleted parent under include_deleted and hangs c7 on it", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG, include_deleted: true });
		const commentInserts = inserts(captured, "comments");
		// INSERT binds: id, post_slug, user_id, body_md, body_html,
		// renderer_version, status, created_at, edited_at, import_source, import_id
		const c6 = commentInserts.find((c) => c.binds[10] === cid(6));
		expect(c6?.binds[6]).toBe("deleted");
		expect(c6?.binds[9]).toBe("cusdis");
		const c7 = commentInserts.find((c) => c.binds[10] === cid(7));
		const c7Update = updates(captured, "comments").find((u) => u.binds[2] === c7?.binds[0]);
		expect(c7Update?.binds[0]).toBe(c6?.binds[0]);
		expect(c7Update?.binds[1]).toBe(2);
	});

	it("leaves the deleted parent's replies as roots without include_deleted", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		const commentInserts = inserts(captured, "comments");
		expect(commentInserts.some((c) => c.binds[10] === cid(6))).toBe(false);
		const c7 = commentInserts.find((c) => c.binds[10] === cid(7));
		expect(c7).toBeDefined();
		expect(updates(captured, "comments").some((u) => u.binds[2] === c7?.binds[0])).toBe(false);
	});
});

// ------------------------------ 8. runCusdisImport --------------------------

describe("runCusdisImport", () => {
	it("reports the fixture's counts on a fresh-db dry run", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runCusdisImport(db, FIXTURE, "secret", { project: BLOG, dry_run: true });
		expect(plan.pages_total).toBe(4);
		expect(plan.comments_total).toBe(23);
		expect(plan.skipped_deleted).toBe(2);
		expect(plan.skipped_spam).toBe(0);
		expect(plan.merged_pages).toBe(0);
		expect(inserts(captured, "comments")).toHaveLength(0);
	});

	it("inserts pending comments as pending, so they are not publicly visible", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		const c5 = inserts(captured, "comments").find((c) => c.binds[10] === cid(5));
		expect(c5?.binds[6]).toBe("pending");
	});

	it("binds edited_at NULL on every comment", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		for (const c of inserts(captured, "comments")) expect(c.binds[8]).toBeNull();
	});

	it("shares one ghost between c1 and c3 (same name+email), a second for c4 (no email)", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		const commentInserts = inserts(captured, "comments");
		const userOf = (importId: string) =>
			commentInserts.find((c) => c.binds[10] === importId)?.binds[2];
		expect(userOf(cid(1))).toBeDefined();
		expect(userOf(cid(1))).toBe(userOf(cid(3)));
		expect(userOf(cid(4))).not.toBe(userOf(cid(1)));
	});

	it("writes the post link from the page url", async () => {
		const { db, captured } = makeFreshDb();
		await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		const hello = inserts(captured, "posts").find((p) => p.binds[0] === "hello-world");
		expect(hello?.binds[2]).toBe("https://blog.example.com/hello-world");
		const about = inserts(captured, "posts").find((p) => p.binds[0] === "about");
		expect(about?.binds[2]).toBeNull();
	});

	it("inserts nothing on a re-run of the same dump", async () => {
		const { db, captured } = makeAlreadyImportedDb();
		const plan = await runCusdisImport(db, FIXTURE, "secret", { project: BLOG });
		expect(plan.new_comments).toBe(0);
		expect(inserts(captured, "comments")).toHaveLength(0);
	});

	it("treats include_spam as a no-op — Cusdis has no spam state", async () => {
		const { db } = makeFreshDb();
		const a = await runCusdisImport(db, FIXTURE, "secret", { project: BLOG, dry_run: true });
		const b = await runCusdisImport(db, FIXTURE, "secret", {
			project: BLOG,
			dry_run: true,
			include_spam: true,
		});
		expect(b).toEqual(a);
	});

	it("tags with source cusdis and its own slug fallback prefix", () => {
		expect(CUSDIS_ADAPTER.source).toBe("cusdis");
		expect(CUSDIS_ADAPTER.slugFallbackPrefix).toBe("cusdis-");
	});
});
