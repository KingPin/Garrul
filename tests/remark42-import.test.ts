/**
 * Remark42 importer tests cover:
 *
 *   1. Framed JSONL parsing — the metadata header is consumed, not
 *      imported; blank lines are skipped; an unknown version fails.
 *   2. The body trap — `orig` wins when present, `text` through
 *      htmlToMarkdown when it is absent. A comment Remark42 itself
 *      imported has no `orig` at all, and taking `orig` blindly would
 *      give it an empty body.
 *   3. Identity — `user.id` keys the ghost, so two commenters sharing a
 *      display name become two users and one commenter across two
 *      names stays one.
 *   4. Page reconstruction — there are no page records, so threads come
 *      from distinct `locator.url` with the earliest comment's time.
 *   5. Error hygiene — a malformed line names its number and never its
 *      content, because an unparsed line may carry an `ip` field.
 *
 * Fixtures are hand-written and identity-free. The shapes come from a
 * real capture (an export whose header carried EMPTY users/posts arrays,
 * whose comments all had `pid: ""`, and whose `text` had been through
 * smartypants); the bytes do not.
 *
 * No Miniflare. Hand-rolled D1 stub with capture, same as the Disqus
 * suite.
 */
import { describe, expect, it } from "vitest";
import {
	REMARK42_ADAPTER,
	parseRemark42Export,
	runRemark42Import,
} from "../src/lib/import/remark42";
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
	return {
		db: asD1({ prepare: (sql: string) => chain(sql) }),
		captured,
	};
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
	return {
		db: asD1({ prepare: (sql: string) => chain(sql) }),
		captured,
	};
};

const META = `{"version":1,"users":[],"posts":[]}`;

const comment = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		id: "c1",
		pid: "",
		text: "<p>hello</p>\n",
		orig: "hello",
		user: {
			id: "anonymous_1111111111111111111111111111111111111111",
			name: "Ada",
			picture: "https://example.com/avatar.image",
			ip: "0000000000000000000000000000000000000000",
			admin: false,
			site_id: "lab",
		},
		locator: { site: "lab", url: "https://example.com/hello" },
		score: 0,
		vote: 0,
		time: "2026-08-22T22:12:53.539535119-05:00",
		title: "Hello World",
		...over,
	});

const jsonl = (...lines: string[]) => `${[META, ...lines].join("\n")}\n`;

const inserts = (captured: Captured[], table: string) =>
	captured.filter((c) => c.sql.startsWith(`INSERT INTO ${table}`));

// --------------------------- parseRemark42Export ---------------------------

