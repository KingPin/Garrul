/**
 * Comentario / Commento importer tests cover:
 *
 *   1. Version dispatch — v1 and v3 share no field names, so a file is
 *      routed on its declared `version` and any other value is refused
 *      rather than parsed into a document full of empty strings.
 *   2. The v1 deletion trap — a Commento export never selects `deleted`,
 *      so the flag is always false and the rewritten `[deleted]` body is
 *      the only surviving signal. All three of the flag, an empty body
 *      and the sentinel mean deleted.
 *   3. Page reconstruction — v3 has real page records, v1 has none and
 *      groups on host+path, where the path lives under `path` or `url`
 *      depending on which product wrote the file.
 *   4. Identity — a registered author keys on the source id, an
 *      anonymous one deliberately does not: v1 gives every anonymous
 *      commenter one sentinel hex forum-wide, and v3 keeps the
 *      unregistered author's real name on the comment as `authorName`.
 *   5. Go's zero time — both formats emit `0001-01-01T00:00:00Z` for an
 *      unset timestamp, which parses cleanly, so it has to be rejected
 *      by value or every comment imports as edited in the year 1.
 *   6. Single-site safety — an export carrying two domains is refused
 *      rather than flattened, because two sites' `/about` would collide
 *      onto one Garrul slug in silence.
 *
 * Fixtures are hand-written and identity-free. The shapes were measured
 * against a real Comentario v3 export and against upstream's own v1
 * documentation and importer source; the bytes here are ours.
 *
 * No Miniflare. Hand-rolled D1 stub with capture, same as the Disqus and
 * Remark42 suites.
 */
import { describe, expect, it } from "vitest";
import {
	COMENTARIO_ADAPTER,
	comentarioAdapter,
	parseComentarioExport,
	runComentarioImport,
} from "../src/lib/import/comentario";
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
			if (sql.includes("FROM posts WHERE slug")) return { slug: "hello" };
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

const GO_ZERO = "0001-01-01T00:00:00.000Z";
const V1_ANON_HEX = "0".repeat(64);
const V3_ANON_ID = "00000000-0000-0000-0000-000000000000";

// ------------------------------- v1 builders -------------------------------

const v1Comment = (over: Record<string, unknown> = {}) => ({
	commentHex: "aa11",
	commenterHex: "bb22",
	creationDate: "2026-08-28T23:19:42.144Z",
	deleted: false,
	direction: 0,
	host: "example.com",
	html: "",
	markdown: "hello",
	parentHex: "root",
	path: "/hello",
	url: "",
	score: 0,
	state: "approved",
	...over,
});

const v1Commenter = (over: Record<string, unknown> = {}) => ({
	commenterHex: "bb22",
	email: "ada@example.com",
	isModerator: false,
	joinDate: "2026-08-01T00:00:00.000Z",
	name: "Ada",
	...over,
});

const v1 = (
	comments: Record<string, unknown>[],
	commenters: Record<string, unknown>[] = [v1Commenter()],
) => JSON.stringify({ version: 1, comments, commenters });

// ------------------------------- v3 builders -------------------------------

const v3Page = (over: Record<string, unknown> = {}) => ({
	countComments: 1,
	countViews: 2,
	createdTime: "2026-08-23T02:50:54.041Z",
	domainId: "d0000000-0000-4000-8000-000000000001",
	id: "p0000000-0000-4000-8000-000000000001",
	isReadonly: false,
	path: "/hello",
	title: "Hello World",
	...over,
});

const v3Comment = (over: Record<string, unknown> = {}) => ({
	createdTime: "2026-08-28T23:19:42.144Z",
	deletedTime: GO_ZERO,
	editedTime: GO_ZERO,
	moderatedTime: GO_ZERO,
	html: "<p>hello</p>",
	id: "c0000000-0000-4000-8000-000000000001",
	isApproved: true,
	isDeleted: false,
	isPending: false,
	isSticky: false,
	markdown: "hello",
	pageId: "p0000000-0000-4000-8000-000000000001",
	score: 0,
	url: "https://example.com/hello#comentario-c0000000-0000-4000-8000-000000000001",
	userCreated: "u0000000-0000-4000-8000-000000000001",
	...over,
});

