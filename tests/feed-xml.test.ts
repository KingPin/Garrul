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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { feed } from "../src/routes/feed";
import type { Bindings } from "../src/index";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";

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

const seedPost = (url: string | null, slug = SLUG) => {
	sqlite
		.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
		.run(slug, "A post", url, 1_700_000_000_000);
};

const seedComment = (
	authorName: string,
	bodyHtml: string,
	opts: {
		slug?: string;
		status?: string;
		createdAt?: number;
		editedAt?: number | null;
	} = {},
) => {
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
			                       renderer_version, status, created_at, edited_at, depth)
			 VALUES (?, ?, NULL, ?, 'md', ?, 1, ?, ?, ?, 1)`,
		)
		.run(
			cid,
			opts.slug ?? SLUG,
			uid,
			bodyHtml,
			opts.status ?? "approved",
			opts.createdAt ?? 1_700_000_000_000,
			opts.editedAt ?? null,
		);
	return cid;
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
	// The route resolves the operator's `default_locale` through loadStrings,
	// which derives settings from D1 (memoized per isolate). The setup file
	// busts the memo each test, so this stays a cold read; a KV stub that never
	// hits is enough here — the point of these tests is the XML the route serializes.
	const kv = {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
	};
	env = {
		DB: makeD1(sqlite),
		ENV: "dev",
		TREE_CACHE: kv,
		ALLOWED_ORIGINS: "https://blog.example",
	} as unknown as Bindings;
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

	const alternates = (xml: string) => xml.match(/rel="alternate"[^>]*>/g) ?? [];

	it.each([["javascript:alert(1)"], ["https://evil.example/post"], [null]])(
		"emits no alternate link for post URL %s",
		async (url) => {
			seedPost(url);
			seedComment("Bob", "<p>hi</p>");
			const xml = await (await fetchFeed()).text();
			expect(alternates(xml)).toEqual([]);
			expect(xml).toContain('rel="self"');
			expect(xml).not.toContain("javascript:");
			expect(xml).not.toContain("evil.example");
		},
	);

	it("replaces an existing fragment with the comment anchor", async () => {
		seedPost("https://blog.example/post#section");
		const id = seedComment("Bob", "<p>hi</p>");
		const xml = await (await fetchFeed()).text();
		expect(xml).toContain(`href="https://blog.example/post#garrul-comment-${id}"`);
		expect(xml).not.toContain("&amp;garrul-comment-");
	});

	it("keeps a valid http(s) post URL", async () => {
		seedPost("https://blog.example/post");
		seedComment("Bob", "<p>hi</p>");

		const xml = await (await fetchFeed()).text();
		expect(xml).toContain('href="https://blog.example/post"');
	});
});

describe("GET /feed/:slug — locale", () => {
	beforeEach(() => {
		seedPost("https://blog.example/post");
		seedComment("Bob", "<p>hi</p>");
	});

	it("declares xml:lang from the operator default", async () => {
		const xml = await (await fetchFeed()).text();
		expect(xml).toContain('xml:lang="en"');
	});

	it("ignores ?lang= — the response is edge-cached under a locale-free URL", async () => {
		const xml = await (
			await new Hono<{ Bindings: Bindings }>()
				.route("/", feed)
				.request(
					`/${SLUG}?lang=de`,
					{},
					env as unknown as Record<string, unknown>,
				)
		).text();
		expect(xml).toContain('xml:lang="en"');
	});

	it("falls back to English when DEFAULT_LOCALE names an unregistered locale", async () => {
		(env as unknown as Record<string, unknown>).DEFAULT_LOCALE = "kl";
		const xml = await (await fetchFeed()).text();
		expect(xml).toContain('xml:lang="en"');
	});
});

describe("GET /feed/:slug — edge cache", () => {
	afterEach(uninstallMockCaches);

	it("serves the second read from the edge cache, not D1", async () => {
		installMockCaches();
		seedPost("https://blog.example/post");
		seedComment("Ann", "<p>first</p>");
		const first = await (await fetchFeed()).text();
		seedComment("Bob", "<p>second</p>");
		const second = await fetchFeed();
		expect(second.headers.get("content-type")).toContain("application/atom+xml");
		expect(await second.text()).toBe(first);
	});
});