describe("parseRemark42Export", () => {
	it("consumes the header line as metadata, not as a comment", () => {
		const parsed = parseRemark42Export(jsonl(comment()));
		expect(parsed.meta.version).toBe(1);
		expect(parsed.comments).toHaveLength(1);
		expect(parsed.comments[0]!.id).toBe("c1");
	});

	// The header is identified by shape, so a file whose header was stripped —
	// or one assembled by hand — still parses. A comment always has an id and
	// never a version, so the two can never be confused.
	it("parses a file with no header line at all", () => {
		const parsed = parseRemark42Export(`${comment()}\n`);
		expect(parsed.comments).toHaveLength(1);
		expect(parsed.meta.users).toEqual([]);
	});

	it("skips blank lines, including the trailing newline", () => {
		const parsed = parseRemark42Export(
			`${META}\n\n${comment()}\n\n${comment({ id: "c2" })}\n`,
		);
		expect(parsed.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
	});

	// Remark42's own Native.Import accepts 0 and 1 and rejects the rest. A
	// version we have not read the writer for is far more likely to be
	// mis-parsed than to be compatible.
	it("accepts version 0 and rejects an unseen version", () => {
		expect(() =>
			parseRemark42Export(`{"version":0,"users":[],"posts":[]}\n${comment()}\n`),
		).not.toThrow();
		expect(() =>
			parseRemark42Export(`{"version":9,"users":[],"posts":[]}\n`),
		).toThrow(/version 9/);
	});

	// One export is one site. Two site ids means two files were concatenated,
	// and importing them together merges two comment sections wherever a URL
	// happens to match.
	it("refuses a file carrying two distinct site ids", () => {
		const other = comment({
			id: "c2",
			locator: { site: "other", url: "https://example.com/hello" },
		});
		expect(() => parseRemark42Export(jsonl(comment(), other))).toThrow(
			/site ids/,
		);
	});

	it("treats an absent site the same as one distinct site", () => {
		const noSite = comment({
			id: "c2",
			locator: { url: "https://example.com/hello" },
		});
		const bare = comment({
			id: "c3",
			locator: { url: "https://example.com/hello" },
		});
		expect(() => parseRemark42Export(jsonl(noSite, bare))).not.toThrow();
	});
});

// ------------------------------ error hygiene ------------------------------

describe("parse errors", () => {
	// A malformed line is exactly the case where the content is unclassified —
	// it may carry `"ip":"…"`, which Garrul never logs. So the message gets the
	// line number and nothing from the line.
	it("names the line number and never the line content", () => {
		const secret = "203.0.113.77";
		const bad = `{"id":"c2","ip":"${secret}",`;
		expect(() => parseRemark42Export(`${META}\n${comment()}\n${bad}\n`)).toThrow(
			/line 3/,
		);
		try {
			parseRemark42Export(`${META}\n${comment()}\n${bad}\n`);
		} catch (e) {
			expect((e as Error).message).not.toContain(secret);
			expect((e as Error).message).not.toContain("c2");
		}
	});

	it("rejects a comment with no locator.url", () => {
		const noUrl = comment({ locator: { site: "lab" } });
		expect(() => parseRemark42Export(jsonl(noUrl))).toThrow(/locator\.url/);
	});

	it("rejects a comment with no id", () => {
		const noId = comment({ id: "" });
		expect(() => parseRemark42Export(jsonl(noId))).toThrow(/comment id/);
	});
});

// -------------------------------- the body ---------------------------------

describe("body", () => {
	// `text` has been through smartypants — straight quotes come back as
	// guillemets and every newline as <br/>. Taking it when `orig` exists
	// imports typography the author never wrote.
	it("prefers orig, the markdown as typed", () => {
		const c = comment({
			orig: 'It\'s the "obvious" answer.',
			text: "<p>It’s the «obvious» answer.</p>\n",
		});
		const [out] = REMARK42_ADAPTER.parse(jsonl(c)).comments;
		expect(out!.body_md).toBe('It\'s the "obvious" answer.');
	});

	// THE TRAP. All three of Remark42's own migrators set Text and never Orig,
	// and `orig` is omitempty — so every comment that reached Remark42 through
	// a migration has no `orig` key. "Take orig, ignore text" gives all of them
	// an empty body, silently.
	it("falls back to text when orig is absent", () => {
		const c = comment({
			orig: undefined,
			text: "<p>migrated from somewhere <b>else</b></p>",
		});
		const [out] = REMARK42_ADAPTER.parse(jsonl(c)).comments;
		expect(out!.body_md).toContain("migrated from somewhere");
		expect(out!.body_md).not.toContain("<p>");
	});

	// A present-but-empty orig is the deleted case: SetDeleted blanks Orig and
	// Text both. It must not be read as "the author typed nothing" and it must
	// not read as a reason to import the rendered HTML either.
	it("treats an empty orig as absent", () => {
		const c = comment({ orig: "", text: "<p>still here</p>" });
		const [out] = REMARK42_ADAPTER.parse(jsonl(c)).comments;
		expect(out!.body_md).toContain("still here");
	});

	it("keeps markdown in orig as markdown", () => {
		const c = comment({
			orig: "- **derivation** — stable per source\n\n> a quote",
			text: "<ul><li><strong>derivation</strong></li></ul>",
		});
		const [out] = REMARK42_ADAPTER.parse(jsonl(c)).comments;
		expect(out!.body_md).toContain("**derivation**");
		expect(out!.body_md).toContain("> a quote");
	});
});

// ------------------------------- identity ----------------------------------

describe("identity", () => {
	it("keys the ghost on user.id, not on the display name", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(
				comment({ id: "c1", user: { id: "anonymous_aaa", name: "Sam" } }),
				comment({ id: "c2", user: { id: "anonymous_bbb", name: "Sam" } }),
			),
		);
		expect(parsed.comments.map((c) => c.author.source_id)).toEqual([
			"anonymous_aaa",
			"anonymous_bbb",
		]);
	});

	// Two people who chose the same display name must not merge. Name-keying
	// cannot tell them apart at any price, which is why source_id is set from
	// day one rather than added later — adding it later re-ghosts everyone.
	it("two commenters sharing a name become two ghost users", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runRemark42Import(
			db,
			jsonl(
				comment({ id: "c1", user: { id: "anonymous_aaa", name: "Sam" } }),
				comment({ id: "c2", user: { id: "anonymous_bbb", name: "Sam" } }),
			),
			"secret",
		);
		expect(plan.new_users).toBe(2);
		expect(inserts(captured, "users")).toHaveLength(2);
	});

	it("one commenter under two names stays one ghost user", async () => {
		const { db } = makeFreshDb();
		const plan = await runRemark42Import(
			db,
			jsonl(
				comment({ id: "c1", user: { id: "anonymous_aaa", name: "Sam" } }),
				comment({ id: "c2", user: { id: "anonymous_aaa", name: "Samantha" } }),
			),
			"secret",
		);
		expect(plan.new_users).toBe(1);
	});

	// The export has no is_anonymous field. Remark42 encodes the provider in
	// the id itself.
	it("reads anonymity from the id's provider prefix", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(
				comment({ id: "c1", user: { id: "anonymous_aaa", name: "A" } }),
				comment({ id: "c2", user: { id: "github_12345", name: "B" } }),
			),
		);
		expect(parsed.comments.map((c) => c.author.is_anonymous)).toEqual([
			true,
			false,
		]);
	});

	// There is no email field anywhere in a Remark42 export, at any level.
	it("always reports a null email", () => {
		const [out] = REMARK42_ADAPTER.parse(jsonl(comment())).comments;
		expect(out!.author.email).toBeNull();
	});
});

