/**
 * API error bodies come back in the caller's locale.
 *
 * This is the surface the whole `?lang=` echo exists for. The widget renders a
 * server error verbatim — `showStatus(errBox, json.error ?? …)` — so a route
 * that answers through the module-level English `t` puts an English sentence
 * inside an otherwise German widget. The locale middleware supplies `c.get("t")`
 * for exactly this, and these tests pin that each route module actually reads
 * it.
 *
 * Deliberately picked the error paths that trip before any DB, KV or rate-limit
 * work: the question here is which translator the handler bound, not what the
 * handler does afterwards.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { de } from "../src/i18n/de";
import { en } from "../src/i18n/en";
import type { Bindings } from "../src/index";
import { localeMiddleware } from "../src/lib/locale";
import { comments } from "../src/routes/api.comments";
import { pageEngagement } from "../src/routes/api.page-engagement";
import { preview } from "../src/routes/api.preview";

const SELF = "https://comments.example.com";

/** Mounted as index.ts does: the locale middleware covers all of /api/*. */
const app = () => {
	const a = new Hono<{ Bindings: Bindings }>();
	a.use("/api/*", localeMiddleware());
	a.route("/api/v1/comments", comments);
	a.route("/api/v1/page-engagement", pageEngagement);
	a.route("/api/v1/preview", preview);
	return a;
};

const errorFor = async (path: string, init?: RequestInit): Promise<string> => {
	const res = await app().request(`${SELF}${path}`, init, {} as Bindings);
	const json = (await res.json()) as { error?: string };
	return json.error ?? "";
};

// One case per route module, each on a distinct key, so a module that never
// migrated off the English `t` fails here rather than in review.
const CASES: {
	surface: string;
	path: string;
	init?: RequestInit;
	key: "err.post.required" | "err.post.invalid" | "err.internal";
}[] = [
	{
		surface: "GET /comments — missing slug",
		path: "/api/v1/comments",
		key: "err.post.required",
	},
	{
		surface: "GET /page-engagement — invalid slug",
		path: "/api/v1/page-engagement?slug=" + encodeURIComponent("no spaces?"),
		key: "err.post.invalid",
	},
	{
		surface: "POST /preview — unparseable body",
		path: "/api/v1/preview",
		init: {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		},
		key: "err.internal",
	},
];

describe("API error bodies — caller locale", () => {
	for (const { surface, path, init, key } of CASES) {
		it(`${surface} answers in German for ?lang=de`, async () => {
			const sep = path.includes("?") ? "&" : "?";
			const error = await errorFor(`${path}${sep}lang=de`, init);
			expect(error).toBe(de[key]);
			// Guard against a translation that happens to equal English, which
			// would make the assertion above pass without proving anything.
			expect(error).not.toBe(en[key]);
		});

		it(`${surface} answers in English by default`, async () => {
			expect(await errorFor(path, init)).toBe(en[key]);
		});
	}

	it("falls back to English for an unknown locale", async () => {
		const error = await errorFor("/api/v1/comments?lang=kl");
		expect(error).toBe(en["err.post.required"]);
	});

	// `hl` is the host page's <html lang>, and `de` is machine-seeded — reachable
	// only through an explicit opt-in. An error body is not a special case.
	it("ignores a machine-seeded locale arriving as a host-page hint", async () => {
		const error = await errorFor("/api/v1/comments?hl=de");
		expect(error).toBe(en["err.post.required"]);
	});
});
