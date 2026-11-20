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

const mem = new Map<string, string>();

/**
 * The one storage every draft read, write and removal goes through. Per
 * operation it tries `localStorage`; if the getter or the operation throws
 * (blocked storage, full quota), the value lives in a page-lifetime Map
 * instead, so a draft still survives a cancel/reopen or a rebuild.
 */
const store: DraftStorage = {
	getItem: (k) => {
		if (mem.has(k)) return mem.get(k) ?? null;
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	},
	setItem: (k, v) => {
		try {
			localStorage.setItem(k, v);
			mem.delete(k);
		} catch {
			mem.set(k, v);
		}
	},
	removeItem: (k) => {
		mem.delete(k);
		try {
			localStorage.removeItem(k);
		} catch {
			// Nothing to remove.
		}
	},
};
export const draftStorage = (): DraftStorage => store;

export type DraftSaver = {
	schedule: () => void;
	flush: () => void;
	dropIf: (sent: string) => void;
	dispose: () => void;
};

const live = new Set<DraftSaver>();

/** pagehide: flush every saver, retire none (bfcache restores the page as is). */
export const flushAllDrafts = (): void => {
	for (const d of live) d.flush();
};

/** Teardown: flush and retire every saver (the textareas are being detached). */
export const disposeAllDrafts = (): void => {
	for (const d of [...live]) d.dispose();
	live.clear();
};

/**
 * The debounced autosave behind one textarea. `schedule` on every input.
 * The saver is dirty while a debounce timer is pending; `flush` writes only
 * when dirty, so an untouched composer never erases another tab's draft.
 * `lastWritten` is what this saver last put in storage (or found there at
 * creation). `dropIf(sent)` (a successful post) cancels the timer and removes
 * the stored draft only when it is the sent text or this saver's own
 * obsolete save; anything else belongs to another tab. The saver keeps
 * working afterwards (the top composer stays mounted). `dispose` flushes and
 * retires it. Storage is fetched per call; every failure is swallowed.
 */
export const draftSaver = (
	storage: () => DraftStorage,
	key: string,
	read: () => string,
	delayMs = 400,
): DraftSaver => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retired = false;
	let lastWritten: string | null = null;
	try {
		lastWritten = storage().getItem(key);
	} catch {
		// Storage unavailable.
	}
	const cancel = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};
	const write = (v: string): void => {
		if (retired) return;
		try {
			if (v) {
				const c = v.slice(0, DRAFT_MAX);
				storage().setItem(key, c);
				lastWritten = c;
			} else {
				storage().removeItem(key);
				lastWritten = null;
			}
		} catch {
			// Quota/disabled: drop this save silently.
		}
	};
	const saver: DraftSaver = {
		schedule: () => {
			if (retired) return;
			cancel();
			timer = setTimeout(() => {
				timer = undefined;
				write(read());
			}, delayMs);
		},
		flush: () => {
			if (timer === undefined) return;
			cancel();
			write(read());
		},
		dropIf: (sent) => {
			cancel();
			try {
				const cur = storage().getItem(key);
				if (cur !== null && (cur === sent.slice(0, DRAFT_MAX) || cur === lastWritten))
					storage().removeItem(key);
			} catch {
				// Storage unavailable.
			}
			lastWritten = null;
		},
		dispose: () => {
			saver.flush();
			retired = true;
			live.delete(saver);
		},
	};
	live.add(saver);
	return saver;
};