// ---------------------------- page reconstruction --------------------------

describe("pages", () => {
	it("builds one page per distinct locator.url", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(
				comment({ id: "c1", locator: { site: "lab", url: "https://example.com/a" } }),
				comment({ id: "c2", locator: { site: "lab", url: "https://example.com/b" } }),
				comment({ id: "c3", locator: { site: "lab", url: "https://example.com/a" } }),
			),
		);
		expect(parsed.threads.map((t) => t.source_id)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	// Remark42 has no page-creation timestamp, so the earliest comment on a
	// page is the closest honest answer.
	it("dates a page from its earliest comment, whatever the file order", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(
				comment({ id: "c1", time: "2026-08-22T22:30:00.000000000-05:00" }),
				comment({ id: "c2", time: "2026-08-22T22:10:00.000000000-05:00" }),
			),
		);
		expect(parsed.threads[0]!.created_at).toBe(
			Date.parse("2026-08-22T22:10:00.000000000-05:00"),
		);
	});

	it("takes the title from the first comment on the page that has one", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(
				comment({ id: "c1", title: undefined }),
				comment({ id: "c2", title: "Hello World" }),
			),
		);
		expect(parsed.threads[0]!.title).toBe("Hello World");
	});

	// The captured export's header had `posts: []`, so the fidelity fields have
	// to degrade to "the source does not say" rather than to false. `closed`
	// absent is not the same as `closed: false` — the core only applies it to
	// pages it creates, and an absent value must leave that default alone.
	it("leaves closed unset when the header lists no posts", () => {
		const parsed = REMARK42_ADAPTER.parse(jsonl(comment()));
		expect("closed" in parsed.threads[0]!).toBe(false);
	});

	it("carries read_only from the header onto the page", () => {
		const meta = `{"version":1,"users":[],"posts":[{"url":"https://example.com/hello","read_only":true}]}`;
		const parsed = REMARK42_ADAPTER.parse(`${meta}\n${comment()}\n`);
		expect(parsed.threads[0]!.closed).toBe(true);
	});

	it("carries a header block onto the ghost user's ban state", () => {
		const meta = `{"version":1,"users":[{"id":"anonymous_1111111111111111111111111111111111111111","blocked":{"status":true}}],"posts":[]}`;
		const parsed = REMARK42_ADAPTER.parse(`${meta}\n${comment()}\n`);
		expect(parsed.comments[0]!.author.is_banned).toBe(true);
	});

	it("leaves is_banned unset when the header lists no users", () => {
		const parsed = REMARK42_ADAPTER.parse(jsonl(comment()));
		expect("is_banned" in parsed.comments[0]!.author).toBe(false);
	});
});

// ------------------------------ comment fields -----------------------------

