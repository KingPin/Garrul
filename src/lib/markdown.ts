/**
 * Markdown → sanitized HTML.
 *
 * ## The contract
 *
 * Exactly these tags can appear in the output, and nothing else:
 *
 *     p  br  em  strong  del  code  pre  a  blockquote  ul  ol  li
 *
 * Attributes are narrower still. Only two tags carry any:
 *
 *     <a href rel target [title]>   href gated to https:/http:/mailto:
 *     <code class="language-…">     language clamped to CODE_LANG_RE
 *
 * Raw HTML is dropped. Images are dropped. Tables are dropped. Headings are
 * demoted to `<p><strong>`. `<hr>` becomes `<br>`. Task-list checkboxes are
 * rendered as literal `[ ]` / `[x]` text rather than the `<input>` element
 * marked emits by default — a disabled form control in user-generated content
 * is exactly the kind of thing an allowlist exists to keep out.
 *
 * `del` is on the list deliberately: GFM strikethrough (`~~x~~`, and
 * single-tilde `~x~`) is a normal authoring affordance and the tag is inert
 * and attribute-free. It is also in EMAIL_ALLOWED_TAGS so the web and email
 * renderings agree.
 *
 * ## How the allowlist is enforced
 *
 * By overriding marked's renderer methods, *not* by post-filtering the HTML.
 * See the note on `html()` below for the one library behavior this depends on.
 *
 * Bump CURRENT_RENDERER_VERSION whenever the sanitizer changes and run
 * `npm run rerender` to re-render every stored comment — `body_html` is
 * rendered once at write time and served verbatim thereafter, so a change
 * here does not reach existing comments on its own.
 */
import { Marked } from "marked";

// 2: task-list checkboxes stopped emitting `<input type="checkbox">` and the
//    `class="language-…"` on fenced code is clamped to CODE_LANG_RE.
// 1: initial.
export const CURRENT_RENDERER_VERSION = 2;

const URL_ALLOWLIST = /^(https?:|mailto:)/i;
/**
 * Hard ceiling on a comment body, in characters.
 *
 * Exported because /api/v1/config ships it to the widget, which counts down
 * against it as the author types. Two copies of this number would drift, and
 * the drift is only visible as a comment the composer said was fine being
 * rejected on submit.
 */
export const MAX_BODY_CHARS = 10_000;