const v3Commenter = (over: Record<string, unknown> = {}) => ({
	colourIndex: 1,
	createdTime: "2026-08-01T00:00:00.000Z",
	email: "ada@example.com",
	hasAvatar: false,
	id: "u0000000-0000-4000-8000-000000000001",
	isCommenter: true,
	isModerator: false,
	name: "Ada",
	...over,
});

const v3 = (
	comments: Record<string, unknown>[],
	pages: Record<string, unknown>[] = [v3Page()],
	commenters: Record<string, unknown>[] = [v3Commenter()],
) => JSON.stringify({ version: 3, pages, comments, commenters });

// -------------------------- parseComentarioExport --------------------------

describe("parseComentarioExport", () => {
	it("dispatches on the declared version", () => {
		expect(parseComentarioExport(v1([v1Comment()])).version).toBe(1);
		expect(parseComentarioExport(v3([v3Comment()])).version).toBe(3);
	});

	// v2 was the fork's transitional line and never had its own export format,
	// so anything but 1 or 3 is refused rather than guessed at.
	it("refuses a version it has not been read against", () => {
		expect(() => parseComentarioExport(JSON.stringify({ version: 481 }))).toThrow(
			/version 481 is not a format/,
		);
		expect(() => parseComentarioExport(JSON.stringify({ version: 2 }))).toThrow(
			/expected 1 or 3/,
		);
	});

	it("refuses a file with no version at all", () => {
		expect(() => parseComentarioExport(JSON.stringify({ comments: [] }))).toThrow(
			/is not a format/,
		);
	});

	it("refuses input that is not a JSON object", () => {
		expect(() => parseComentarioExport("not json")).toThrow(/not valid JSON/);
		expect(() => parseComentarioExport("[]")).toThrow(/not a JSON object/);
	});

	// Upstream's own empty-export fixture is literally `{"version":1}` — the
	// arrays are omitted, not empty.
	it("treats missing arrays as an empty export", () => {
		const p1 = parseComentarioExport(JSON.stringify({ version: 1 }));
		expect(p1.version === 1 && p1.comments).toEqual([]);
		const p3 = parseComentarioExport(JSON.stringify({ version: 3 }));
		expect(p3.version === 3 && p3.pages).toEqual([]);
	});

	it("rejects a v1 comment with no commentHex", () => {
		expect(() =>
			parseComentarioExport(v1([v1Comment({ commentHex: "" })])),
		).toThrow(/comments\[0\] has no commentHex/);
	});

	it("rejects a v1 comment with neither path nor url", () => {
		expect(() =>
			parseComentarioExport(v1([v1Comment({ path: "", url: "" })])),
		).toThrow(/comments\[0\] has neither path nor url/);
	});

	it("rejects a v3 comment with no pageId", () => {
		expect(() =>
			parseComentarioExport(v3([v3Comment({ pageId: "" })])),
		).toThrow(/comments\[0\] has no pageId/);
	});

	// A malformed export is exactly the case where the content is unclassified
	// and may carry an authorIP or a private body, so an error names the record
	// position and never the record.
	it("never puts record content in a parse error", () => {
		const secret = "topsecret-body-that-must-not-leak";
		let msg = "";
		try {
			parseComentarioExport(`{"version":1,"comments":[{"markdown":"${secret}"}]}`);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toMatch(/comments\[0\]/);
		expect(msg).not.toContain(secret);
	});

	it("does not echo the input when the JSON itself is malformed", () => {
		const secret = "another-secret-body";
		let msg = "";
		try {
			parseComentarioExport(`{"version":1,"comments":["${secret}"`);
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toBe("comentario export: not valid JSON");
		expect(msg).not.toContain(secret);
	});
});

// ------------------------------ v1 normalising -----------------------------

describe("COMENTARIO_ADAPTER — Commento v1", () => {
	it("reconstructs a page from host and path, since v1 has no page records", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([
				v1Comment({ commentHex: "a", creationDate: "2026-08-28T10:00:00.000Z" }),
				v1Comment({ commentHex: "b", creationDate: "2026-08-28T09:00:00.000Z" }),
			]),
		);
		expect(out.threads).toHaveLength(1);
		expect(out.threads[0]!.source_id).toBe("/hello");
		expect(out.threads[0]!.link).toBe("https://example.com/hello");
		// Commento exports no page titles at all.
		expect(out.threads[0]!.title).toBeNull();
		// The earliest comment on the page dates it — there is nothing better.
		expect(new Date(out.threads[0]!.created_at).toISOString()).toBe(
			"2026-08-28T09:00:00.000Z",
		);
	});

	// Upstream: "Commento filed the path under `url`, whereas Comentario used
	// `path`". Getting this wrong slugs every thread wrong, silently.
	it("falls back to url when path is empty, and forces one leading slash", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([v1Comment({ path: "", url: "posts/one" })]),
		);
		expect(out.threads[0]!.source_id).toBe("/posts/one");
		expect(out.comments[0]!.thread_source_id).toBe("/posts/one");
	});

	it("collapses repeated leading slashes rather than making a second page", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([
				v1Comment({ commentHex: "a", path: "/hello" }),
				v1Comment({ commentHex: "b", path: "///hello" }),
			]),
		);
		expect(out.threads).toHaveLength(1);
	});

	// "root" is a word here, not an empty string — the mistake costs the whole
	// thread shape, because every root comment would claim a parent named root.
	it("maps the literal root sentinel to a null parent", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([
				v1Comment({ commentHex: "a", parentHex: "root" }),
				v1Comment({ commentHex: "b", parentHex: "a" }),
			]),
		);
		expect(out.comments[0]!.parent_source_id).toBeNull();
		expect(out.comments[1]!.parent_source_id).toBe("a");
	});

	it("maps Commento's state vocabulary onto Garrul's", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([
				v1Comment({ commentHex: "a", state: "approved" }),
				v1Comment({ commentHex: "b", state: "unapproved" }),
				v1Comment({ commentHex: "c", state: "flagged" }),
			]),
		);
		expect(out.comments.map((c) => c.status)).toEqual([
			"approved",
			"pending",
			"spam",
		]);
	});

	// The trap: a Commento export's SQL never selects `deleted`, so the flag is
	// always false even for comments that really were deleted. The rewritten
	// body is the only signal left, and upstream treats all three as deletion.
	it("treats the flag, an empty body and the [deleted] sentinel as deleted", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([
				v1Comment({ commentHex: "a", deleted: true }),
				v1Comment({ commentHex: "b", markdown: "" }),
				v1Comment({ commentHex: "c", markdown: "[deleted]" }),
				v1Comment({ commentHex: "d", markdown: "still here" }),
			]),
		);
		expect(out.comments.map((c) => c.status)).toEqual([
			"deleted",
			"deleted",
			"deleted",
			"approved",
		]);
	});

	it("keys a registered author on the source hex", () => {
		const out = COMENTARIO_ADAPTER.parse(v1([v1Comment()]));
		expect(out.comments[0]!.author.source_id).toBe("bb22");
		expect(out.comments[0]!.author.is_anonymous).toBe(false);
		expect(out.comments[0]!.author.name).toBe("Ada");
		expect(out.comments[0]!.author.email).toBe("ada@example.com");
	});

	// Both spellings collapse every anonymous commenter in the forum onto one
	// sentinel, so keying on it would merge them into a single ghost. The core's
	// name+email seed keeps them apart instead.
	it.each([V1_ANON_HEX, "anonymous"])(
		"does not key an anonymous author on the %s sentinel",
		(hex) => {
			const out = COMENTARIO_ADAPTER.parse(
				v1([v1Comment({ commenterHex: hex })], []),
			);
			expect(out.comments[0]!.author.source_id).toBeUndefined();
			expect(out.comments[0]!.author.is_anonymous).toBe(true);
			expect(out.comments[0]!.author.name).toBe("anonymous");
		},
	);

	// A third spelling of "nobody", and the one a malformed export produces.
	// `commenters[]` rejects an empty hex, so it can never name an author;
	// reading it as registered emitted a commenter called "anonymous" that
	// claimed not to be one.
	it("reads a missing commenterHex as anonymous, not as a registered author", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([v1Comment({ commenterHex: "" })], []),
		);
		expect(out.comments[0]!.author.is_anonymous).toBe(true);
		expect(out.comments[0]!.author.source_id).toBeUndefined();
		expect(out.comments[0]!.author.name).toBe("anonymous");
	});

	it("passes markdown through and never reads the html field", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v1([v1Comment({ markdown: "**bold**", html: "<p>WRONG</p>" })]),
		);
		expect(out.comments[0]!.body_md).toBe("**bold**");
	});

	it("has no edit timestamp to carry", () => {
		const out = COMENTARIO_ADAPTER.parse(v1([v1Comment()]));
		expect(out.comments[0]!.edited_at).toBeNull();
	});

	// Garrul slugs are single-site. Flattening two hosts would silently merge
	// two different sites' pages that happen to share a path.
	it("refuses an export carrying more than one host, and names them", () => {
		// The refusal points at --domain=, which is only actionable if the
		// operator is told what to pass.
		expect(() =>
			COMENTARIO_ADAPTER.parse(
				v1([
					v1Comment({ commentHex: "a", host: "one.example" }),
					v1Comment({ commentHex: "b", host: "two.example" }),
				]),
			),
		).toThrow(/2 distinct hosts in one file.*one\.example, two\.example/);
	});

	it("narrows a multi-host export when a domain is supplied", () => {
		const out = comentarioAdapter({ domain: "one.example" }).parse(
			v1([
				v1Comment({ commentHex: "a", host: "one.example" }),
				v1Comment({ commentHex: "b", host: "two.example" }),
			]),
		);
		expect(out.comments).toHaveLength(1);
		expect(out.comments[0]!.source_id).toBe("a");
	});
});

