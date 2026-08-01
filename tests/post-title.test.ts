/**
 * Host-supplied page title handling.
 *
 * `post_title` reaches the Worker on an unauthenticated POST /api/v1/comments
 * and used to be stored verbatim, then fanned out into an Atom <title>, Slack
 * and Discord payloads, and mail SUBJECT lines — where a CR or LF is a header
 * value separator. These cover the sanitizer, the mail-subject template
 * substitution, and the first-writer-wins upsert that stops a later commenter
 * repointing an established thread's title and canonical URL.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	sanitizePostTitle,
	subjectTitle,
	fillSubject,
	MAX_POST_TITLE,
} from "../src/lib/post-title";
import { upsertPost, getPost } from "../src/db/queries";

// Built rather than written literally: a raw control byte in a source file is
// invisible in a diff and easy to mangle in an editor.
const ch = (code: number): string => String.fromCharCode(code);
const CR = ch(0x0d);
const LF = ch(0x0a);
const NUL = ch(0x00);
const DEL = ch(0x7f);
const C1 = ch(0x85); // NEL — a C1 control, not printable

describe("sanitizePostTitle", () => {
	it("returns null for absent input", () => {
		expect(sanitizePostTitle(null)).toBeNull();
		expect(sanitizePostTitle(undefined)).toBeNull();
	});

	it("returns null when nothing usable is left", () => {
		expect(sanitizePostTitle("")).toBeNull();
		expect(sanitizePostTitle("   ")).toBeNull();
		expect(sanitizePostTitle(CR + LF)).toBeNull();
	});

	it("strips the CR/LF that would split a mail header", () => {
		// The attack: a subject of `Post` + CRLF + `Bcc: victim@example.com`.
		const out = sanitizePostTitle(
			`Post${CR}${LF}Bcc: victim@example.com`,
		);
		expect(out).not.toBeNull();
		expect(out).not.toContain(CR);
		expect(out).not.toContain(LF);
		expect(out).toBe("Post Bcc: victim@example.com");
	});

	it("strips NUL, DEL and C1 controls", () => {
		// U+0000-0008, U+000B, U+000E-001F are unescapable in XML 1.0, so any of
		// them in a title makes the Atom feed fatally malformed for every reader.
		expect(sanitizePostTitle(`a${NUL}b`)).toBe("a b");
		expect(sanitizePostTitle(`a${DEL}b`)).toBe("a b");
		expect(sanitizePostTitle(`a${C1}b`)).toBe("a b");
		expect(sanitizePostTitle(`Bob${ch(0x01)}`)).toBe("Bob");
	});

	it("collapses whitespace runs and trims", () => {
		expect(sanitizePostTitle("  a   b\t\tc  ")).toBe("a b c");
	});

	it("truncates at MAX_POST_TITLE", () => {
		const out = sanitizePostTitle("x".repeat(MAX_POST_TITLE + 500));
		expect(out).toHaveLength(MAX_POST_TITLE);
	});

	it("leaves an ordinary title untouched", () => {
		expect(sanitizePostTitle("Hello, World — part 2")).toBe(
			"Hello, World — part 2",
		);
	});

	it("keeps HTML metacharacters, which are the consumers' job to escape", () => {
		// Deliberate: the queue and the feed escape at render. Stripping here
		// would silently mangle legitimate titles like `a <b> c`.
		expect(sanitizePostTitle("<script>x</script>")).toBe("<script>x</script>");
	});
});

describe("subjectTitle", () => {
	it("falls back to the slug when the stored title is unusable", () => {
		expect(subjectTitle(null, "my-post")).toBe("my-post");
		expect(subjectTitle("   ", "my-post")).toBe("my-post");
		expect(subjectTitle(CR + LF, "my-post")).toBe("my-post");
	});

	it("sanitizes a title already in the database", () => {
		// The second application: rows written before the write-path sanitizer
		// existed are still in there.
		expect(subjectTitle(`Legacy${LF}Bcc: x@y.z`, "slug")).toBe(
			"Legacy Bcc: x@y.z",
		);
	});
});

describe("fillSubject", () => {
	const TEMPLATE = "Confirm your subscription to {title}";

	it("substitutes the title", () => {
		expect(fillSubject(TEMPLATE, "My Post")).toBe(
			"Confirm your subscription to My Post",
		);
	});

	it("does not interpret $& in the title", () => {
		// With a replacement *string*, `$&` expands to the matched text
		// (`{title}`) and `$'` to everything after it — a host-supplied title
		// could splice the template back into its own subject.
		expect(fillSubject(TEMPLATE, "A$&B")).toBe(
			"Confirm your subscription to A$&B",
		);
	});

	it("does not interpret $` or $' in the title", () => {
		expect(fillSubject(TEMPLATE, "x$`y")).toBe(
			"Confirm your subscription to x$`y",
		);
		expect(fillSubject(TEMPLATE, "x$'y")).toBe(
			"Confirm your subscription to x$'y",
		);
	});

	it("does not interpret $1 or $$ in the title", () => {
		expect(fillSubject(TEMPLATE, "$1 $$ done")).toBe(
			"Confirm your subscription to $1 $$ done",
		);
	});
});

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

// Minimal D1Database adapter over node:sqlite — the substring-matching stubs
// used elsewhere never parse SQL, so they cannot exercise ON CONFLICT at all.
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

const freshDb = () => {
	const sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return makeD1(sqlite);
};

describe("upsertPost is first-writer-wins (real SQLite)", () => {
	let db: any;
	beforeEach(() => {
		db = freshDb();
	});

	it("stores title and url on the first write", async () => {
		await upsertPost(db, "hello", "First Title", "https://a.example/hello");
		const post = await getPost(db, "hello");
		expect(post!.title).toBe("First Title");
		expect(post!.url).toBe("https://a.example/hello");
	});

	it("refuses to repoint a stored title or url", async () => {
		// The attack this closes: upsertPost runs on every comment POST, before
		// spam evaluation, so under last-writer-wins anyone able to post — even a
		// comment that lands quarantined — could rewrite an established thread's
		// title and canonical URL for the feed, webhooks and mail subjects.
		await upsertPost(db, "hello", "First Title", "https://a.example/hello");
		await upsertPost(db, "hello", "Attacker Title", "https://evil.example/x");
		const post = await getPost(db, "hello");
		expect(post!.title).toBe("First Title");
		expect(post!.url).toBe("https://a.example/hello");
	});

	it("still fills a column that was never set", async () => {
		// Two of the three callers (page-engagement, admin) pass nulls, so a slug
		// can exist with no title; the first real value must still land.
		await upsertPost(db, "hello", null, null);
		await upsertPost(db, "hello", "Real Title", "https://a.example/hello");
		const post = await getPost(db, "hello");
		expect(post!.title).toBe("Real Title");
		expect(post!.url).toBe("https://a.example/hello");
	});

	it("keeps published_at write-once alongside them", async () => {
		await upsertPost(db, "hello", "T", null, 1_700_000_000_000);
		await upsertPost(db, "hello", "T", null, 1);
		const post = await getPost(db, "hello");
		expect(post!.published_at).toBe(1_700_000_000_000);
	});

	it("does not create a second row for the same slug", async () => {
		await upsertPost(db, "hello", "A", null);
		await upsertPost(db, "hello", "B", null);
		const { results } = await db
			.prepare("SELECT slug FROM posts WHERE slug = ?")
			.bind("hello")
			.all();
		expect(results).toHaveLength(1);
	});
});
