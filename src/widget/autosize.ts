/**
 * Grows a composer textarea to fit its content.
 *
 * The widget's composers open at a fixed CSS `min-height` — 6em for the
 * top-level form, 4em for reply/edit forms. That is the right default for an
 * *empty* box and the wrong one for a *prefilled* box, which is what the edit
 * composer always is: clicking Edit on a 30-line comment used to hand back a
 * ~3-line window onto text that was fully visible a moment earlier (issue #52).
 *
 * A CSS-only fix can't work, because in both prefill cases the content lands
 * *after* the textarea is already mounted:
 *
 *   - the edit box fetches `body_md` from `/api/v1/comments/:id/source` and
 *     assigns it when the promise resolves;
 *   - a restored draft is read out of localStorage during form construction,
 *     before the form is inserted into the shadow root.
 *
 * So the sizing pass is explicit, and it is called at the three moments content
 * can appear: prefill resolved, draft restored, and every `input` while typing.
 *
 * Two rules keep it from being annoying:
 *
 *   1. Cap the height, so editing a very long comment doesn't push Save/Cancel
 *      below the fold. Past the cap the textarea scrolls, as before.
 *   2. Never fight a manual resize. The resize grip writes inline `height` the
 *      same way this module does, so a height we didn't write is the author's —
 *      once that's seen, this textarea is left alone for good.
 */

/** The slice of `HTMLTextAreaElement` this module touches. */
export interface TextareaLike {
	readonly isConnected: boolean;
	/** `boolean | "until-found"` in the DOM IDL — read for truthiness only. */
	readonly hidden: boolean | string;
	readonly scrollHeight: number;
	readonly offsetHeight: number;
	readonly clientHeight: number;
	readonly style: { height: string };
}

/**
 * Share of the viewport a grown textarea may occupy. Chosen so the actions row
 * under the composer stays on screen at the cap even on a short laptop
 * viewport; the remaining 40% covers the toolbar above and the buttons below.
 */
export const AUTOSIZE_MAX_VIEWPORT_FRACTION = 0.6;

/**
 * Inline heights this module wrote, per textarea. A WeakMap rather than a
 * `data-` attribute so nothing leaks into the host-visible markup, and so the
 * entry dies with the element (reply and edit forms are created and thrown away
 * on every open/cancel).
 */
const written = new WeakMap<TextareaLike, string>();

/**
 * Size `ta` to its content, capped against `viewportHeight`.
 *
 * No-ops when the textarea can't be measured — not yet inserted (a form still
 * under construction) or hidden behind the Preview tab. Both report
 * `scrollHeight` 0, and acting on that would collapse the box.
 */
export const autoSizeTextarea = (
	ta: TextareaLike,
	viewportHeight: number,
): void => {
	if (!ta.isConnected || ta.hidden) return;
	// An inline height that isn't the one we last wrote came from the resize
	// grip. Bail before touching anything, and keep bailing: `written` still
	// holds our stale value, so every later call takes this branch too.
	if (ta.style.height && ta.style.height !== written.get(ta)) return;

	// Reset first so the box can shrink as well as grow: `auto` falls back to
	// the `rows` height, which makes scrollHeight report content height rather
	// than the height we set on the previous keystroke.
	ta.style.height = "auto";
	// scrollHeight is padding-box; with `box-sizing: border-box` the borders
	// have to be added back or the content clips by ~2px and scrolls. Measured
	// rather than hardcoded so a host restyling `--garrul-*` can't break it.
	const chrome = ta.offsetHeight - ta.clientHeight;
	const cap = viewportHeight * AUTOSIZE_MAX_VIEWPORT_FRACTION;
	// CSS `min-height` is the floor for short content — an empty reply box stays
	// the 4em it has always been, so this only ever grows things.
	const next = `${Math.round(Math.min(ta.scrollHeight + chrome, cap))}px`;
	ta.style.height = next;
	written.set(ta, next);
};