// ------------------------------ v3 normalising -----------------------------

describe("COMENTARIO_ADAPTER — Comentario v3", () => {
	it("takes pages from the page records", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment()]));
		expect(out.threads).toHaveLength(1);
		expect(out.threads[0]!.title).toBe("Hello World");
		expect(out.threads[0]!.closed).toBe(false);
		expect(new Date(out.threads[0]!.created_at).toISOString()).toBe(
			"2026-08-23T02:50:54.041Z",
		);
	});

	it("carries the read-only flag onto the page", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([v3Comment()], [v3Page({ isReadonly: true })]),
		);
		expect(out.threads[0]!.closed).toBe(true);
	});

	it("leaves an absent page title null rather than inventing one", () => {
		const page = v3Page();
		delete (page as Record<string, unknown>).title;
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment()], [page]));
		expect(out.threads[0]!.title).toBeNull();
	});

	// A v3 export has no domain record at all: pages carry a `domainId` UUID
	// and the only place a real host ever appears is the comment permalink.
	it("recovers the page link from a comment permalink, minus the fragment", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment()]));
		expect(out.threads[0]!.link).toBe("https://example.com/hello");
	});

	it("leaves the link null when no comment carries a parseable url", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment({ url: "" })]));
		expect(out.threads[0]!.link).toBeNull();
	});

	// A v3 export lists every page the widget was ever mounted on. Importing the
	// empty ones creates `posts` rows Garrul would have created on demand and
	// inflates pages_total past anything the operator can see.
	it("does not emit a page that carries no comments", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3(
				[v3Comment()],
				[
					v3Page(),
					v3Page({
						id: "p0000000-0000-4000-8000-000000000002",
						path: "/empty",
						countComments: 0,
					}),
				],
			),
		);
		expect(out.threads).toHaveLength(1);
		expect(out.threads[0]!.source_id).toBe("p0000000-0000-4000-8000-000000000001");
	});

	it("treats an absent parentId as root", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment()]));
		expect(out.comments[0]!.parent_source_id).toBeNull();
	});

	it("carries a parentId when the comment is a reply", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([
				v3Comment(),
				v3Comment({
					id: "c0000000-0000-4000-8000-000000000002",
					parentId: "c0000000-0000-4000-8000-000000000001",
				}),
			]),
		);
		expect(out.comments[1]!.parent_source_id).toBe(
			"c0000000-0000-4000-8000-000000000001",
		);
	});

	it("maps the three moderation booleans onto Garrul's statuses", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([
				v3Comment({ id: "c1", isApproved: true }),
				v3Comment({ id: "c2", isApproved: false, isPending: true }),
				v3Comment({ id: "c3", isDeleted: true }),
				// Neither approved nor pending is a comment a moderator rejected.
				v3Comment({ id: "c4", isApproved: false, isPending: false }),
			]),
		);
		expect(out.comments.map((c) => c.status)).toEqual([
			"approved",
			"pending",
			"deleted",
			"spam",
		]);
	});

	// Go's zero time parses cleanly, so it has to be rejected by value. Left
	// alone it marks every imported comment as edited in the year 1.
	it("reads Go's zero time as unset, not as an edit", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment({ editedTime: GO_ZERO })]));
		expect(out.comments[0]!.edited_at).toBeNull();
	});

	it("keeps a real edit timestamp", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([v3Comment({ editedTime: "2026-08-29T01:02:03.000Z" })]),
		);
		expect(new Date(out.comments[0]!.edited_at!).toISOString()).toBe(
			"2026-08-29T01:02:03.000Z",
		);
	});

	it("keys a registered author on the commenter uuid", () => {
		const out = COMENTARIO_ADAPTER.parse(v3([v3Comment()]));
		expect(out.comments[0]!.author.source_id).toBe(
			"u0000000-0000-4000-8000-000000000001",
		);
		expect(out.comments[0]!.author.is_anonymous).toBe(false);
	});

	// The unregistered author's real name is on the comment, not in
	// commenters[]. Keying on the zero-uuid sentinel would throw it away and
	// merge every unregistered author onto one ghost.
	it("takes an unregistered author's name from the comment, and does not key on the sentinel", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([v3Comment({ userCreated: V3_ANON_ID, authorName: "Grace" })]),
		);
		expect(out.comments[0]!.author.name).toBe("Grace");
		expect(out.comments[0]!.author.source_id).toBeUndefined();
		expect(out.comments[0]!.author.is_anonymous).toBe(true);
		expect(out.comments[0]!.author.email).toBeNull();
	});

	it("keeps two differently-named unregistered authors apart", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([
				v3Comment({ id: "c1", userCreated: V3_ANON_ID, authorName: "Grace" }),
				v3Comment({ id: "c2", userCreated: V3_ANON_ID, authorName: "Alan" }),
			]),
		);
		expect(out.comments.map((c) => c.author.name)).toEqual(["Grace", "Alan"]);
	});

	it("passes markdown through and never reads the html field", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([v3Comment({ markdown: "_it_", html: "<p>WRONG</p>" })]),
		);
		expect(out.comments[0]!.body_md).toBe("_it_");
	});

	it("drops a comment whose page is not in the export", () => {
		const out = COMENTARIO_ADAPTER.parse(
			v3([v3Comment({ pageId: "p0000000-0000-4000-8000-000000000009" })]),
		);
		expect(out.comments).toHaveLength(0);
		expect(out.threads).toHaveLength(0);
	});

	it("refuses an export carrying more than one domain", () => {
		expect(() =>
			COMENTARIO_ADAPTER.parse(
				v3(
					[v3Comment()],
					[
						v3Page(),
						v3Page({
							id: "p0000000-0000-4000-8000-000000000002",
							domainId: "d0000000-0000-4000-8000-000000000002",
						}),
					],
				),
			),
		).toThrow(
			/2 distinct domains in one file.*d0000000-0000-4000-8000-000000000001, d0000000-0000-4000-8000-000000000002/,
		);
	});

	// A v3 domainId appears nowhere but inside the file, so without this the
	// operator has no way to discover the value the message tells them to
	// pass. The list is capped so a pathological file is not a dump.
	it("caps the list of identifiers it names", () => {
		const pages = Array.from({ length: 30 }, (_, i) =>
			v3Page({
				id: `p0000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
				domainId: `d0000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
			}),
		);
		let msg = "";
		try {
			COMENTARIO_ADAPTER.parse(v3([v3Comment()], pages));
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain("30 distinct domains");
		// The list is the tail after the last colon; the prose before it has
		// commas of its own.
		const listed = msg.slice(msg.lastIndexOf(": ") + 2).split(", ");
		expect(listed).toHaveLength(11); // 10 identifiers plus the ellipsis
		expect(listed.at(-1)).toBe("…");
	});

	it("narrows a multi-domain export when a domainId is supplied", () => {
		const out = comentarioAdapter({
			domain: "d0000000-0000-4000-8000-000000000001",
		}).parse(
			v3(
				[v3Comment()],
				[
					v3Page(),
					v3Page({
						id: "p0000000-0000-4000-8000-000000000002",
						domainId: "d0000000-0000-4000-8000-000000000002",
					}),
				],
			),
		);
		expect(out.threads).toHaveLength(1);
	});
});

