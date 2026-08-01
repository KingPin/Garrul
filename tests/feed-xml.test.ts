/**
 * Atom feed well-formedness (M14).
 *
 * XML 1.0 has no representation for most C0 controls — not even a numeric
 * character reference — so one of them anywhere in the document is a *fatal*
 * error: a conforming reader must reject the whole feed, and the edge caches
 * that for 5 minutes. `xmlEscape` handled `& < > " '` and nothing else, and
 * neither `validName` nor `.trim()` removes control characters, so a single
 * comment from an author whose name ended in U+0001 took the feed down for
 * every subscriber.
 *
 * Real SQLite so the rows are the ones the route actually serves.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { feed } from "../src/routes/feed";
import type { Bindings } from "../src/index";

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");

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

const SLUG = "feed-post";
const CTRL = String.fromCharCode(1);

let sqlite: DatabaseSync;
let env: Bindings;
let nextId = 0;

const seedPost = (url: string | null) => {
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(SLUG, "A post", url, 1_700_000_000_000);
};

const seedComment = (authorName: string, bodyHtml: string) => {
	const uid = `01HU00000000000000000${nextId}`;
	const cid = `01HC00000000000000000${nextId}`;
	nextId++;
	sqlite
		.prepare(
			`INSERT INTO users (id, provider, provider_id, name, is_admin, role, created_at)
			 VALUES (?, 'anon', ?, ?, 0, 'user', ?)`,
		)
		.run(uid, uid, authorName, 1_700_000_000_000);
	sqlite
		.prepare(
			`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
			                       renderer_version, status, created_at, depth)
			 VALUES (?, ?, NULL, ?, 'md', ?, 1, 'approved', ?, 1)`,
		)
		.run(cid, SLUG, uid, bodyHtml, 1_700_000_000_000);
};

const fetchFeed = () =>
	new Hono<{ Bindings: Bindings }>()
		.route("/", feed)
		.request(`/${SLUG}`, {}, env as unknown as Record<string, unknown>);

beforeEach(() => {
	nextId = 0;
	sqlite = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()) {
		sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	env = { DB: makeD1(sqlite), ENV: "dev" } as unknown as Bindings;
});

describe("GET /feed/:slug — XML well-formedness", () => {
	it("strips XML-illegal control characters from an author name", async () => {
		seedPost("https://blog.example/post");
		seedComment(`Bob${CTRL}`, "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).not.toContain(CTRL);
		expect(xml).toContain("<name>Bob</name>");
	});

	it("keeps tab, LF and CR, which XML does allow", async () => {
		seedPost("https://blog.example/post");
		const name = `A${String.fromCharCode(9)}B`;
		seedComment(name, "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).toContain(`<name>${name}</name>`);
	});

	it("strips control characters from a rendered body", async () => {
		seedPost("https://blog.example/post");
		seedComment("Bob", `<p>oops${CTRL}</p>`);

		const xml = await (await fetchFeed()).text();
		expect(xml).not.toContain(CTRL);
		expect(xml).toContain("<p>oops</p>");
	});

	it("cannot be broken out of the CDATA section", async () => {
		// Unreachable through the markdown renderer (it emits &gt; for a literal
		// >), so this pins the property rather than fixing a live hole.
		seedPost("https://blog.example/post");
		seedComment("Bob", "<p>a]]>b</p>");

		const xml = await (await fetchFeed()).text();
		// The terminator is split across two sections, so no stray `]]>` closes
		// content early — the reader still sees the original bytes.
		expect(xml).toContain("<![CDATA[<p>a]]]]><![CDATA[>b</p>]]>");
		expect(xml.match(/<\/content>/g)).toHaveLength(1);
	});

	it("escapes the five XML metacharacters in a name", async () => {
		seedPost("https://blog.example/post");
		seedComment(`<Bob> & "co" 'x'`, "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).toContain(
			"<name>&lt;Bob&gt; &amp; &quot;co&quot; &apos;x&apos;</name>",
		);
	});

	it("does not emit a javascript: post URL as a link", async () => {
		// posts.url came from the widget's data-url attribute. The write path
		// validates the scheme now, but a row from an earlier version may not.
		seedPost("javascript:alert(1)");
		seedComment("Bob", "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).not.toContain("javascript:");
		// Falls back to the feed's own URL rather than dropping the link element.
		expect(xml).toContain(`/feed/${SLUG}`);
	});

	it("keeps a valid http(s) post URL", async () => {
		seedPost("https://blog.example/post");
		seedComment("Bob", "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).toContain('href="https://blog.example/post"');
	});
});
