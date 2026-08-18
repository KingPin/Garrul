/**
 * `src/widget/boot.ts` — the widget's mount request and, mostly, its **fallback
 * rule**.
 *
 * That rule is the part worth testing, because getting it wrong is silent. If
 * `fetchBootstrap` accepted an unusable answer, the widget would render an empty
 * thread list on a post that has comments — no error, no console noise, nothing
 * for an operator to notice. So the null-answer cases below are the bulk of this
 * file, and each names the shape of Worker that produces it.
 *
 * The last block drives `fetchBootstrap` against the **real** bootstrap handler
 * over a stubbed `globalThis.fetch`. That is the one thing the server-side suite
 * cannot do: `tests/bootstrap.test.ts` pins the payload the Worker emits, and
 * this pins that the client half actually accepts it. A contract asserted from
 * one side only is a contract that can drift.
 *
 * boot.ts is deliberately DOM-free so this can run in the plain node pool; the
 * rest of the boot path renders, and rendering needs a browser.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type BootstrapResponse,
	fetchBootstrap,
	fetchConfig,
} from "../src/widget/boot";
import { bootstrap } from "../src/routes/api.bootstrap";
import { localeMiddleware } from "../src/lib/locale";
import { installMockCaches, uninstallMockCaches } from "./helpers/mock-caches";
import type { Bindings } from "../src/index";

const API = "https://comments.example.com";
const SLUG = "hello-world";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/**
 * `credentials` is spelled out because this file is compiled in the Worker-typed
 * program, where `RequestInit` is `@cloudflare/workers-types`' and has no such
 * field — see the note on `CREDENTIALED` in boot.ts. It is also the one init
 * field worth asserting on.
 */
type Call = {
	url: string;
	init: (RequestInit & { credentials?: string }) | undefined;
};

/** Swap in a fetch that answers from `responder` and records what it was asked. */
const stubFetch = (
	responder: (url: string) => Response | Promise<Response>,
): Call[] => {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return responder(String(input));
	}) as typeof fetch;
	return calls;
};

const jsonRes = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** The minimum a payload needs to be mountable: a tree. */
const MOUNTABLE = { comments: { post: null, threads: [], next_cursor: null } };

describe("fetchBootstrap — a usable answer", () => {
	it("returns the whole envelope, sections and all", async () => {
		const body = {
			config: { locale: "en", turnstile_site_key: "site-key" },
			user: { id: "u1", provider: "github", name: "A", email: "a@b.c" },
			comments: { post: { slug: SLUG }, threads: [{ id: "c1" }], next_cursor: null },
			engagement: { reactions: { heart: 2 }, my_reactions: ["heart"] },
			subscription: { subscribed: true, pending: false, id: "s1" },
		};
		stubFetch(() => jsonRes(body));
		expect(await fetchBootstrap(API, SLUG, "new", "", "")).toEqual(body);
	});

	it("accepts an empty thread list — a post with no comments is the common case", async () => {
		// The counterpart to every "no tree → fall back" case below. Without this,
		// tightening the check into `threads.length > 0` would look correct and would
		// make the legacy path the default on every quiet post.
		stubFetch(() => jsonRes(MOUNTABLE));
		expect(await fetchBootstrap(API, SLUG, "new", "", "")).not.toBeNull();
	});

	it("tolerates a payload with only the tree in it", async () => {
		// Every other section is absent for ordinary reasons — no session, a surface
		// switched off — so their absence must not read as failure.
		stubFetch(() => jsonRes(MOUNTABLE));
		const boot = await fetchBootstrap(API, SLUG, "new", "", "");
		expect(boot?.config).toBeUndefined();
		expect(boot?.user).toBeUndefined();
		expect(boot?.subscription).toBeUndefined();
	});
});

describe("fetchBootstrap — falls back", () => {
	it("on 404, which is what a Worker predating the endpoint answers", async () => {
		stubFetch(() => jsonRes({ error: "not found" }, 404));
		expect(await fetchBootstrap(API, SLUG, "new", "", "")).toBeNull();
	});

	// Each of these is a 200 the widget must still refuse: an error envelope, a
	// null body, a tree-shaped key holding the wrong type. Rendering any of them
	// as "no comments" is the failure mode this whole rule exists to prevent.
	const unusable: [string, unknown][] = [
		["an error envelope with no tree", { error: "post_required" }],
		["a bare JSON null", null],
		["a null comments section", { comments: null }],
		["a comments section with no threads key", { comments: { post: null } }],
		["threads that are not an array", { comments: { threads: "one" } }],
		["threads that are an object", { comments: { threads: { 0: "c1" } } }],
	];
	for (const [label, body] of unusable) {
		it(`on ${label}`, async () => {
			stubFetch(() => jsonRes(body));
			expect(await fetchBootstrap(API, SLUG, "new", "", "")).toBeNull();
		});
	}

	it("on a 200 that is not JSON at all", async () => {
		// A captive portal or an HTML error page served with a 200.
		stubFetch(() => new Response("<html>login</html>", { status: 200 }));
		expect(await fetchBootstrap(API, SLUG, "new", "", "")).toBeNull();
	});

	it("on a network failure", async () => {
		// Deliberately *not* in the throwing block below. Cloudflare answers an
		// over-quota request with an HTTP response, not a dead connection, so this
		// case amplifies nothing — and it is the one where something could be
		// blocking this path while the five older ones still work.
		stubFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		expect(await fetchBootstrap(API, SLUG, "new", "", "")).toBeNull();
	});
});

