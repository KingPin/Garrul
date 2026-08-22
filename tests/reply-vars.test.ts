/**
 * Saved-reply variables — `{name}`, `{post}`, `{mod}`.
 *
 * Two things are worth pinning. First the substitution rules themselves,
 * because "leave it literal" is the deliberate half: an unresolved `{name}` in
 * the textarea is a prompt to fix it, an empty string is a sentence the mod
 * posts without noticing.
 *
 * Second — and this is why the file exists at all — the browser copy. The
 * admin panel ships no JS bundle, so the substitution that actually runs is
 * source text embedded in an Alpine `x-data` blob. Testing only the TS twin
 * would test the copy nobody executes, so every case below runs through both
 * and the two are diffed.
 */
import { describe, it, expect } from "vitest";
import {
	applyReplyVars,
	REPLY_VARS_JS,
	type ReplyVars,
} from "../src/admin-ui/components/reply-vars";

// The emitted source, evaluated the way the browser evaluates it.
const browserApply = new Function(`return (${REPLY_VARS_JS});`)() as (
	s: string,
	v: Record<string, string>,
) => string;

const CASES: Array<{ body: string; vars: ReplyVars; want: string }> = [
	{
		body: "Thanks {name} — moved to {post}. — {mod}",
		vars: { name: "Ada", post: "Rolling Oasis", mod: "KingPin" },
		want: "Thanks Ada — moved to Rolling Oasis. — KingPin",
	},
	{
		body: "Hi {name}, hi again {name}.",
		vars: { name: "Ada" },
		want: "Hi Ada, hi again Ada.",
	},
	// Anonymous commenter: no name to fill in, so the placeholder survives
	// rather than collapsing to "Hi , thanks".
	{ body: "Hi {name}, thanks", vars: { name: "" }, want: "Hi {name}, thanks" },
	{ body: "Hi {name}, thanks", vars: {}, want: "Hi {name}, thanks" },
	// Not one of ours — a CSS snippet or a template the mod pastes in keeps its
	// braces instead of silently losing them.
	{
		body: "a {foo} b {NAME} c { name } d",
		vars: { name: "Ada" },
		want: "a {foo} b {NAME} c { name } d",
	},
	{ body: "no variables here", vars: { name: "Ada" }, want: "no variables here" },
];

describe("applyReplyVars", () => {
	for (const c of CASES) {
		it(`substitutes ${JSON.stringify(c.body)}`, () => {
			expect(applyReplyVars(c.body, c.vars)).toBe(c.want);
		});
	}

	it("does not re-scan its own output", () => {
		// A value that looks like a placeholder is inserted, not re-expanded —
		// otherwise a display name of "{mod}" would impersonate the moderator.
		expect(applyReplyVars("Hi {name}", { name: "{mod}", mod: "KingPin" })).toBe(
			"Hi {mod}",
		);
	});
});

describe("REPLY_VARS_JS (the copy the browser runs)", () => {
	for (const c of CASES) {
		it(`matches the TS implementation on ${JSON.stringify(c.body)}`, () => {
			expect(browserApply(c.body, c.vars as Record<string, string>)).toBe(
				applyReplyVars(c.body, c.vars),
			);
		});
	}

	it("carries no double quote, which would close the x-data attribute", () => {
		expect(REPLY_VARS_JS).not.toContain('"');
	});
});
