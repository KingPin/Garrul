/**
 * Saved-reply variables — `{name}`, `{post}`, `{mod}`.
 *
 * Substitution happens **when the mod inserts the reply**, not when it is
 * posted: the resolved text lands in the textarea, so it is editable,
 * previewable, and what the mod approves is exactly what the reader gets. A
 * post-time substitution would also rewrite a `{name}` the mod typed by hand.
 *
 * That puts the substitution in the browser, because the saved-reply bodies
 * arrive from `/admin/api/saved-replies` after the page has rendered. The admin
 * panel ships no JS bundle — behaviour lives in Alpine `x-data` blobs — so the
 * browser copy has to be *source text* embedded in the template. Keeping two
 * hand-written copies (one TS, one string) would be a drift waiting to happen,
 * so both are generated from `VAR_RE_SRC` below and `tests/reply-vars.test.ts`
 * evaluates the emitted source and diffs it against the TS one.
 *
 * An unknown placeholder (`{foo}`) and a known one with no value (an anonymous
 * comment has no author name) are both left **literal**: a visible `{name}` in
 * the textarea is a prompt to fix it, where an empty string is a sentence the
 * mod posts without noticing.
 */

/** Regex source, shared by the TS implementation and the emitted JS. */
const VAR_RE_SRC = "\\{(name|post|mod)\\}";

/** The variables a saved reply may use, in the order the UI lists them. */
export const REPLY_VARS = ["name", "post", "mod"] as const;

export type ReplyVars = Partial<Record<(typeof REPLY_VARS)[number], string>>;

/** Resolve `{name}` / `{post}` / `{mod}` against `vars`. */
export const applyReplyVars = (body: string, vars: ReplyVars): string =>
	body.replace(
		new RegExp(VAR_RE_SRC, "g"),
		(match, key: string) => vars[key as keyof ReplyVars] || match,
	);

/**
 * `applyReplyVars` as browser-JS source, for embedding in an Alpine scope.
 *
 * Single-quoted / quote-free on purpose: the blob is interpolated into a
 * double-quoted `x-data` attribute that is written raw, so a `"` here would
 * terminate the attribute.
 */
export const REPLY_VARS_JS = `function (s, v) { return String(s).replace(/${VAR_RE_SRC}/g, function (m, k) { return v[k] || m; }); }`;

/** One-line hint listing the variables, for the saved-reply editor and picker. */
export const REPLY_VARS_HINT =
	"{name} — comment author · {post} — post title (or slug) · {mod} — you. " +
	"Filled in when you insert the reply; anything else is left as typed.";