describe("fetchBootstrap — refuses to fall back", () => {
	// The edge answered and said no. The five calls the fallback would make get
	// refused the same way, so falling back turns one rejected request into six
	// on an install that is already over its cap. These must throw, not answer
	// `null`; the caller renders the error instead of amplifying the load.
	for (const status of [400, 403, 429, 500, 502]) {
		it(`throws on ${status} rather than spending five more requests`, async () => {
			stubFetch(() => jsonRes({ error: "nope" }, status));
			await expect(
				fetchBootstrap(API, SLUG, "new", "", ""),
			).rejects.toThrow(`HTTP ${status}`);
		});
	}
	// 404 is the one status that stays in the `null` bucket — see the first case
	// in the block above, which is what stops this from widening to `!res.ok`.
});

describe("fetchBootstrap — the request it sends", () => {
	const askFor = async (
		sort: "new" | "top",
		langExplicit = "",
		langHint = "",
	): Promise<URL> => {
		const calls = stubFetch(() => jsonRes(MOUNTABLE));
		await fetchBootstrap(API, SLUG, sort, langExplicit, langHint);
		return new URL(calls[0]?.url ?? "");
	};

	it("sends the slug and nothing else by default", async () => {
		const url = await askFor("new");
		expect(url.pathname).toBe("/api/v1/bootstrap");
		expect([...url.searchParams]).toEqual([["slug", SLUG]]);
	});

	it("sends sort only for the non-default sort", async () => {
		expect((await askFor("top")).searchParams.get("sort")).toBe("top");
		expect((await askFor("new")).searchParams.has("sort")).toBe(false);
	});

	it("keeps lang and hl as separate params", async () => {
		// They are not interchangeable server-side: an unreviewed translation is
		// reachable through the operator's data-lang and never through a theme's
		// stray <html lang>. Collapsing them here would quietly widen that.
		const both = await askFor("new", "de", "fr");
		expect(both.searchParams.get("lang")).toBe("de");
		expect(both.searchParams.get("hl")).toBe("fr");
		const hintOnly = await askFor("new", "", "fr");
		expect(hintOnly.searchParams.has("lang")).toBe(false);
		expect(hintOnly.searchParams.get("hl")).toBe("fr");
	});

	it("encodes a slug with path characters in it", async () => {
		const calls = stubFetch(() => jsonRes(MOUNTABLE));
		await fetchBootstrap(API, "blog/2026/hello.html", "new", "", "");
		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("slug")).toBe("blog/2026/hello.html");
		expect(url.search).not.toContain("blog/2026");
	});

	it("sends credentials, which is what makes user and subscription possible", async () => {
		// Drop this and the call still succeeds — it just comes back permanently
		// signed-out. Exactly the kind of regression nothing else would catch.
		const calls = stubFetch(() => jsonRes(MOUNTABLE));
		await fetchBootstrap(API, SLUG, "new", "", "");
		expect(calls[0]?.init?.credentials).toBe("include");
	});
});

describe("fetchConfig — the legacy path's first call", () => {
	it("returns the body on 200", async () => {
		stubFetch(() => jsonRes({ locale: "de" }));
		expect(await fetchConfig(API, "de", "")).toEqual({ locale: "de" });
	});

	it("answers null on a non-2xx instead of throwing", async () => {
		// loadOnce treats a missing config as "use the documented defaults", so this
		// has to be a value, not an exception.
		stubFetch(() => jsonRes({ error: "nope" }, 500));
		expect(await fetchConfig(API, "", "")).toBeNull();
	});

	it("lets a network failure reach the caller's catch", async () => {
		// Deliberately unlike fetchBootstrap: there is no second path to fall to,
		// and loadOnce already wraps this call in the catch that installs defaults.
		stubFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		await expect(fetchConfig(API, "", "")).rejects.toThrow();
	});

	it("omits the query string entirely when there is nothing to negotiate", async () => {
		const calls = stubFetch(() => jsonRes({}));
		await fetchConfig(API, "", "");
		expect(calls[0]?.url).toBe(`${API}/api/v1/config`);
	});

	it("sends both negotiation inputs when it has them", async () => {
		const calls = stubFetch(() => jsonRes({}));
		await fetchConfig(API, "de", "fr");
		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("lang")).toBe("de");
		expect(url.searchParams.get("hl")).toBe("fr");
	});
});

// --- against the real Worker -------------------------------------------------