// Fenced-code info strings that may reach `class="language-…"`. marked already
// HTML-escapes whatever it finds there, so this is not the thing standing
// between us and an attribute breakout — it's about not putting arbitrary
// user-controlled text into an attribute in the first place, so the safety of
// that attribute doesn't depend on an escape staying correct forever.
// Covers every real language label: c++, c#, objective-c, f#, .net, jsx.
const CODE_LANG_RE = /^[A-Za-z0-9+#._-]{1,32}$/;

const escapeHtml = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const makeMarked = (): Marked => {
	const m = new Marked({
		gfm: true,
		breaks: true,
	});

	m.use({
		renderer: {
			// Drop raw HTML entirely.
			//
			// LOAD-BEARING DETAIL, do not "simplify" to a bare `return;`:
			// marked's `use()` wraps every override as
			//
			//     const c = override(...); if (c === false) c = builtin(...); return c || "";
			//
			// so a return value of `false` — and *only* `false` — falls through
			// to the built-in renderer. The built-in `html()` returns the raw
			// markup verbatim. `""` is not `false`, so it wins and the markup is
			// dropped; `undefined` would also work today, but if marked ever
			// relaxed that check to a truthiness test (`if (!c)`), every falsy
			// return would start passing raw HTML straight through. Returning a
			// deliberate `""` keeps us one identity comparison away from that
			// rather than zero. tests/markdown.test.ts pins the behavior.
			html() {
				return "";
			},
			image() {
				return "";
			},
			// GFM task lists. marked's default emits
			// `<input checked="" disabled="" type="checkbox">`, which is a form
			// control with attributes in user-generated content — outside the
			// allowlist on both counts. The literal markers the author typed
			// convey the same thing and need no styling.
			checkbox({ checked }) {
				return checked ? "[x] " : "[ ] ";
			},
			// Headings get demoted to <p><strong>…</strong></p> so authors who
			// type "# Hi" still get visual emphasis but no <h1>-<h6> tags.
			heading({ tokens }) {
				// `this` is bound to the parser by marked at call time.
				// biome-ignore lint/suspicious/noExplicitAny: marked types the renderer's `this` as void, so the parser it actually binds is only reachable through a cast.
				const text = (this as any).parser.parseInline(tokens);
				return `<p><strong>${text}</strong></p>\n`;
			},
			table() {
				return "";
			},
			// Fenced code. Same shape as marked's default, except the info
			// string is dropped unless it looks like a language label — see
			// CODE_LANG_RE. `escaped` is set when the tokenizer already
			// escaped the text; escaping twice would show `&amp;lt;` to the
			// reader.
			code({ text, lang, escaped }) {
				const label = (lang ?? "").trim().split(/\s+/)[0] ?? "";
				const cls = CODE_LANG_RE.test(label)
					? ` class="language-${escapeHtml(label)}"`
					: "";
				const body = escaped ? text : escapeHtml(text);
				return `<pre><code${cls}>${body.replace(/\n$/, "")}\n</code></pre>\n`;
			},
			hr() {
				return "<br>";
			},
			link({ href, title, tokens }) {
				// biome-ignore lint/suspicious/noExplicitAny: same as `heading` above — marked binds the parser to `this` but does not type it.
				const text: string = (this as any).parser.parseInline(tokens);
				if (typeof href !== "string" || !URL_ALLOWLIST.test(href)) {
					return text;
				}
				const safeHref = escapeHtml(href);
				const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
				return `<a href="${safeHref}"${titleAttr} rel="nofollow ugc noopener" target="_blank">${text}</a>`;
			},
		},
	});

	return m;
};

const marked = makeMarked();

export const renderMarkdown = (src: string): string => {
	const trimmed = (src ?? "").slice(0, MAX_BODY_CHARS);
	const html = marked.parse(trimmed, { async: false });
	return typeof html === "string" ? html.trim() : "";
};

/**
 * Defense-in-depth pass over already-rendered body_html before it lands
 * in a transactional email. Strips every attribute except `href` on anchor
 * tags (and re-checks the href scheme), and drops any tag outside a small
 * email-safe allowlist. Email clients have a different threat model than
 * browsers; some pass through attribute handlers we never emit. This keeps
 * the digest minimal.
 */
// Subset of the render allowlist above. `del` is included so a struck-through
// phrase doesn't silently lose its meaning in the digest; everything else the
// renderer can emit is already here.
const EMAIL_ALLOWED_TAGS = new Set([
	"p", "br", "em", "strong", "del", "code", "pre", "blockquote",
	"ul", "ol", "li", "a",
]);

export const sanitizeForEmail = (html: string): string => {
	if (!html) return "";
	return html.replace(
		/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g,
		(full: string, rawTag: string, rawAttrs: string) => {
			const tag = rawTag.toLowerCase();
			if (!EMAIL_ALLOWED_TAGS.has(tag)) return "";
			const isClose = full.startsWith("</");
			if (isClose) return `</${tag}>`;
			if (tag !== "a") return `<${tag}>`;
			const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(rawAttrs);
			const href = hrefMatch ? (hrefMatch[2] ?? hrefMatch[3] ?? "") : "";
			if (!href || !URL_ALLOWLIST.test(href)) return "<a>";
			const safeHref = escapeHtml(href);
			return `<a href="${safeHref}" rel="nofollow ugc noopener" target="_blank">`;
		},
	);
};

export const validateBody = (
	src: string,
): { ok: true; body: string } | { ok: false; key: "err.body.required" | "err.body.too_long"; max?: number } => {
	const body = (src ?? "").trim();
	if (body.length === 0) return { ok: false, key: "err.body.required" };
	if (body.length > MAX_BODY_CHARS)
		return { ok: false, key: "err.body.too_long", max: MAX_BODY_CHARS };
	return { ok: true, body };
};
