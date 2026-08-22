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

export const htmlToMarkdown = (html: string): string => {
	if (!html) return "";
	let text = html;
	text = text.replace(
		/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
		(_, href: string, inner: string) => {
			const url = decodeEntities(href);
			const label = decodeEntities(stripTagsRepeatedly(inner)).trim();
			if (!/^https?:\/\//i.test(url)) return label;
			return label && label !== url ? `[${label}](${url})` : url;
		},
	);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<\/p>/gi, "\n\n");
	text = stripTagsRepeatedly(text);
	text = decodeEntities(text);
	return text.trim();
};
