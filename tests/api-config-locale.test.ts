/**
 * GET /api/v1/config — the locale half of the widget bootstrap.
 *
 * This is the only place the widget learns which language it is in, and the
 * only place a translation table crosses to the browser. The properties worth
 * pinning are about *not* shipping things: English costs zero bytes, an unknown
 * tag falls back rather than 400s, and a machine-seeded locale is unreachable
 * without an explicit opt-in.
 *
 * The locale registry is mutated in place here rather than waiting on a real
 * translation to exist — the pipe and the data ship in separate commits, and
 * this suite is about the pipe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { config } from "../src/routes/api.config";
import { MAX_BODY_CHARS, validateBody } from "../src/lib/markdown";
import { LOCALES } from "../src/i18n";
import { WIDGET_TABLES } from "../src/i18n/widget";
import type { Bindings } from "../src/index";

const kv = () => ({
	get: async () => null,
	put: async () => {},
	delete: async () => {},
});

const app = new Hono<{ Bindings: Bindings }>().route("/", config);

const makeEnv = (extra: Record<string, unknown> = {}) =>
	({
		DB: {
			prepare: () => ({
				bind() {
					return this;
				},
				async all() {
					return { results: [] };
				},
				async first() {
					return null;
				},
			}),
		},
		TREE_CACHE: kv(),
		...extra,
	}) as unknown as Record<string, unknown>;

const getConfig = async (
	query = "",
	extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
	const res = await app.request(`/${query}`, {}, makeEnv(extra));
	return (await res.json()) as Record<string, unknown>;
};

// Two fakes: one reviewed (auto-selectable from the host page), one seeded
// (explicit opt-in only). Registered per-test so the suite says nothing about
// which real locales happen to ship.
const REVIEWED = "xa";
const SEEDED = "xb";

beforeEach(() => {
	LOCALES[REVIEWED] = {
		label: "Testish",
		endonym: "Testish",
		rtl: false,
		status: "reviewed",
	};
	LOCALES[SEEDED] = {
		label: "Seedish",
		endonym: "Seedish",
		rtl: true,
		status: "machine-seeded",
	};
	WIDGET_TABLES[REVIEWED] = { "w.reply": "Antwortish" };
	WIDGET_TABLES[SEEDED] = { "w.reply": "Antwortesh" };
});

afterEach(() => {
	delete LOCALES[REVIEWED];
	delete LOCALES[SEEDED];
	delete WIDGET_TABLES[REVIEWED];
	delete WIDGET_TABLES[SEEDED];
});

describe("GET /api/v1/config — locale", () => {
	it("defaults to English and ships no table", async () => {
		// The whole point of compiling EN into the bundle: the common case pays
		// nothing on the wire.
		const body = await getConfig();
		expect(body.locale).toBe("en");
		expect(body).not.toHaveProperty("strings");
		expect(body).not.toHaveProperty("rtl");
	});

	it("serves the requested locale's table", async () => {
		const body = await getConfig(`?lang=${REVIEWED}`);
		expect(body.locale).toBe(REVIEWED);
		expect(body.strings).toEqual({ "w.reply": "Antwortish" });
	});

	it("ships the locale's own overrides, not a merged English copy", async () => {
		// Merging server-side would put ~60 keys on the wire for a translation
		// that filled in one. The widget falls back per key instead.
		const body = await getConfig(`?lang=${REVIEWED}`);
		expect(Object.keys(body.strings as object)).toHaveLength(1);
	});

	it("carries the direction so an RTL locale lays out on an LTR page", async () => {
		expect((await getConfig(`?lang=${SEEDED}`)).rtl).toBe(true);
		expect((await getConfig(`?lang=${REVIEWED}`)).rtl).toBe(false);
	});

	it("matches a regional tag to its base locale", async () => {
		expect((await getConfig(`?lang=${REVIEWED}-AT`)).locale).toBe(REVIEWED);
	});

	it("falls back to English for an unregistered tag", async () => {
		// A whitelist, not an escape: nothing unrecognized reaches Intl or the
		// table lookup, and the reader gets a working widget rather than a 400.
		const body = await getConfig("?lang=zz");
		expect(body.locale).toBe("en");
		expect(body).not.toHaveProperty("strings");
	});

	it("falls back to English for a hostile tag", async () => {
		for (const hostile of ["../../etc/passwd", "<script>", "a".repeat(200)]) {
			const body = await getConfig(`?lang=${encodeURIComponent(hostile)}`);
			expect(body.locale).toBe("en");
		}
	});

	describe("?hl= — the host page's <html lang>", () => {
		it("selects a reviewed locale", async () => {
			expect((await getConfig(`?hl=${REVIEWED}`)).locale).toBe(REVIEWED);
		});

		it("refuses to select a machine-seeded one", async () => {
			// This is the whole sourcing policy in one assertion: unreviewed
			// output is seen only by an operator who typed the tag, and therefore
			// reads the language.
			expect((await getConfig(`?hl=${SEEDED}`)).locale).toBe("en");
		});

		it("yields to an explicit ?lang=", async () => {
			const body = await getConfig(`?lang=${SEEDED}&hl=${REVIEWED}`);
			expect(body.locale).toBe(SEEDED);
		});
	});

	describe("the operator's default_locale", () => {
		it("applies when nothing was requested", async () => {
			const body = await getConfig("", { DEFAULT_LOCALE: REVIEWED });
			expect(body.locale).toBe(REVIEWED);
		});

		it("beats the host page's hint", async () => {
			// Explicit configuration beats inference: <html lang> is frequently
			// untouched theme boilerplate, a settings page is not.
			const body = await getConfig(`?hl=${REVIEWED}`, {
				DEFAULT_LOCALE: SEEDED,
			});
			expect(body.locale).toBe(SEEDED);
		});

		it("loses to an explicit ?lang=", async () => {
			const body = await getConfig(`?lang=${REVIEWED}`, {
				DEFAULT_LOCALE: SEEDED,
			});
			expect(body.locale).toBe(REVIEWED);
		});

		it("falls through when left on the auto sentinel", async () => {
			// "auto" is not a tag, so it simply fails to match — that is what
			// distinguishes "never configured" from "deliberately set to English".
			const body = await getConfig(`?hl=${REVIEWED}`, {
				DEFAULT_LOCALE: "auto",
			});
			expect(body.locale).toBe(REVIEWED);
		});
	});

	it("serves a real shipped locale end to end", async () => {
		// Everything above runs on fakes so the suite says nothing about which
		// languages happen to ship. This one deliberately does not: it is the
		// check that the registry, the table and the route agree for a locale a
		// reader can actually get.
		const body = await getConfig("?lang=de");
		expect(body.locale).toBe("de");
		expect((body.strings as Record<string, string>)["w.reply"]).toBe("Antworten");
	});

	it("ships the same body ceiling the validator enforces", async () => {
		// The widget counts down against this number as the author types. Two
		// copies would drift, and the only symptom of the drift is a comment the
		// composer said was fine coming back rejected.
		const body = await getConfig();
		expect(body.max_body_chars).toBe(MAX_BODY_CHARS);
		const overLong = "x".repeat(MAX_BODY_CHARS + 1);
		expect(validateBody(overLong)).toMatchObject({
			ok: false,
			key: "err.body.too_long",
			max: MAX_BODY_CHARS,
		});
		expect(validateBody("x".repeat(MAX_BODY_CHARS))).toMatchObject({ ok: true });
	});

	it("sets no cache headers, because the body varies by locale", async () => {
		// If this ever fails, the locale has to enter the cache key first —
		// otherwise whichever language warmed the edge is the one everyone gets.
		const res = await app.request(`/?lang=${REVIEWED}`, {}, makeEnv());
		expect(res.headers.get("cache-control")).toBeNull();
	});
});
