/**
 * HTML → markdown conversion for comment importers, plus the entity decoder
 * both it and the XML parsers need.
 *
 * This lives in the importer core rather than inside the Disqus adapter, which
 * is where it started and where the umbrella issue (#104) first placed it. The
 * reasoning there was that Disqus is the only source storing HTML bodies, so
 * every other adapter could pass markdown straight through. That turns out to be
 * wrong for Remark42: its `Comment.Orig` (markdown) field is `omitempty`, and
 * all three of Remark42's own importers — Disqus, WordPress and Commento — write
 * only `Text` (HTML) and never `Orig`. So any comment that reached Remark42 by
 * migration exports with no markdown at all, and its adapter needs this
 * converter as a fallback or it imports an empty body.
 *
 * The output is markdown, never HTML: every caller feeds it to `renderMarkdown`
 * from `src/lib/markdown.ts`, which is the strict allowlist. Nothing here is a
 * sanitizer, and it must not be treated as one — it exists to preserve links and
 * paragraph breaks that a bare tag strip would lose.
 */

export const decodeEntities = (s: string): string =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");

// Strip HTML tags repeatedly until the input is a fixed point. A single
// pass of `<[^>]+>` is bypassable when tags are nested: e.g.
// `<scr<script>ipt>` becomes `<script>` after one replace and would still
// be live HTML if downstream ever interpreted it. We're downstream-safe
// already (output is markdown re-rendered through the allowlist), but
// CodeQL flags the pattern regardless — and the fixed-point loop is the
// canonical fix, costs O(n) per pass on already-clean strings.
export const stripTagsRepeatedly = (s: string): string => {
	let prev: string;
	let curr = s;
	do {
		prev = curr;
		curr = prev.replace(/<[^>]+>/g, "");
	} while (curr !== prev);
	return curr;
};

// Markdown-escape the angle brackets `decodeEntities` just produced.
//
// A source that stores rendered HTML stores the literal text "<span>" as
// "&lt;span&gt;". Decoding recovers "<span>", which is right as *text* and
// wrong as *markdown*: `marked` reads it as a raw HTML tag and the strict
// allowlist in src/lib/markdown.ts then drops it, so the comment silently
// loses the word. A body that was nothing but a tag — a pasted code sample,
// the likeliest place for one — imports as an empty comment.
//
// Escaping here rather than leaving the entities undecoded keeps `body_md`
// idiomatic markdown: an operator editing an imported comment sees `\<span\>`,
// not `&lt;span&gt;`. Both render byte-identically.
//
// Escaping `>` also stops a body that happens to open with "> " from being
// read as a blockquote. Nothing here ever emits a deliberate one — the
// converter strips <blockquote> like every other tag — so there is no
// intentional markup for this to swallow.
//
// The backslash goes first, and it has to: escaping `<` with a backslash is
// only sound if a backslash already in the source is itself escaped. Without
// it "\<script\>" becomes "\\<script\>", which `marked` reads as an escaped
// backslash followed by a *live* tag — the exact loss this function exists to
// prevent, reintroduced by the fix for it. Doubling costs nothing elsewhere:
// `marked` renders "\\" as one backslash, so "C:\path" survives as "C:\path"
// either way, and a source "foo\*bar" now keeps its backslash instead of
// dropping it.
//
// Angle brackets and the escape character, and nothing else. The other
// markdown punctuation is still unescaped, so a literal "*" in the source can
// start emphasis — a fidelity gap, not content loss, and one that belongs
// with the per-source work in #104 rather than here.
const escapeMarkup = (s: string): string =>
	s.replace(/\\/g, "\\\\").replace(/</g, "\\<").replace(/>/g, "\\>");

export const htmlToMarkdown = (html: string): string => {
	if (!html) return "";
	let text = html;
	text = text.replace(
		/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href: string, inner: string) => {
			const url = decodeEntities(href);
			// The label stays entity-encoded here on purpose. Decoding it now
			// turns a literal "&lt;x&gt;" into "<x>", and the tag strip below
			// runs over the whole text — this substitution included — so it
			// would eat the label as though it were markup and leave "[](url)".
			// The single decode at the end of the function covers the label
			// along with everything else.
			const label = stripTagsRepeatedly(inner).trim();
			if (!/^https?:\/\//i.test(url)) return label;
			// Compare decoded, emit encoded: a bare link whose text is its own
			// href differs from it only by entities, and that is not a label.
			return label && decodeEntities(label) !== url
				? `[${label}](${url})`
				: url;
		},
	);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/p>/gi, "\n\n");
	text = stripTagsRepeatedly(text);
	// Decode first, then re-escape: the decode is what recovers "&amp;" and
	// friends, and the escape is what stops the angle brackets it produces
	// from being read back as markup by the renderer downstream.
	text = escapeMarkup(decodeEntities(text));
	return text.trim();
};
