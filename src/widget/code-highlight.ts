/**
 * Lazy loader for the highlighter bundle. Imports nothing from highlighter.ts or
 * highlight-entry.ts on purpose: that would bundle highlight.js into embed.js.
 * The global `window.__garrulHighlight` is declared in highlight-entry.ts.
 * highlighter.ts imports MAX_CODE_CHARS from here, never the other way round.
 */
declare const __GARRUL_HL_HASH__: string;

type Fn = (code: string, lang: string) => string | null;

let configured = false;
let base: string | null = null;
let loading: Promise<Fn | null> | null = null;
const claimed = new WeakSet<Element>();

// highlight.js time grows quadratically on some inputs: a crafted 2,000-char
// Java block takes about 40 ms on a fast desktop, 80 ms at 3,000. Blocks over
// the cap stay plain, and are filtered here so a page with only oversized
// blocks never downloads the highlighter.
export const MAX_CODE_CHARS = 2000;
// Total highlighting time per page. One block can't be interrupted, but a
// thread full of crafted blocks stops costing readers once this is spent;
// the rest stay plain. Ordinary code costs well under 10 ms a block.
const BUDGET_MS = 200;
let spent = 0;

/** First call per page wins; an open tab keeps the state it mounted with. */
export const setCodeHighlight = (b: string | null): void => {
	if (configured) return;
	configured = true;
	base = b;
};

const load = (): Promise<Fn | null> => {
	// One attempt per page, kept even when it resolves null.
	loading ??= new Promise((resolve) => {
		const s = document.createElement("script");
		s.async = true;
		s.src = `${base}/embed-highlight.js?h=${__GARRUL_HL_HASH__}`;
		s.onload = () => resolve(window.__garrulHighlight ?? null);
		s.onerror = () => resolve(null);
		document.head.appendChild(s);
	});
	return loading;
};

const run = async (blocks: Element[]): Promise<void> => {
	const fn = await load();
	if (!fn) return;
	for (const code of blocks) {
		// One block per task so a long thread never blocks the main thread.
		await new Promise((r) => setTimeout(r, 0));
		// A re-render (sort, reload) can detach queued blocks while the script
		// loads; they must not spend the budget the new tree needs.
		if (!code.isConnected) continue;
		if (spent >= BUDGET_MS) return;
		const t0 = performance.now();
		try {
			const html = fn(code.textContent ?? "", code.className.slice("language-".length));
			if (html != null) code.replaceChildren(document.createRange().createContextualFragment(html));
		} catch {
			// A failed block stays plain by design.
		}
		spent += performance.now() - t0;
	}
};

export const highlightCode = (root: ParentNode): void => {
	if (base === null) return;
	const blocks = [...root.querySelectorAll('pre > code[class^="language-"]')].filter(
		(c) => !claimed.has(c) && (c.textContent ?? "").length <= MAX_CODE_CHARS,
	);
	if (!blocks.length) return;
	for (const c of blocks) claimed.add(c);
	void run(blocks);
};