// ------------------------------ adapter identity ---------------------------

describe("COMENTARIO_ADAPTER identity", () => {
	// The tag is half of the (import_source, import_id) idempotency key, so it
	// can never be re-cut once this has shipped — including across the two
	// versions, which are one product lineage and one migration story.
	it("tags both versions with one source", () => {
		expect(COMENTARIO_ADAPTER.source).toBe("comentario");
		expect(comentarioAdapter({ domain: "x" }).source).toBe("comentario");
	});

	it("has its own slug fallback prefix", () => {
		expect(COMENTARIO_ADAPTER.slugFallbackPrefix).toBe("comentario-");
	});
});

// ------------------------------- runImport ---------------------------------

describe("runComentarioImport", () => {
	it("imports a v3 export end to end", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runComentarioImport(db, v3([v3Comment()]), "secret");
		expect(plan.pages_total).toBe(1);
		expect(plan.comments_total).toBe(1);
		expect(plan.new_comments).toBe(1);
		expect(inserts(captured, "comments")).toHaveLength(1);
	});

	it("imports a v1 export end to end", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runComentarioImport(db, v1([v1Comment()]), "secret");
		expect(plan.pages_total).toBe(1);
		expect(plan.new_comments).toBe(1);
		expect(inserts(captured, "comments")).toHaveLength(1);
	});

	// Idempotency is the core's, via the partial unique index on
	// (import_source, import_id). Pinned here because the source tag is this
	// adapter's contribution to that key.
	it("inserts nothing on a re-run of the same export", async () => {
		const { db, captured } = makeAlreadyImportedDb();
		const plan = await runComentarioImport(db, v3([v3Comment()]), "secret");
		expect(plan.new_comments).toBe(0);
		expect(inserts(captured, "comments")).toHaveLength(0);
	});

	it("two commenters sharing a display name stay two ghosts", async () => {
		const { db } = makeFreshDb();
		const plan = await runComentarioImport(
			db,
			v3(
				[
					v3Comment({ id: "c1", userCreated: "u0000000-0000-4000-8000-00000000000a" }),
					v3Comment({ id: "c2", userCreated: "u0000000-0000-4000-8000-00000000000b" }),
				],
				[v3Page()],
				[
					v3Commenter({ id: "u0000000-0000-4000-8000-00000000000a", name: "Sam", email: "" }),
					v3Commenter({ id: "u0000000-0000-4000-8000-00000000000b", name: "Sam", email: "" }),
				],
			),
			"secret",
		);
		expect(plan.new_users).toBe(2);
	});

	it("one commenter under two names stays one ghost", async () => {
		const { db } = makeFreshDb();
		const plan = await runComentarioImport(
			db,
			v3(
				[
					v3Comment({ id: "c1" }),
					v3Comment({ id: "c2" }),
				],
				[v3Page()],
				[v3Commenter()],
			),
			"secret",
		);
		expect(plan.new_users).toBe(1);
	});

	// `pending` is never gated: a comment awaiting moderation is work the
	// operator has not done, not junk. Deleted and spam are.
	it("keeps pending comments and drops deleted and rejected ones by default", async () => {
		const { db } = makeFreshDb();
		const plan = await runComentarioImport(
			db,
			v3([
				v3Comment({ id: "c1" }),
				v3Comment({ id: "c2", isApproved: false, isPending: true }),
				v3Comment({ id: "c3", isDeleted: true }),
				v3Comment({ id: "c4", isApproved: false, isPending: false }),
			]),
			"secret",
		);
		expect(plan.skipped_deleted).toBe(1);
		expect(plan.skipped_spam).toBe(1);
		expect(plan.new_comments).toBe(2);
	});

	it("passes the domain filter through to the adapter", async () => {
		const { db } = makeFreshDb();
		const plan = await runComentarioImport(
			db,
			v3(
				[v3Comment()],
				[
					v3Page(),
					v3Page({
						id: "p0000000-0000-4000-8000-000000000002",
						domainId: "d0000000-0000-4000-8000-000000000002",
					}),
				],
			),
			"secret",
			{ domain: "d0000000-0000-4000-8000-000000000001" },
		);
		expect(plan.pages_total).toBe(1);
	});
});
