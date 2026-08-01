/**
 * Host-page title sanitization.
 *
 * `post_title` arrives from the embed widget's `data-title` attribute on an
 * unauthenticated POST /api/v1/comments — the same trust level as a comment
 * body — but unlike `post_url` (scheme-validated at the route) and the comment
 * body (markdown-rendered through a strict allowlist) it used to be stored
 * verbatim with no validation at all.
 *
 * From `posts.title` it fans out into contexts with very different escaping
 * rules, several of them outside HTML:
 *
 *   - the Atom feed's <title> (src/routes/feed.ts)
 *   - Slack `mrkdwn` and Discord embed names (src/lib/webhook-adapters.ts)
 *   - the moderation queue (escaped, so HTML-safe already)
 *   - and email SUBJECT lines (src/lib/digest.ts, src/routes/api.subscriptions.ts)
 *
 * The subject line is the one that actually needs this: a subject is a header
 * value, so a CR or LF in it is a header-injection primitive against whatever
 * builds the message. Rather than teach four call sites four escapes, strip the
 * characters that have no business in a page title at the boundary.
 *
 * Applied on the write path AND again at the mail boundary, because a database
 * upgraded from an earlier version may already hold poisoned rows.
 */

/**
 * Longest title we store. Titles this long are already unreasonable; the cap
 * exists so an unbounded string can't be pushed into a mail subject, a Slack
 * payload and an Atom document on every comment.
 */
export const MAX_POST_TITLE = 200;

// C0 controls + DEL + C1 controls. Covers CR and LF, and the XML-illegal range
// that would also make the Atom feed not well-formed (see feed.ts).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Normalize a host-supplied page title, or null if nothing usable is left.
 *
 * Strips control characters (CR and LF included), collapses remaining
 * whitespace runs to single spaces, trims, and truncates. Returns null for
 * empty input so callers keep the existing "no title supplied" behavior — the
 * consumers all fall back to the slug.
 */
export const sanitizePostTitle = (
	raw: string | null | undefined,
): string | null => {
	if (raw == null) return null;
	const cleaned = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
	if (!cleaned) return null;
	return cleaned.length > MAX_POST_TITLE
		? cleaned.slice(0, MAX_POST_TITLE)
		: cleaned;
};

/**
 * A stored title made safe for a mail subject, falling back to the slug.
 *
 * Separate from `sanitizePostTitle` only so the intent reads at the call site:
 * this is the second application, defending against rows written before the
 * write-path sanitizer existed.
 */
export const subjectTitle = (
	title: string | null | undefined,
	fallbackSlug: string,
): string => sanitizePostTitle(title) ?? fallbackSlug;

/**
 * Substitute a title into a `{title}` subject template.
 *
 * Exists because `String.prototype.replace` with a replacement *string* honors
 * the `$&`, `$'`, `` $` `` and `$n` patterns, so a host-supplied title
 * containing them would splice pieces of the template back into the subject. A
 * replacement *function* is exempt from that grammar. Pass a title already
 * through `subjectTitle` — callers need the same value for the mail body.
 */
export const fillSubject = (template: string, safeTitle: string): string =>
	template.replace("{title}", () => safeTitle);
