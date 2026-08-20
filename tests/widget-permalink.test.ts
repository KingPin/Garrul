/**
 * Comment permalink resolution (src/widget/permalink.ts).
 *
 * The widget links each comment's timestamp at the *host page*, not at the
 * Worker's /c/:id redirect — every click of the latter would spend a Worker
 * invocation against the 100k/day free-tier ceiling. /c/:id survives only as
 * the last rung, for the iframe embed standing on the Worker's own origin.
 */
import { describe, it, expect } from "vitest";
import { commentHref } from "../src/widget/permalink";

const API = "https://comments.example.com";
const ID = "01JQZ8X4M2";

describe("commentHref", () => {
	it("anchors against data-url when it is a valid http(s) URL", () => {
		expect(
			commentHref(ID, {
				dataUrl: "https://blog.example.com/post/",
				locationHref: "https://blog.example.com/post/",
				apiBase: API,
			}),
		).toBe(`https://blog.example.com/post/#garrul-comment-${ID}`);
	});

	it("falls back to location when data-url is absent", () => {
		expect(
			commentHref(ID, {
				dataUrl: undefined,
				locationHref: "https://blog.example.com/other/",
				apiBase: API,
			}),
		).toBe(`https://blog.example.com/other/#garrul-comment-${ID}`);
	});

	it("uses /c/:id when standing on the Worker's own origin", () => {
		// The iframe embed (src/routes/embed-iframe.ts) without ?url= — location
		// is the Worker's /embed/:slug page, so anchoring at it self-references.
		expect(
			commentHref(ID, {
				dataUrl: undefined,
				locationHref: `${API}/embed/my-post`,
				apiBase: API,
			}),
		).toBe(`${API}/c/${ID}`);
	});

	it("preserves an existing query string", () => {
		expect(
			commentHref(ID, {
				dataUrl: "https://blog.example.com/post/?utm=x",
				locationHref: "https://blog.example.com/post/",
				apiBase: API,
			}),
		).toBe(`https://blog.example.com/post/?utm=x#garrul-comment-${ID}`);
	});

	it("replaces an existing fragment rather than appending to it", () => {
		// Deliberate divergence from src/routes/permalink.ts:56, which emits
		// `#existing&garrul-comment-<id>` — that resolves to nothing.
		expect(
			commentHref(ID, {
				dataUrl: "https://blog.example.com/post/#section-2",
				locationHref: "https://blog.example.com/post/",
				apiBase: API,
			}),
		).toBe(`https://blog.example.com/post/#garrul-comment-${ID}`);
	});

	it.each(["javascript:alert(1)", "data:text/html,<script>", "//evil.example.com", "/relative/path"])(
		"rejects %s in data-url and falls through to location",
		(hostile) => {
			expect(
				commentHref(ID, {
					dataUrl: hostile,
					locationHref: "https://blog.example.com/post/",
					apiBase: API,
				}),
			).toBe(`https://blog.example.com/post/#garrul-comment-${ID}`);
		},
	);

	it("falls through to /c/:id when neither data-url nor location is usable", () => {
		expect(
			commentHref(ID, {
				dataUrl: undefined,
				locationHref: "about:blank",
				apiBase: API,
			}),
		).toBe(`${API}/c/${ID}`);
	});

	it("does not double a trailing slash on the /c/ fallback", () => {
		expect(
			commentHref(ID, {
				dataUrl: undefined,
				locationHref: "about:blank",
				apiBase: `${API}/`,
			}),
		).toBe(`${API}/c/${ID}`);
	});
});
