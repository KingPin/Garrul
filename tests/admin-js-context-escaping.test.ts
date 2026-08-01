/**
 * Admin UI: values interpolated into JS string literals inside Alpine
 * attributes must go through jsLiteral, not escapeHtml.
 *
 * escapeHtml is correct for text and attribute *values*. It is wrong one layer
 * down, inside `@click="del('HERE')"`, because it turns `'` into `&#39;` — and
 * the browser decodes that back to a real quote before Alpine ever parses the
 * expression, closing the literal. It also leaves `<`, `>` and U+2028/U+2029
 * untouched, all of which are unsafe in executable JS.
 *
 * Every id these pages interpolate is a ULID today, so none of this is
 * exploitable as shipped. The test exists because the *helper choice* is the
 * thing that rots: the day one of these ids becomes user-influenced, the bug is
 * a stored XSS in the moderator's own console, and nothing else would catch it.
 *
 * renderUserDetail's role value is a three-way union, so no hostile string can
 * reach it — the helper there was corrected for consistency, not coverage.
 */
import { describe, it, expect } from "vitest";
import type { SavedReply, User, WebhookEndpoint } from "../src/db/queries";
import { renderUsers } from "../src/admin-ui/pages/users";
import {
	renderWebhooksList,
	renderWebhookForm,
} from "../src/admin-ui/pages/webhooks";
import { renderSavedReplyForm } from "../src/admin-ui/pages/saved-replies";
import { accessDeniedHtml } from "../src/admin-ui/layout";

// A single quote closes the JS literal, `<` opens a tag once the attribute is
// decoded, and the backslash-newline pair is the classic line-continuation
// escape. None of these can appear in a ULID — that is the point.
const HOSTILE = "01H'+alert(1)+'<script>";

const mkUser = (over: Partial<User> = {}): User => ({
	id: HOSTILE,
	provider: "github",
	provider_id: "1",
	name: "Mallory",
	email: "m@example.com",
	avatar_url: null,
	is_admin: false,
	is_banned: false,
	role: "user",
	created_at: 1_700_000_000_000,
	...over,
});

const mkEndpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
	id: HOSTILE,
	url: "https://example.com/hook",
	secret: null,
	events: null,
	adapter: "generic",
	enabled: true,
	fail_count: 0,
	disabled_at: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
	...over,
});

const mkReply = (over: Partial<SavedReply> = {}): SavedReply => ({
	id: HOSTILE,
	owner_id: "01HOWNER0000000000000000AB",
	title: "Welcome",
	body_md: "Thanks for commenting.",
	scope: "private",
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_000,
	...over,
});

/**
 * The two failure signatures, checked together on every page:
 *
 *   - a raw `'` from the id anywhere in the output means the literal it sits in
 *     can be closed;
 *   - a raw `<script` means the id survived into markup.
 */
const expectNoBreakout = (html: string): void => {
	expect(html).not.toContain("+alert(1)+'");
	expect(html).not.toContain("<script>");
	// jsLiteral's signature: the literal is DOUBLE-quoted, so the hostile `'`
	// (which the browser will decode back from &#39;) is inert inside it, and
	// `<` is unicode-escaped so it can't start a tag either way.
	expect(html).toContain("&quot;01H&#39;+alert(1)+&#39;\\u003cscript\\u003e&quot;");
};

describe("JS-string interpolation in admin Alpine attributes", () => {
	it("renderUsers passes the id to setBanned as a JS literal", () => {
		const html = renderUsers([mkUser()], "", null);
		expectNoBreakout(html);
		expect(html).toContain("setBanned(&quot;");
		// The old form: a bare single-quoted literal with no escaping at all.
		expect(html).not.toMatch(/setBanned\('/);
	});

	it("renderWebhooksList passes the id to del as a JS literal", () => {
		const html = renderWebhooksList([mkEndpoint()], {
			active: false,
			url: "",
		});
		expectNoBreakout(html);
		expect(html).toContain("del(&quot;");
		expect(html).not.toMatch(/del\('/);
	});

	it("renderWebhookForm builds the fetch URL as a JS literal", () => {
		const html = renderWebhookForm({ endpoint: mkEndpoint(), error: null });
		expect(html).not.toContain("+alert(1)+'");
		expect(html).not.toContain("<script>");
	});

	it("renderSavedReplyForm builds the fetch URL and del arg as JS literals", () => {
		const html = renderSavedReplyForm({ existing: mkReply(), error: null });
		expectNoBreakout(html);
		expect(html).toContain("del(&quot;");
	});
});

describe("the escaped literal survives the browser's decode", () => {
	// The previous bug in this area was not an injection, it was a *break*: a
	// JSON.stringify'd value in an attribute closed the attribute and silently
	// disabled the Dismiss button. So check the round trip the browser performs
	// — entity-decode the attribute, then parse the literal — and confirm it
	// yields the id back exactly.
	const decodeEntities = (s: string): string =>
		s
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");

	it("round-trips a hostile id through decode + JSON.parse", () => {
		const html = renderUsers([mkUser()], "", null);
		const attr = /@click="([^"]*)"/.exec(html)?.[1];
		expect(attr).toBeDefined();
		const literal = /setBanned\((&quot;.*?&quot;), true\)/.exec(attr ?? "")?.[1];
		expect(literal).toBeDefined();
		// JSON.parse accepts the same escapes JS string literals do, including
		// the / / < that jsLiteral adds.
		expect(JSON.parse(decodeEntities(literal ?? ""))).toBe(HOSTILE);
	});
});

describe("accessDeniedHtml", () => {
	it("HTML-escapes the message", () => {
		// Every caller passes a literal today; escaping it is what keeps that
		// from being load-bearing.
		const html = accessDeniedHtml(403, '<img src=x onerror=alert(1)>');
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
