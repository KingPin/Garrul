/**
 * Remembered commenter details (name, notify email) for anonymous readers.
 *
 * DOM-free on purpose (tsconfig.widget.json, plain node tests). embed.ts owns
 * the form wiring; this module owns the key, the stored shape and the merge.
 *
 * Saved only after the server accepts a post, never while typing: what gets
 * remembered is a name the server took, not a half-typed one. The value goes
 * back into inputs via `.value`, never as HTML, so a tampered entry is inert.
 * Keyed by the Worker origin for the same reason drafts are (see ./drafts).
 *
 * Same trade-off as WordPress's comment_author cookies: the address sits in
 * the host page's origin storage, readable by that page's own scripts. Those
 * scripts can already read the input as it is typed, so persisting it widens
 * the window, not the audience.
 */

const AUTHOR_PREFIX = "garrul:author:";

/** RFC 5321 path limit; names are clamped far lower server-side anyway. */
const FIELD_MAX = 254;

export type Author = { name: string; email: string };

/** The subset of Storage this module touches; lets tests pass a plain object. */
export type AuthorStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export const authorKey = (origin: string): string => `${AUTHOR_PREFIX}${origin}`;

const clean = (v: unknown): string =>
	typeof v === "string" ? v.trim().slice(0, FIELD_MAX) : "";

/**
 * Read the saved details. Missing, corrupt or wrongly-typed entries read as
 * empty; a null storage (blocked localStorage) does too.
 */
export const readAuthor = (storage: AuthorStorage | null, key: string): Author => {
	try {
		const raw = storage?.getItem(key);
		const v = raw ? (JSON.parse(raw) as Record<string, unknown> | null) : null;
		return { name: clean(v?.name), email: clean(v?.email) };
	} catch {
		return { name: "", email: "" };
	}
};

/**
 * Merge `next` into what is stored. An empty field keeps the stored value: a
 * reply posted without the notify box must not forget the address.
 */
export const rememberAuthor = (
	storage: AuthorStorage | null,
	key: string,
	next: Partial<Author>,
): void => {
	if (!storage) return;
	const cur = readAuthor(storage, key);
	const merged = { name: clean(next.name) || cur.name, email: clean(next.email) || cur.email };
	if (merged.name === cur.name && merged.email === cur.email) return;
	try {
		storage.setItem(key, JSON.stringify(merged));
	} catch {
		// Quota/disabled: not remembering is fine, breaking the post is not.
	}
};