describe("comment fields", () => {
	// Root is an empty string in this format, never null and never absent.
	it("maps an empty pid to no parent", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(comment({ id: "c1" }), comment({ id: "c2", pid: "c1" })),
		);
		expect(parsed.comments.map((c) => c.parent_source_id)).toEqual([null, "c1"]);
	});

	it("re-parents a reply through the second pass", async () => {
		const { db, captured } = makeFreshDb();
		await runRemark42Import(
			db,
			jsonl(comment({ id: "c2", pid: "c1" }), comment({ id: "c1" })),
			"secret",
		);
		const updates = captured.filter((c) =>
			c.sql.startsWith("UPDATE comments SET parent_id"),
		);
		expect(updates).toHaveLength(1);
	});

	// Remark42 has no moderation queue and no spam verdict, so those two
	// statuses have no source and can never be emitted.
	it("maps delete to deleted and everything else to approved", () => {
		const parsed = REMARK42_ADAPTER.parse(
			jsonl(comment({ id: "c1" }), comment({ id: "c2", delete: true })),
		);
		expect(parsed.comments.map((c) => c.status)).toEqual([
			"approved",
			"deleted",
		]);
	});

	it("skips deleted rows by default and counts them", async () => {
		const { db } = makeFreshDb();
		const plan = await runRemark42Import(
			db,
			jsonl(comment({ id: "c1" }), comment({ id: "c2", delete: true })),
			"secret",
		);
		expect(plan.new_comments).toBe(1);
		expect(plan.skipped_deleted).toBe(1);
	});

	it("carries edit.time onto edited_at", () => {
		const c = comment({ edit: { time: "2026-08-23T09:00:00.000000000-05:00" } });
		const [out] = REMARK42_ADAPTER.parse(jsonl(c)).comments;
		expect(out!.edited_at).toBe(
			Date.parse("2026-08-23T09:00:00.000000000-05:00"),
		);
	});

	// RFC 3339 with nine fractional digits — Go's time.Time default. Date.parse
	// handles it and truncates to milliseconds, which is the resolution
	// comments.created_at has anyway.
	it("parses a nanosecond timestamp with a numeric offset", () => {
		const [out] = REMARK42_ADAPTER.parse(jsonl(comment())).comments;
		expect(out!.created_at).toBe(
			Date.parse("2026-08-22T22:12:53.539535119-05:00"),
		);
	});
});

// ------------------------------- the run -----------------------------------

describe("runRemark42Import", () => {
	it("inserts pages, ghost users and comments on a fresh DB", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runRemark42Import(db, jsonl(comment()), "secret");
		expect(plan.pages_total).toBe(1);
		expect(plan.comments_total).toBe(1);
		expect(plan.new_pages).toBe(1);
		expect(plan.new_users).toBe(1);
		expect(plan.new_comments).toBe(1);

		const [post] = inserts(captured, "posts");
		expect(post!.binds[0]).toBe("hello");
		expect(post!.binds[2]).toBe("https://example.com/hello");

		const [c] = inserts(captured, "comments");
		expect(c!.binds[c!.binds.length - 2]).toBe("remark42");
		expect(c!.binds[c!.binds.length - 1]).toBe("c1");
	});

	it("is idempotent — a re-run inserts zero comments", async () => {
		const { db, captured } = makeAlreadyImportedDb();
		const plan = await runRemark42Import(db, jsonl(comment()), "secret");
		expect(plan.new_comments).toBe(0);
		expect(plan.new_pages).toBe(0);
		expect(inserts(captured, "comments")).toHaveLength(0);
	});

	it("dry run reports counts and issues no writes", async () => {
		const { db, captured } = makeFreshDb();
		const plan = await runRemark42Import(db, jsonl(comment()), "secret", {
			dry_run: true,
		});
		expect(plan.new_comments).toBe(1);
		expect(
			captured.filter((c) => /^(INSERT|UPDATE)/.test(c.sql)),
		).toHaveLength(0);
	});

	// The gzip and plain-JSONL transports carry the same bytes — mode=file and
	// mode=stream of one export are byte-identical, and the core sniffs the
	// magic bytes — so one adapter covers both with no per-transport code.
	it("stores a body sanitized through the markdown allowlist", async () => {
		const c = comment({
			orig: undefined,
			text: "<p>hello <script>alert(1)</script> there</p>",
		});
		const { db, captured } = makeFreshDb();
		await runRemark42Import(db, jsonl(c), "secret");
		const bodyHtml = inserts(captured, "comments")[0]!.binds[4] as string;
		expect(bodyHtml).not.toContain("<script>");
		expect(bodyHtml).not.toContain("</script>");
	});
});
