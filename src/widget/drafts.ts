/**
 * Draft autosave keys and the one-time legacy adoption.
 *
 * DOM-free on purpose (tsconfig.widget.json, plain node tests). embed.ts owns
 * the textarea wiring; this module owns what the key looks like and how a
 * pre-2.27.0 draft (no origin in the key) is carried over.
 *
 * Why the origin: localStorage is scoped to the host page's origin, not to
 * the Worker a page talks to. Two pages on the same host origin that point at
 * different Workers (a staging site and production during a migration, say)
 * share that storage, so a key without the Worker's origin let one Worker's
 * draft appear under the other. The API origin is the identity of the Worker
 * the draft belongs to.
 */

const DRAFT_PREFIX = "garrul:draft:";

/** Cap on stored bytes; the server rejects oversized bodies anyway. */
export const DRAFT_MAX = 10_000;

/** The subset of Storage this module touches; lets tests pass a plain object. */
export type DraftStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
};

export const draftKey = (origin: string, slug: string, parentId: string | null): string =>
	`${DRAFT_PREFIX}${origin}:${slug}${parentId ? `:${parentId}` : ""}`;

/** The pre-2.27.0 key, kept only so adoptLegacyDraft can find old drafts. */
export const legacyDraftKey = (slug: string, parentId: string | null): string =>
	`${DRAFT_PREFIX}${slug}${parentId ? `:${parentId}` : ""}`;

/**
 * Copy a draft saved under the legacy key into the new key, then remove the
 * legacy entry — only when the new key is empty and the legacy key has text.
 * Any storage error (Safari private mode, quota, disabled) is swallowed:
 * losing an old draft is acceptable, breaking the composer is not.
 */
export const adoptLegacyDraft = (
	storage: DraftStorage,
	newKey: string,
	legacyKey: string,
): void => {
	try {
		if (storage.getItem(newKey)) return;
		const old = storage.getItem(legacyKey);
		if (!old) return;
		storage.setItem(newKey, old.slice(0, DRAFT_MAX));
		storage.removeItem(legacyKey);
	} catch {
		// Storage unavailable — nothing to adopt.
	}
};