const MIGRATIONS_DIR = join(__dirname, "../src/db/migrations");
const SID = "a".repeat(64);
const USER = "01HU00000000000000VIEWER";
const COMMENT = "01HC00000000000000000001";

/**
 * Reach into the `comments` section the way embed.ts does — it is `unknown` on
 * the wire type by design, so the renderer owns the cast.
 */
const threadsOf = (boot: BootstrapResponse | null): unknown[] | undefined =>
	(boot?.comments as { threads?: unknown[] } | null | undefined)?.threads;

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

describe("fetchBootstrap — against the real handler", () => {
	let sqlite: DatabaseSync;
	let env: Bindings;

	const execCtx = {
		waitUntil() {},
		passThroughOnException() {},
	} as unknown as ExecutionContext;

	const app = () =>
		new Hono<{ Bindings: Bindings }>()
			.use("/api/*", localeMiddleware())
			.route("/api/v1/bootstrap", bootstrap);

	/** A fetch that dispatches into the Worker, optionally carrying a session. */
	const routeToWorker = (sid?: string): void => {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers ?? {});
			// The browser attaches this because the call sets credentials:"include";
			// nothing in-process does, so stand in for it here.
			if (sid) headers.set("cookie", `garrul_sess=${sid}`);
			return app().request(
				String(input),
				{ ...init, headers },
				env as unknown as Record<string, unknown>,
				execCtx,
			);
		}) as typeof fetch;
	};

	beforeEach(() => {
		installMockCaches();
		sqlite = new DatabaseSync(":memory:");
		for (const file of readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort()) {
			sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
		}
		sqlite
			.prepare(
				`INSERT INTO users (id, provider, provider_id, name, email, avatar_url,
				                    is_admin, role, created_at)
				 VALUES (?, 'github', 'gh-1', 'Viewer', 'viewer@example.com', NULL, 0, 'user', ?)`,
			)
			.run(USER, 1_700_000_000_000);
		sqlite
			.prepare("INSERT INTO posts (slug, title, url, created_at) VALUES (?, ?, ?, ?)")
			.run(SLUG, "Hello", null, 1_700_000_000_000);
		sqlite
			.prepare(
				`INSERT INTO comments (id, post_slug, parent_id, user_id, body_md, body_html,
				                       renderer_version, status, created_at, depth)
				 VALUES (?, ?, NULL, ?, 'hi', '<p>hi</p>', 1, 'approved', ?, 1)`,
			)
			.run(COMMENT, SLUG, USER, 1_700_000_000_000);

		env = {
			DB: makeD1(sqlite),
			TREE_CACHE: {
				get: async () => null,
				put: async () => {},
				delete: async () => {},
			},
			SESSIONS: {
				async get(key: string) {
					return key === `sess:${SID}`
						? JSON.stringify({ user_id: USER, expires_at: 4_102_444_800_000 })
						: null;
				},
				async put() {},
				async delete() {},
			},
			ANALYTICS: { writeDataPoint() {} },
			ENV: "dev",
			IP_HASH_SECRET: "test-secret",
			TURNSTILE_SITE_KEY: "site-key",
			TURNSTILE_SECRET: "secret",
		} as unknown as Bindings;
	});
	afterEach(() => uninstallMockCaches());

	it("accepts what the Worker actually sends, anonymous", async () => {
		routeToWorker();
		const boot = await fetchBootstrap("http://localhost", SLUG, "new", "", "");
		expect(boot).not.toBeNull();
		// The three fields loadOnce reads straight off the envelope.
		expect(threadsOf(boot)).toHaveLength(1);
		expect(boot?.config?.locale).toBe("en");
		expect(boot?.user ?? null).toBeNull();
	});

	it("carries the session user when the cookie rides along", async () => {
		routeToWorker(SID);
		const boot = await fetchBootstrap("http://localhost", SLUG, "new", "", "");
		expect((boot?.user as { id?: string } | null)?.id).toBe(USER);
	});

	it("sends a sort the Worker honours", async () => {
		// The widget's `sort` vocabulary and the endpoint's have to be the same two
		// words; a mismatch would silently fall back on every "Top" mount.
		routeToWorker();
		const boot = await fetchBootstrap("http://localhost", SLUG, "top", "", "");
		expect(threadsOf(boot)).toHaveLength(1);
	});

	it("negotiates the locale the Worker resolves", async () => {
		routeToWorker();
		const boot = await fetchBootstrap("http://localhost", SLUG, "new", "de", "");
		expect(boot?.config?.locale).toBe("de");
	});

	it("surfaces the Worker rejecting the slug rather than falling back", async () => {
		// A 400 is not a payload to render around, and the legacy path takes the
		// same 400 on /comments — which is the call whose failure shows an error.
		// So the fallback only ever reached that error the long way round, one
		// rejected request per endpoint. Throwing gets there directly.
		routeToWorker();
		await expect(
			fetchBootstrap("http://localhost", "a b<c>", "new", "", ""),
		).rejects.toThrow("HTTP 400");
	});
});
