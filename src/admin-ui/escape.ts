export const escapeHtml = (s: string | null | undefined): string => {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
};

// Embed values as code-safe, HTML-escaped JS string literals so the resulting
// Alpine expression is well-formed and injection-proof regardless of the
// underlying string content (defense in depth: ULIDs are safe today, but the
// typing is just `string`).
//
// JSON.stringify alone is not enough: it leaves `<`, `>`, `/` and the line
// separators U+2028/U+2029 raw, which are unsafe once the literal is embedded
// as executable JS (markup-context breakout / older-JS line terminators). We
// re-encode those as `\uXXXX` escapes — valid inside a JS string and inert —
// then escapeHtml for the surrounding double-quoted attribute.
export const jsLiteral = (s: string): string => escapeHtml(jsLiteralRaw(s));

// The same JS literal *without* the HTML-escaping pass, for values embedded in
// a block that is escapeHtml'd as a whole further out (see the x-data blobs in
// admin-ui/pages/*). Running escapeHtml twice would emit `&amp;quot;`, which
// decodes to the text `&quot;` instead of a quote and breaks the expression.
export const jsLiteralRaw = (s: string): string =>
	JSON.stringify(s).replace(
		/[<>/\u2028\u2029]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
