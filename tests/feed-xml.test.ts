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
import worker from "../src/index";
import { TABLES } from "../src/i18n";
import { feed } from "../src/routes/feed";
import {
	RECENT_BY_SLUGS_SQL,
	listPostUrls,
	listRecentApprovedComments,
} from "../src/db/queries";
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

describe("recent-comments queries", () => {
	const T0 = 1_700_000_000_000;
	const db = () => makeD1(sqlite);

	it("install-wide: approved only, newest first, capped at 50, null post fields for an orphan", async () => {
		seedPost("https://blog.example/post");
		for (let i = 0; i < 55; i++) {
			seedComment(`U${i}`, `<p>${i}</p>`, { createdAt: T0 + i });
		}
		seedComment("Pend", "<p>p</p>", { status: "pending", createdAt: T0 + 100 });
		seedComment("Spam", "<p>s</p>", { status: "spam", createdAt: T0 + 101 });
		seedComment("Del", "<p>d</p>", { status: "deleted", createdAt: T0 + 102 });
		// comments.post_slug references posts(slug); an orphan needs FKs off.
		sqlite.exec("PRAGMA foreign_keys = OFF");
		seedComment("Orph", "<p>o</p>", { slug: "orphan", createdAt: T0 + 200 });
		sqlite.exec("PRAGMA foreign_keys = ON");

		const rows = await listRecentApprovedComments(db(), 50, null);

		expect(rows).toHaveLength(50);
		const names = rows.map((r) => r.author_name);
		expect(names).not.toContain("Pend");
		expect(names).not.toContain("Spam");
		expect(names).not.toContain("Del");
		expect(names[0]).toBe("Orph");
		expect(rows[0]).toMatchObject({ post_title: null, post_url: null });
		expect(names[1]).toBe("U54");
		expect(rows[1]).toMatchObject({
			post_title: "A post",
			post_url: "https://blog.example/post",
		});
		const times = rows.map((r) => r.created_at);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it("slug list: returns only comments on the given slugs", async () => {
		seedPost("https://blog.example/a", "a");
		seedPost("https://blog.example/b", "b");
		seedPost("https://blog.example/c", "c");
		seedComment("OnA", "<p>a</p>", { slug: "a", createdAt: T0 + 1 });
		seedComment("OnB", "<p>b</p>", { slug: "b", createdAt: T0 + 2 });
		seedComment("OnC", "<p>c</p>", { slug: "c", createdAt: T0 + 3 });
		seedComment("PendA", "<p>p</p>", { slug: "a", status: "pending", createdAt: T0 + 4 });

		const rows = await listRecentApprovedComments(db(), 50, ["a", "b"]);

		expect(rows.map((r) => r.author_name).sort()).toEqual(["OnA", "OnB"]);
	});

	it("empty slug list returns [] without running a statement", async () => {
		const noStatements = {
			prepare: () => {
				throw new Error("statement must not run");
			},
		} as unknown as D1Database;

		expect(await listRecentApprovedComments(noStatements, 50, [])).toEqual([]);
	});

	it("listPostUrls: returns slug and url for every post with a non-null url", async () => {
		seedPost("https://blog.example/one", "one");
		seedPost(null, "no-url");
		seedPost("https://blog.example/two", "two");

		const rows = await listPostUrls(db());

		expect([...rows].sort((x, y) => x.slug.localeCompare(y.slug))).toEqual([
			{ slug: "one", url: "https://blog.example/one" },
			{ slug: "two", url: "https://blog.example/two" },
		]);
	});

	it("per-site statement stays on comments_post_idx", () => {
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${RECENT_BY_SLUGS_SQL}`)
			.all(JSON.stringify(["a"]), 50)
			.map((r) => (r as { detail: string }).detail)
			.join("\n");
		expect(plan).toContain("comments_post_idx");
		expect(plan).not.toContain("comments_status_created_idx");
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

const alternatesOf = (xml: string): string[] =>
	[...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)].flatMap((m) =>
		[...m[0].matchAll(/rel="alternate"[^>]*href="([^"]*)"/g)].map((x) =>
			(x[1] ?? "").replace(/&amp;/g, "&"),
		),
	);

describe("GET /feed — site-wide recent comments", () => {
	const T0 = 1_700_000_000_000;
	let cache: ReturnType<typeof installMockCaches>;

	const fetchSiteFeed = (qs = "") =>
		new Hono<{ Bindings: Bindings }>()
			.route("/feed", feed)
			.request(`/feed${qs}`, {}, env as unknown as Record<string, unknown>);
	const names = (xml: string) =>
		[...xml.matchAll(/<author><name>([^<]*)<\/name>/g)].map((m) => m[1]);
	const jsonItems = async (qs: string) =>
		((await (await fetchSiteFeed(qs)).json()) as { items: any[] }).items;

	beforeEach(() => {
		cache = installMockCaches();
		(env as unknown as Record<string, unknown>).ALLOWED_ORIGINS =
			"https://blog.example,https://other.example";
	});
	afterEach(uninstallMockCaches);

	it("1: only approved comments, across posts, newest first, capped at 50", async () => {
		seedPost("https://blog.example/a", "a");
		seedPost("https://other.example/b", "b");
		for (let i = 0; i < 55; i++) {
			seedComment(`U${i}`, "<p>x</p>", { slug: i % 2 ? "a" : "b", createdAt: T0 + i });
		}
		seedComment("Pend", "<p>p</p>", { slug: "a", status: "pending", createdAt: T0 + 99 });
		const res = await fetchSiteFeed();
		expect(res.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		const xml = await res.text();
		const n = names(xml);
		expect(n).toHaveLength(50);
		expect(n[0]).toBe("U54");
		expect(n).not.toContain("Pend");
		expect(xml).toContain("<title>Recent comments</title>");
		expect(xml).toContain('rel="self" type="application/atom+xml" href="http://localhost/feed"');
		expect(xml).not.toContain('rel="alternate" type="text/html" href="https://blog.example"');
		expect(xml).toContain(`<updated>${new Date(T0 + 54).toISOString()}</updated>`);
	});

	it("2: ?site= filters by origin, is not crowded out, and an unknown origin is a 400", async () => {
		seedPost("https://blog.example/a", "a");
		seedPost("https://other.example/b", "b");
		seedPost("https://blog.example/empty-origin-none", "c");
		for (let i = 0; i < 3; i++) seedComment(`B${i}`, "<p>x</p>", { slug: "a", createdAt: T0 + i });
		for (let i = 0; i < 60; i++) seedComment(`O${i}`, "<p>x</p>", { slug: "b", createdAt: T0 + 1000 + i });
		const xml = await (await fetchSiteFeed("?site=https://blog.example")).text();
		expect(names(xml).sort()).toEqual(["B0", "B1", "B2"]);
		expect(xml).toContain('rel="alternate" type="text/html" href="https://blog.example"');

		// An allowed origin with no posts: empty feed.
		const empty = await fetchSiteFeed("?site=https://other.example");
		expect(names(await empty.text())).toHaveLength(50);
		sqlite.exec("DELETE FROM comments WHERE post_slug = 'b'");
		sqlite.exec("DELETE FROM posts WHERE slug = 'b'");
		cache.store.clear();
		const none = await fetchSiteFeed("?site=https://other.example");
		expect(none.status).toBe(200);
		expect(names(await none.text())).toEqual([]);

		for (let i = 0; i < 2; i++) {
			const bad = await fetchSiteFeed("?site=https://nope.example");
			expect(bad.status).toBe(400);
			expect(await bad.text()).toBe("invalid site");
		}
		expect(cache.store.size).toBe(1);
	});

	it("3: ?site= matches by parsed origin; an over-long URL is excluded", async () => {
		seedPost("https://BLOG.example/x", "x");
		seedPost("https://blog.example:443/y", "y");
		seedPost(`https://blog.example/${"p".repeat(2049)}`, "long");
		const ix = seedComment("X", "<p>x</p>", { slug: "x", createdAt: T0 + 1 });
		const iy = seedComment("Y", "<p>y</p>", { slug: "y", createdAt: T0 + 2 });
		seedComment("L", "<p>l</p>", { slug: "long", createdAt: T0 + 3 });
		const xml = await (await fetchSiteFeed("?site=https://blog.example")).text();
		expect(names(xml).sort()).toEqual(["X", "Y"]);
		expect(xml).toContain(`href="https://blog.example/x#garrul-comment-${ix}"`);
		expect(xml).toContain(`href="https://blog.example/y#garrul-comment-${iy}"`);
	});

	it("4: ?format=json serves JSON Feed 1.1; unknown format serves Atom", async () => {
		seedPost("https://blog.example/a", "a");
		const plain = seedComment("Ann", "<p>one</p>", { slug: "a", createdAt: T0 + 1 });
		seedComment("Bob", "<p>two</p>", { slug: "a", createdAt: T0 + 2, editedAt: T0 + 5 });
		const res = await fetchSiteFeed("?format=json&site=https://blog.example");
		expect(res.headers.get("content-type")).toMatch(/^application\/feed\+json/);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("cache-control")).toBe("public, max-age=300");
		const body = (await res.json()) as any;
		expect(body.version).toBe("https://jsonfeed.org/version/1.1");
		expect(body.title).toBe("Recent comments");
		expect(body.language).toBe("en");
		expect(body.home_page_url).toBe("https://blog.example");
		expect(body.feed_url).toBe(
			`http://localhost/feed?format=json&site=${encodeURIComponent("https://blog.example")}`,
		);
		const [bob, ann] = body.items;
		expect(bob.title).toBe("Bob commented");
		expect(bob.authors).toEqual([{ name: "Bob" }]);
		expect(bob.date_modified).toBe(new Date(T0 + 5).toISOString());
		expect(bob.date_published).toBe(new Date(T0 + 2).toISOString());
		expect(bob.content_html).toBe("<p>two</p>");
		expect(ann).not.toHaveProperty("date_modified");
		expect(ann.url).toBe(`https://blog.example/a#garrul-comment-${plain}`);
		expect(ann._garrul).toEqual({
			post_slug: "a",
			post_title: "A post",
			post_url: "https://blog.example/a",
		});
		const noSite = (await (await fetchSiteFeed("?format=json")).json()) as any;
		expect(noSite).not.toHaveProperty("home_page_url");
		expect(noSite.feed_url).toBe("http://localhost/feed?format=json");

		const atom = await fetchSiteFeed("?format=xml");
		expect(atom.headers.get("content-type")).toContain("application/atom+xml");
	});

	it("5: cache keys, normalization and zero D1 statements on a hit", async () => {
		seedPost("https://blog.example/a", "a");
		seedPost("https://other.example/b", "b");
		seedComment("InA", "<p>a</p>", { slug: "a", createdAt: T0 + 1 });
		seedComment("InB", "<p>b</p>", { slug: "b", createdAt: T0 + 2 });
		await fetchSiteFeed();
		await fetchSiteFeed("?format=json");
		expect(cache.store.size).toBe(2);
		const a = await (await fetchSiteFeed("?site=https://blog.example")).text();
		const b = await (await fetchSiteFeed("?site=https://other.example")).text();
		expect(a).not.toContain("InB");
		expect(b).not.toContain("InA");
		expect(cache.store.size).toBe(4);
		await fetchSiteFeed("?format=json&utm=1");
		expect(cache.store.size).toBe(4);

		const real = env.DB.prepare.bind(env.DB);
		let calls = 0;
		(env.DB as any).prepare = (sql: string) => {
			calls++;
			return real(sql);
		};
		const hit = await fetchSiteFeed("?format=json&utm=1");
		expect(hit.status).toBe(200);
		expect(calls).toBe(0);
	});

	it("6: unlinked entries in both formats; fragment URL gets the comment anchor", async () => {
		seedPost(null, "nourl");
		seedPost("https://evil.example/p", "evil");
		seedPost("javascript:alert(1)", "js");
		seedPost("https://blog.example/f#section", "frag");
		for (const [i, slug] of ["nourl", "evil", "js"].entries()) {
			seedComment(`N${i}`, "<p>x</p>", { slug, createdAt: T0 + i });
		}
		const fid = seedComment("F", "<p>x</p>", { slug: "frag", createdAt: T0 + 10 });
		const xml = await (await fetchSiteFeed()).text();
		expect(alternatesOf(xml)).toEqual([`https://blog.example/f#garrul-comment-${fid}`]);
		expect(xml).not.toContain("javascript:");
		expect(xml).not.toContain("evil.example");
		const items = await jsonItems("?format=json");
		const unlinked = items.filter((i) => i.authors[0].name.startsWith("N"));
		expect(unlinked).toHaveLength(3);
		for (const i of unlinked) {
			expect(i).not.toHaveProperty("url");
			expect(i._garrul.post_url).toBeNull();
		}
		expect(items[0].url).toBe(`https://blog.example/f#garrul-comment-${fid}`);
	});

	it("7: Atom stays well-formed with a C0 character in an author name", async () => {
		seedPost("https://blog.example/a", "a");
		seedComment(`Bob${CTRL}`, "<p>hi</p>", { slug: "a" });
		const xml = await (await fetchSiteFeed()).text();
		expect(xml).not.toContain(CTRL);
		expect(xml).toContain("<name>Bob</name>");
	});

	it("10: the full app serves /feed with no Origin header", async () => {
		seedPost("https://blog.example/a", "a");
		seedComment("Ann", "<p>hi</p>", { slug: "a" });
		const res = await worker.fetch(
			new Request("https://comments.example/feed"),
			{
				...env,
				ENV: "production",
				IP_HASH_SECRET: "test-ip-hash-secret",
				JWT_SECRET: "test-jwt-secret",
			} as unknown as Record<string, unknown>,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("<name>Ann</name>");
	});

	it("11: every locale table carries its own feed.site_title", () => {
		for (const [loc, table] of Object.entries(TABLES)) {
			const v = (table as Record<string, unknown>)["feed.site_title"];
			expect(typeof v, loc).toBe("string");
			expect((v as string).length, loc).toBeGreaterThan(0);
		}
	});

	it("RF1: empty ?site= is the install-wide feed", async () => {
		seedPost("https://blog.example/a", "a");
		seedPost("https://other.example/b", "b");
		seedComment("A", "<p>x</p>", { slug: "a", createdAt: T0 + 1 });
		seedComment("B", "<p>x</p>", { slug: "b", createdAt: T0 + 2 });
		const res = await fetchSiteFeed("?site=");
		expect(res.status).toBe(200);
		expect(names(await res.text())).toEqual(["B", "A"]);
		expect(cache.store.size).toBe(1);
	});

	it("RF2: trailing slash or uppercase host is a 400", async () => {
		expect((await fetchSiteFeed("?site=https://blog.example/")).status).toBe(400);
		expect((await fetchSiteFeed("?site=https://BLOG.example")).status).toBe(400);
	});

	it("RF3: a comment with no posts row appears unlinked with null post_title", async () => {
		sqlite.exec("PRAGMA foreign_keys = OFF");
		seedComment("Orph", "<p>o</p>", { slug: "ghost" });
		sqlite.exec("PRAGMA foreign_keys = ON");
		const xml = await (await fetchSiteFeed()).text();
		expect(names(xml)).toEqual(["Orph"]);
		expect(alternatesOf(xml)).toEqual([]);
		const [item] = await jsonItems("?format=json");
		expect(item).not.toHaveProperty("url");
		expect(item._garrul).toEqual({ post_slug: "ghost", post_title: null, post_url: null });
	});

	it("RF4: ALLOWED_ORIGINS unset makes every ?site= a 400 and the install-wide feed unlinked", async () => {
		delete (env as unknown as Record<string, unknown>).ALLOWED_ORIGINS;
		seedPost("https://blog.example/a", "a");
		seedComment("Ann", "<p>x</p>", { slug: "a" });
		expect((await fetchSiteFeed("?site=https://blog.example")).status).toBe(400);
		const xml = await (await fetchSiteFeed()).text();
		expect(names(xml)).toEqual(["Ann"]);
		expect(alternatesOf(xml)).toEqual([]);
	});

	it("RF5: repeated params resolve to the first value and share its cache entry", async () => {
		seedPost("https://blog.example/a", "a");
		seedComment("Ann", "<p>x</p>", { slug: "a" });
		const first = await fetchSiteFeed("?format=json&format=atom");
		expect(first.headers.get("content-type")).toMatch(/feed\+json/);
		const body = await first.text();
		expect(await (await fetchSiteFeed("?format=json")).text()).toBe(body);
		expect(cache.store.size).toBe(1);
		const siteA = await (await fetchSiteFeed("?site=https://blog.example&site=https://other.example")).text();
		expect(await (await fetchSiteFeed("?site=https://blog.example")).text()).toBe(siteA);
		expect(cache.store.size).toBe(2);
	});
});
