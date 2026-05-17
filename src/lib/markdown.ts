/**
 * Markdown → sanitized HTML.
 *
 * Strict allowlist: only the tags listed in ALLOWED_TAGS appear in the
 * output. Raw HTML is dropped. Images are dropped. URLs are gated to
 * `https:`, `http:`, or `mailto:` schemes. Anchors get `rel="nofollow ugc"`
 * and `target="_blank"`.
 *
 * Bump CURRENT_RENDERER_VERSION whenever the sanitizer changes and run
 * `npm run rerender` to re-render every stored comment.
 */
import { Marked } from "marked";

export const CURRENT_RENDERER_VERSION = 1;

const URL_ALLOWLIST = /^(https?:|mailto:)/i;
const MAX_BODY_CHARS = 10_000;

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
		// Drop raw HTML entirely.
		renderer: {
			html() {
				return "";
			},
			image() {
				return "";
			},
			// Headings get demoted to <p><strong>…</strong></p> so authors who
			// type "# Hi" still get visual emphasis but no <h1>-<h6> tags.
			heading({ tokens }) {
				// `this` is bound to the parser by marked at call time.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const text = (this as any).parser.parseInline(tokens);
				return `<p><strong>${text}</strong></p>\n`;
			},
			table() {
				return "";
			},
			hr() {
				return "<br>";
			},
			link({ href, title, tokens }) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export const validateBody = (
	src: string,
): { ok: true; body: string } | { ok: false; key: "err.body.required" | "err.body.too_long"; max?: number } => {
	const body = (src ?? "").trim();
	if (body.length === 0) return { ok: false, key: "err.body.required" };
	if (body.length > MAX_BODY_CHARS)
		return { ok: false, key: "err.body.too_long", max: MAX_BODY_CHARS };
	return { ok: true, body };
};
