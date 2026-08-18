/**
 * Garrul embed widget — single-file vanilla TS, bundled into dist/embed.js.
 *
 * Host page contract:
 *   <div id="garrul" data-slug="post-slug-here"></div>
 *   <script src="https://comments.example.com/embed.js" defer></script>
 *
 * Optional data-* attributes:
 *   data-api="https://comments.example.com"  // origin of the Garrul Worker
 *   data-title="Post title"                  // sent on first comment create
 *   data-url="https://blog/.../post-url"     // ditto
 *
 * Behavior:
 *   1. Mount a Shadow DOM on DOMContentLoaded.
 *   2. Render a skeleton so the slot reserves height within ~50ms.
 *   3. Fetch GET /api/v1/bootstrap?slug=<slug> — one call carrying the config,
 *      the session user, the first page of comments, and (when those surfaces
 *      are on) page engagement and subscribe-bell state. A self-hosted Worker
 *      older than this bundle answers 404 and the widget falls back to the five
 *      calls it replaced; see fetchBootstrap.
 *   4. Render the threaded tree once data arrives.
 *   5. On submit, POST /api/v1/comments. Reload list on success.
 *   6. "Load more" appends older top-level threads via ?before=<cursor>.
 *
 * XSS posture:
 *   - All untrusted text → textContent (never as parsed HTML).
 *   - Server-sanitized HTML (body_html, identicon SVG) is the only thing
 *     parsed as HTML, and it's parsed via Range.createContextualFragment
 *     after src/lib/markdown.ts has already allowlist-sanitized it.
 *   - Skeleton blocks are static template strings (no user input), and the
 *     stylesheet is build-time generated from styles.css — neither is
 *     reachable from anything a commenter can type.
 *
 * Why Shadow DOM: total style isolation. Host CSS can't bleed in; ours
 * can't bleed out. Public theming surface is the documented CSS variables
 * (docs/THEMING.md).
 */

import { loadErrorMessage } from "./load-error";
import { watchForSignIn } from "./auth-recovery";
import { autoSizeTextarea } from "./autosize";
import { createTurnstileGate, type TurnstileGate } from "./turnstile-gate";
import { makeS, type StringTable, type WidgetKey } from "./strings";
import {
	type ReactionCount,
	REACTION_KINDS,
	mergeReactionTotals,
} from "./reactions";
import { absoluteTime, isoTime, relativeTime } from "./time";
// The mount request and the wire shapes it carries. Kept out of this file so the
// fallback rule can be tested without a DOM — see boot.ts's header.
import {
	type BootstrapResponse,
	type ConfigResponse,
	type EngagementSection,
	type MountSeed,
	type PageVoteState,
	type SortKey,
	type SubscriptionSection,
	fetchBootstrap,
	fetchConfig,
} from "./boot";
// Generated from styles.css by scripts/build-styles.ts (gitignored, rebuilt by
// build:assets). Edit styles.css, never the .gen file.
import { STYLE_CSS } from "./styles.gen";

// The widget's translator. A module singleton is correct only because init()
// binds exactly one `#garrul` element per page; a multi-mount widget would have
// to carry this on WidgetCtx instead. Read through `s(...)` at render time
// rather than captured into module constants, so the swap below takes effect on
// the first render of the tree.
let { s, sAround } = makeS();

// The resolved locale, and the two things negotiation is fed from. All three
// are module state for the same single-mount reason as the translator above.
//
// `locale` stays "en" until /api/v1/config answers, which is deliberate: the
// server owns negotiation (it knows the operator's default_locale and which
// locales are reviewed enough to auto-select), so the widget asks rather than
// guesses. Nothing but the loading skeleton renders before the answer arrives.
let locale = "en";
/** `data-lang` on the mount element — the operator's explicit choice. */
let langExplicit = "";
/** The host page's `<html lang>`. A hint; the server may decline to use it. */
let langHint = "";

/**
 * The server's comment-length ceiling, from /api/v1/config. Module state for
 * the same single-mount reason as the translator, and seeded with the value
 * lib/markdown.ts actually enforces so the counter is right even if the config
 * call is the one thing that fails.
 */
let maxBodyChars = 10_000;
/** How close to the ceiling the counter appears. Silent above this. */
const COUNT_WARN_AT = 500;

/**
 * Build an API URL carrying the resolved locale.
 *
 * Server error bodies are rendered verbatim by the widget, so a German reader
 * hitting a rate limit has to get the German sentence. `?lang=` rather than a
 * header because a header would need adding to Access-Control-Allow-Headers on
 * every cross-site embed (src/lib/cors.ts).
 *
 * English sends nothing at all — it is the server's default, so the param would
 * be pure noise on the overwhelming majority of requests.
 */
const apiUrl = (base: string, path: string): string =>
	locale === "en"
		? base + path
		: `${base + path + (path.indexOf("?") < 0 ? "?" : "&")}lang=${encodeURIComponent(locale)}`;

// Mirrors lib/tree.ts's TreeAuthor. No `is_admin`: the API stopped sending it
// (it let anyone enumerate privileged accounts) and nothing here rendered it.
type TreeAuthor = {
	id: string;
	name: string;
	provider: string;
	avatar_svg: string | null;
	avatar_url: string | null;
};

type TreeNode = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: "approved" | "pending" | "spam" | "deleted";
	edited_at: number | null;
	deleted_at: number | null;
	deleted_by: "author" | "moderator" | null;
	created_at: number;
	author: TreeAuthor;
	depth: number;
	flatten_from: string | null;
	/** Optional on purpose: the list response is edge-cached, so payloads
	 *  predating this field keep being served for up to TREE_CACHE_TTL after a
	 *  deploy. Read it through the `n.depth < 4` fallback below, never bare. */
	can_reply?: boolean;
	reactions: ReactionCount[];
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
	replies: TreeNode[];
};

type VoteResponse = {
	ok: boolean;
	comment_id: string;
	score_up: number;
	score_down: number;
	my_vote: -1 | 0 | 1;
};

type ReactionResponse = {
	ok: boolean;
	added: boolean;
	/** Absent on a Worker deployed before the field existed — the widget is
	 *  served by the same Worker, so this is belt-and-braces, but a stale
	 *  cached embed.js against a newer API is the shape that does happen. */
	reactions?: Record<string, number>;
};

type ListResponse = {
	post: unknown;
	threads: TreeNode[];
	next_cursor: string | null;
	// The order this page was actually built in. Optional: a server older than
	// `default_sort` omits it, and the widget then keeps whatever it asked for —
	// falling back to `new` when it asked for nothing, which is the mount case:
	// the reader's preference starts null because choosing the default is the
	// server's job, and a server too old to send `sort` is also too old to have
	// applied one.
	sort?: SortKey;
	// Per-post thread-lifecycle state (src/lib/thread.ts). The widget shows the
	// composer only when accepting_comments is true; closed_reason picks the
	// notice copy. Both optional so an older server (pre-thread-lifecycle) that
	// omits them degrades to "open".
	accepting_comments?: boolean;
	closed_reason?: "comments_disabled" | "post_closed" | "sunset" | "aged_out" | null;
};

type Me = {
	id: string;
	provider: string;
	name: string;
	email: string | null;
	avatar_url: string | null;
	is_admin: boolean;
} | null;


/**
 * The `<time>` element behind a comment's timestamp. The visible label is
 * relative ("2 hours ago"), the `datetime` attribute keeps the exact ISO value
 * for machines and copy-paste, and `title` carries the reader's local wall
 * clock — so nothing that used to be readable off the old UTC string is lost.
 */
const buildTime = (ts: number): HTMLTimeElement => {
	const e = el("time", "gr-time", relativeTime(ts, Date.now(), locale));
	e.dateTime = isoTime(ts);
	e.title = absoluteTime(ts, locale);
	return e;
};

const el = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};

/**
 * The composer's inline status box: submit errors and the Turnstile notices. A
 * polite live region so a screen-reader user learns that a post failed or that
 * the anti-spam check needs them — neither of which was announced before, since
 * the visible change happens well away from the button they just activated.
 *
 * `role="status"` carries an implicit `aria-live="polite"`; both are set because
 * older AT pairs honour one or the other.
 *
 * The box is never hidden via `hidden` or `display: none`. Both remove an
 * element from the accessibility tree, and a live region has to already be in
 * that tree when its text changes for the change to be announced — a region
 * that appears and fills in at the same moment is precisely the case screen
 * readers miss. So it stays in the tree permanently and `.gr-error:empty`
 * collapses it out of the layout while it holds no message.
 *
 * That rule uses `position: absolute` rather than a zero height because these
 * boxes are flex children (`.gr-form` gap 0.5rem, `.gr-reply-form` gap 0.4rem)
 * and a flex item earns its share of the gap however small it is. Taking it out
 * of flow avoids having to cancel two different gap values. No offsets are set,
 * so it stays at its static position and cannot extend the page.
 */
const statusBox = (cls: string): HTMLElement => {
	const box = el("div", cls);
	box.setAttribute("role", "status");
	box.setAttribute("aria-live", "polite");
	return box;
};

/**
 * Show a message in a `statusBox`. Setting the text is all that's needed: the
 * box is already in the accessibility tree, so this is a live mutation, and
 * going from empty to non-empty is what makes it visible again.
 */
const showStatus = (
	box: HTMLElement,
	message: string,
	kind: "error" | "notice" = "error",
): void => {
	box.classList.toggle("is-notice", kind === "notice");
	box.textContent = message;
};

const clearStatus = (box: HTMLElement): void => {
	box.textContent = "";
	box.classList.remove("is-notice");
};

/**
 * Parse a TRUSTED HTML chunk into a DocumentFragment. Use only for content
 * we control (style tag) or server-sanitized output (body_html, identicon SVG).
 */
const parseTrustedHtml = (html: string): DocumentFragment => {
	const range = document.createRange();
	return range.createContextualFragment(html);
};

/** Grow a composer to fit its content, capped against the live viewport. */
const autoSize = (ta: HTMLTextAreaElement): void =>
	autoSizeTextarea(ta, window.innerHeight);

// ── Draft autosave ──────────────────────────────────────────────────────────
// A long comment shouldn't vanish on an accidental reload or a failed submit.
// Drafts live ONLY in the visitor's own browser (localStorage), keyed by slug
// (and parent id for replies). No server state, no PII leaves the device; the
// value is re-inserted via textarea.value (never as HTML), so no XSS surface.
const DRAFT_PREFIX = "garrul:draft:";
// Cap the stored size — localStorage is small and shared across the origin, and
// the server rejects oversized bodies anyway. Generous vs. the comment limit.
const DRAFT_MAX = 10_000;

const draftKey = (slug: string, parentId: string | null): string =>
	`${DRAFT_PREFIX}${slug}${parentId ? `:${parentId}` : ""}`;

const clearDraft = (key: string): void => {
	try {
		localStorage.removeItem(key);
	} catch {
		// Safari private mode / disabled storage: nothing to clear.
	}
};

/**
 * Wire a textarea to localStorage: restore any saved draft on mount, then
 * persist (debounced) on input. Returns the storage key so the submit/cancel
 * paths can clear it. All storage access is wrapped — a throwing localStorage
 * (Safari private mode, quota, disabled) degrades to no autosave, never breaks
 * the composer.
 */
const attachDraft = (ta: HTMLTextAreaElement, key: string): string => {
	try {
		const saved = localStorage.getItem(key);
		// Only restore into an empty field so we never clobber a server-provided
		// or already-typed value.
		if (saved && !ta.value) {
			ta.value = saved;
			// Same shape as the edit prefill: content arrives before the form is in
			// the DOM (buildForm builds, the caller mounts), and an unmounted
			// textarea can't be measured. Defer to just after the mount — the same
			// microtask trick buildReplyForm uses to observe its own parent.
			queueMicrotask(() => autoSize(ta));
		}
	} catch {
		// Storage unavailable — skip restore.
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	ta.addEventListener("input", () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			try {
				const v = ta.value;
				if (v) localStorage.setItem(key, v.slice(0, DRAFT_MAX));
				else localStorage.removeItem(key);
			} catch {
				// Quota/disabled: drop this save silently.
			}
		}, 400);
	});
	return key;
};

type MdFormat = {
	before?: string;
	after?: string;
	linePrefix?: string;
	placeholder?: string;
};

/**
 * Apply a markdown formatting action to the textarea's current selection.
 * Inline formats wrap the selection (or a placeholder when empty); block
 * formats prefix every selected line. Keeps focus and re-fires `input` so the
 * preview/required state stays in sync.
 */
const applyMarkdown = (ta: HTMLTextAreaElement, fmt: MdFormat): void => {
	const { selectionStart, selectionEnd, value } = ta;
	if (fmt.linePrefix) {
		const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
		const block = value.slice(lineStart, selectionEnd);
		const prefixed = block
			.split("\n")
			.map((line) => fmt.linePrefix + line)
			.join("\n");
		ta.value = value.slice(0, lineStart) + prefixed + value.slice(selectionEnd);
		ta.selectionStart = lineStart;
		ta.selectionEnd = lineStart + prefixed.length;
	} else {
		const before = fmt.before ?? "";
		const after = fmt.after ?? "";
		const inner = value.slice(selectionStart, selectionEnd) || fmt.placeholder || "";
		ta.value =
			value.slice(0, selectionStart) +
			before +
			inner +
			after +
			value.slice(selectionEnd);
		ta.selectionStart = selectionStart + before.length;
		ta.selectionEnd = selectionStart + before.length + inner.length;
	}
	ta.focus();
	ta.dispatchEvent(new Event("input", { bubbles: true }));
};

// Toolbar buttons, left to right. `label` is the visible glyph — untranslated,
// because B/I/❝/• read as icons the way a word processor's do. `title` names the
// string key for the tooltip / aria-label; `ph` names the key for the sample
// text inserted when nothing is selected. Both are resolved at build time, not
// module-init time, so the locale is already known.
const TOOLBAR: {
	label: string;
	title: WidgetKey;
	ph?: WidgetKey;
	fmt: MdFormat;
}[] = [
	{ label: "B", title: "w.md.bold", ph: "w.md.ph.bold", fmt: { before: "**", after: "**" } },
	{ label: "I", title: "w.md.italic", ph: "w.md.ph.italic", fmt: { before: "_", after: "_" } },
	{ label: "🔗", title: "w.md.link", ph: "w.md.ph.link", fmt: { before: "[", after: "](https://)" } },
	{ label: "</>", title: "w.md.code", ph: "w.md.ph.code", fmt: { before: "`", after: "`" } },
	{ label: "❝", title: "w.md.quote", fmt: { linePrefix: "> " } },
	{ label: "•", title: "w.md.list", fmt: { linePrefix: "- " } },
];

const buildToolbar = (ta: HTMLTextAreaElement): HTMLElement => {
	const bar = el("div", "gr-toolbar");
	bar.setAttribute("role", "toolbar");
	bar.setAttribute("aria-label", s("w.toolbar"));
	for (const item of TOOLBAR) {
		const btn = el("button", "gr-toolbar-btn", item.label);
		btn.type = "button";
		const title = s(item.title);
		btn.title = title;
		btn.setAttribute("aria-label", title);
		const fmt: MdFormat = item.ph
			? { ...item.fmt, placeholder: s(item.ph) }
			: item.fmt;
		btn.addEventListener("click", () => applyMarkdown(ta, fmt));
		bar.appendChild(btn);
	}
	return bar;
};

/**
 * The two keyboard shortcuts every comment box a reader has already used has:
 * Cmd/Ctrl+Enter posts, Escape backs out. The widget shipped with no keydown
 * handler at all, so a keyboard user had to tab past the preview tab, the six
 * toolbar buttons and the captcha to reach Post.
 *
 * Bound on the form, not the textarea, so it works from the name field and the
 * notify checkbox too.
 */
const bindComposerKeys = (form: HTMLFormElement, onCancel?: () => void): void => {
	form.addEventListener("keydown", (e) => {
		// An IME candidate window owns both keys while composing; Enter picks a
		// candidate and Escape cancels the composition. Posting half a word of
		// Japanese because the widget grabbed the keystroke is the failure mode.
		if (e.isComposing) return;
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			// requestSubmit(), not submit(): submit() skips the submit event, and
			// the submit event is where every form in this widget does its work.
			form.requestSubmit();
			return;
		}
		if (e.key === "Escape" && onCancel) {
			e.preventDefault();
			// The host page may run its own Escape handler (lightbox, drawer,
			// modal). Closing a reply box should not also close whatever the
			// reader has open around it.
			e.stopPropagation();
			onCancel();
		}
	});
};

/**
 * Wrap a composer textarea in a GitHub-style "Write | Preview" tab strip.
 * Returns a container that should be inserted where the textarea would have
 * gone; the textarea is moved inside it.
 *
 * Preview renders server-side via POST /api/v1/preview, so the HTML shown is
 * byte-identical to a posted comment (same sanitizer) — we inject it with
 * parseTrustedHtml at the same trust level as stored body_html.
 */
const buildWritePreview = (
	textarea: HTMLTextAreaElement,
	apiBase: string,
	compact = false,
): HTMLElement => {
	const wrap = el("div", compact ? "gr-compose gr-compose-nested" : "gr-compose");
	const tabs = el("div", "gr-tabs");
	tabs.setAttribute("role", "tablist");
	const writeTab = el("button", "gr-tab gr-tab-active", s("w.tab.write"));
	writeTab.type = "button";
	writeTab.setAttribute("role", "tab");
	writeTab.setAttribute("aria-selected", "true");
	const previewTab = el("button", "gr-tab", s("w.tab.preview"));
	previewTab.type = "button";
	previewTab.setAttribute("role", "tab");
	previewTab.setAttribute("aria-selected", "false");
	tabs.append(writeTab, previewTab);

	const toolbar = buildToolbar(textarea);
	// Every composer in the widget (top-level, reply, edit) is wrapped here, so
	// this is the one place that has to grow the box while the author types.
	// applyMarkdown re-fires `input`, so toolbar insertions size too.
	textarea.addEventListener("input", () => autoSize(textarea));
	// One row under the box: what you can write on the left, how to send it on
	// the right. The whole row hides together in Preview mode.
	const hint = el("div", "gr-md-hint");
	// Silent until the author is close to the ceiling. A permanent "9,847 left"
	// on a limit almost nobody reaches is a nag, not information — the counter
	// is here for the person pasting an essay, and for them it has to appear
	// before they hit Post, not after the server rejects it.
	const counter = el("span", "gr-count");
	counter.hidden = true;
	const paintCount = (): void => {
		const left = maxBodyChars - textarea.value.length;
		counter.hidden = left > COUNT_WARN_AT;
		if (counter.hidden) return;
		counter.textContent =
			left < 0 ? s("w.count_over", { n: -left }) : s("w.count_left", { n: left });
		counter.classList.toggle("is-over", left < 0);
	};
	textarea.addEventListener("input", paintCount);
	paintCount();
	hint.append(
		el("span", undefined, s("w.md_hint")),
		counter,
		el("span", "gr-kbd-hint", s("w.kbd_hint")),
	);
	const pane = el("div", "gr-preview");
	pane.hidden = true;

	const showWrite = (): void => {
		writeTab.classList.add("gr-tab-active");
		previewTab.classList.remove("gr-tab-active");
		writeTab.setAttribute("aria-selected", "true");
		previewTab.setAttribute("aria-selected", "false");
		toolbar.hidden = false;
		hint.hidden = false;
		textarea.hidden = false;
		pane.hidden = true;
	};

	const showPreview = async (): Promise<void> => {
		previewTab.classList.add("gr-tab-active");
		writeTab.classList.remove("gr-tab-active");
		previewTab.setAttribute("aria-selected", "true");
		writeTab.setAttribute("aria-selected", "false");
		toolbar.hidden = true;
		hint.hidden = true;
		textarea.hidden = true;
		pane.hidden = false;
		const body = textarea.value.trim();
		if (!body) {
			pane.textContent = s("w.preview.empty");
			return;
		}
		pane.textContent = s("w.preview.loading");
		try {
			const res = await fetch(apiUrl(apiBase, "/api/v1/preview"), {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ body }),
			});
			if (!res.ok) throw new Error(String(res.status));
			const data = (await res.json()) as { html?: string };
			pane.textContent = "";
			pane.appendChild(parseTrustedHtml(data.html ?? ""));
		} catch {
			pane.textContent = s("w.preview.failed");
		}
	};

	writeTab.addEventListener("click", showWrite);
	previewTab.addEventListener("click", () => {
		void showPreview();
	});

	// Tabs and toolbar share one header row (GitHub-style): tabs left,
	// formatting buttons right. The toolbar hides itself in Preview mode,
	// and the row wraps to two lines on narrow embeds.
	const head = el("div", "gr-compose-head");
	head.append(tabs, toolbar);
	wrap.append(head, textarea, hint, pane);
	return wrap;
};

const buildSkeleton = (): DocumentFragment => {
	const frag = document.createDocumentFragment();
	const root = el("div", "gr-root");
	const list = el("div", "gr-list");
	list.setAttribute("aria-busy", "true");
	list.setAttribute("aria-label", s("w.loading_comments"));
	for (let i = 0; i < 3; i++) {
		const row = el("div", "gr-comment");
		const avatarWrap = el("div", "gr-avatar");
		avatarWrap.appendChild(el("div", "gr-skel gr-skel-avatar"));
		const lines = el("div");
		lines.style.cssText = "flex:1;display:flex;flex-direction:column;gap:0.4em;";
		const widths = ["30%", "85%", "65%"];
		for (const w of widths) {
			const line = el("div", "gr-skel gr-skel-line");
			line.style.width = w;
			lines.appendChild(line);
		}
		row.append(avatarWrap, lines);
		list.appendChild(row);
	}
	root.appendChild(list);
	frag.appendChild(root);
	return frag;
};

const buildAvatar = (a: TreeAuthor): HTMLElement => {
	const wrap = el("div", "gr-avatar");
	if (a.avatar_url) {
		const img = el("img");
		img.setAttribute("src", a.avatar_url);
		img.setAttribute("alt", "");
		// The 40px wrapper already reserves the box, so these buy no layout
		// stability — they buy the network. A long thread is a long thread of
		// provider avatars, every one of them a separate cross-origin request
		// fired eagerly and decoded on the main thread while the reader is still
		// looking at the first comment.
		img.setAttribute("width", "40");
		img.setAttribute("height", "40");
		img.setAttribute("loading", "lazy");
		img.setAttribute("decoding", "async");
		// Provider CDNs get no referrer: which post someone is reading is not
		// GitHub's or Google's business.
		img.setAttribute("referrerpolicy", "no-referrer");
		wrap.appendChild(img);
	} else if (a.avatar_svg) {
		wrap.appendChild(parseTrustedHtml(a.avatar_svg));
	}
	return wrap;
};

type WidgetCtx = {
	apiBase: string;
	slug: string;
	host: HTMLElement;
	root: ShadowRoot;
	me: Me;
	editWindowMs: number;
	turnstileSiteKey: string | null;
	// Operator opted into challenging signed-in commenters as well. The server
	// already folded the site key into this answer, so it is only ever true on
	// an install that can actually render a challenge.
	turnstileAlways: boolean;
	commentsEnabled: boolean;
	// Per-post acceptance (folds in the global flag, per-post close, and
	// auto-close). Drives Reply visibility and the composer/closed-notice
	// swap. closedReason picks the notice copy.
	acceptingComments: boolean;
	closedReason:
		| "comments_disabled"
		| "post_closed"
		| "sunset"
		| "aged_out"
		| null;
	reactionsEnabled: boolean;
	votingEnabled: boolean;
	downvotesEnabled: boolean;
	pageReactionsEnabled: boolean;
	pageVotesEnabled: boolean;
	// Whether this install can send mail at all (EMAIL_FROM + PUBLIC_BASE_URL,
	// derived server-side). Gates both subscribe affordances — the bell and the
	// composer's notify checkbox — because POST /api/v1/subscribe 503s without
	// them, and an opt-in that cannot possibly deliver is worse than no opt-in.
	subscriptionsEnabled: boolean;
	// Reply-collapse tuning (server config). repliesPerThread: replies shown
	// under a parent before a "Show N more" button (0 = all). autoCollapseDepth:
	// a comment at depth >= this starts with its replies collapsed (0 = never).
	repliesPerThread: number;
	autoCollapseDepth: number;
	// Community auto-collapse thresholds (src/routes/api.config.ts). A comment
	// folds client-side when down/(up+down) ≥ ratio% once total votes ≥ floor
	// (and downvotes are on). ratio 0 = disabled.
	communityMinVotes: number;
	communityCollapseRatio: number;
	// What the mount's bootstrap call already answered, so the engagement bar and
	// the subscribe bell render from it instead of each firing their own GET.
	seed: MountSeed;
	reload: () => void;
};

/**
 * Fetch the signed form-render timestamp from the server. The token
 * carries the wall-clock at mint time, so the honeypot-timing heuristic
 * only works if we mint *when the form first appears*, not when the
 * user clicks submit (otherwise `elapsed` is just network latency).
 *
 * Call `prefetchFormToken(apiBase)` at form-render to start the fetch,
 * then `getFormToken(apiBase)` inside the submit handler to await the
 * already-in-flight (or resolved) promise. The promise is cached at
 * module scope so reply forms and the top-level form share one fetch.
 *
 * Assumes one widget mount per document — the bundle hard-codes
 * `getElementById("garrul")`, so a second mount with a different
 * `apiBase` would silently reuse the first's token. If that mounting
 * model changes, scope this cache to the widget context instead.
 *
 * When anti-spam timing is disabled the route 404s and we resolve to
 * an empty string — the server then ignores the absent `form_ts`.
 */
let formTokenPromise: Promise<string> | null = null;
const prefetchFormToken = (apiBase: string): void => {
	if (formTokenPromise) return;
	formTokenPromise = (async () => {
		try {
			const res = await fetch(apiUrl(apiBase, "/api/v1/comments/form-token"), {
				credentials: "include",
			});
			if (!res.ok) return "";
			const json = (await res.json()) as { token?: string };
			return json.token ?? "";
		} catch {
			return "";
		}
	})();
};
const getFormToken = (apiBase: string): Promise<string> => {
	prefetchFormToken(apiBase);
	return formTokenPromise as Promise<string>;
};

/**
 * The live top-level composer's Turnstile handle. The submit handler runs as a
 * free function with no closure over the mount site, so it needs a lookup.
 *
 * A `WeakMap` keyed on the form used to live here, on the theory that GC would
 * clean up after a re-render. It can't: `mountTurnstileFrame` registers its
 * message listener on `window`, and that closure retains the iframe, the token
 * input and the detached form subtree. The handle is what keeps the form
 * reachable, so a map keyed on the form is never collected — every `loadOnce`
 * re-render (sign-in, sort change, a posted comment or reply) leaked another
 * permanent listener pointing at a dead frame.
 *
 * One record instead, matching the single-widget-per-document assumption the
 * form-token cache already relies on (see `prefetchFormToken`). Teardown is
 * explicit: `destroyTopComposerTurnstile` runs at the two places that discard
 * the shadow tree.
 */
let topComposerTurnstile: {
	form: HTMLFormElement;
	gate: TurnstileGate;
	/** No-op until the gate arms and the frame actually mounts. */
	reset: () => void;
	destroy: () => void;
} | null = null;

const destroyTopComposerTurnstile = (): void => {
	topComposerTurnstile?.destroy();
	topComposerTurnstile = null;
};

/**
 * The Turnstile record for `form`, or null when it belongs to a superseded
 * render. Guards against a stale record outliving its form for the window
 * between a reload starting and the teardown below running.
 */
const turnstileFor = (
	form: HTMLFormElement,
): typeof topComposerTurnstile | null =>
	topComposerTurnstile?.form === form ? topComposerTurnstile : null;

/**
 * Mount Cloudflare Turnstile in a same-origin iframe instead of inline.
 *
 * Why not just render it directly: api.js fingerprints the rendered element
 * by walking parentNode and calling `tagName.toLowerCase()`. Inside our
 * Shadow DOM that walk hits the ShadowRoot, whose `tagName` is undefined —
 * Turnstile crashes with "Cannot read properties of undefined (reading
 * 'toLowerCase')" and the widget never paints. The Worker route
 * `/embed/turnstile-frame` hosts the widget in a light-DOM page; we embed
 * that here and shuttle the token back via postMessage so the form's
 * existing `cf-turnstile-response` input keeps working unchanged.
 */
type TurnstileFrameHandle = {
	reset: () => void;
	destroy: () => void;
};

/**
 * What the caller wants to hear about. Every field is optional so a call site
 * can subscribe to only the messages it acts on.
 *
 * The hidden input is still maintained here regardless — it is what the form
 * serializes and what `submit()` reads — so a listener never has to mirror the
 * token itself, only react to it arriving.
 */
type TurnstileFrameListener = {
	onToken?: (token: string) => void;
	onExpired?: () => void;
	/**
	 * `code` is Turnstile's own error code, present only when the error came
	 * from its `error-callback`. Absent means the frame never came up — see the
	 * wire protocol in src/routes/embed-iframe.ts.
	 */
	onError?: (code?: string) => void;
	/** `render()` returned: api.js loaded and a widget is painted. */
	onReady?: () => void;
	/** The challenge needs a human to act before a token can exist. */
	onInteractive?: () => void;
};

const mountTurnstileFrame = (
	container: HTMLElement,
	apiBase: string,
	listener: TurnstileFrameListener,
): TurnstileFrameHandle => {
	const apiOrigin = new URL(apiBase).origin;

	const frame = el("iframe") as HTMLIFrameElement;
	frame.className = "gr-turnstile-frame";
	frame.title = s("w.ts.title");
	frame.setAttribute("scrolling", "no");
	frame.setAttribute(
		"sandbox",
		"allow-scripts allow-same-origin allow-popups",
	);
	// Turnstile's bundle probes for several sensor features for bot-signal
	// scoring. The browser's default Permissions-Policy denies these in
	// cross-origin iframes unless the parent delegates via allow=, which
	// throws "xr-spatial-tracking is not allowed" + siblings into the host
	// console on every page load. Delegating here is purely a console-noise
	// fix — none of these features touch user input.
	frame.setAttribute(
		"allow",
		"xr-spatial-tracking; accelerometer; gyroscope; magnetometer",
	);
	const parentOrigin = encodeURIComponent(window.location.origin);
	frame.src = `${apiBase}/embed/turnstile-frame?parent_origin=${parentOrigin}`;
	container.appendChild(frame);

	const tokenInput = el("input") as HTMLInputElement;
	tokenInput.type = "hidden";
	tokenInput.name = "cf-turnstile-response";
	container.appendChild(tokenInput);

	const ac = new AbortController();
	const onMessage = (e: MessageEvent): void => {
		if (e.origin !== apiOrigin) return;
		if (e.source !== frame.contentWindow) return;
		const data = e.data as
			| { type?: string; token?: string; code?: string }
			| undefined
			| null;
		if (!data || typeof data.type !== "string") return;
		switch (data.type) {
			case "garrul:turnstile-token":
				if (typeof data.token === "string") {
					tokenInput.value = data.token;
					listener.onToken?.(data.token);
				}
				return;
			case "garrul:turnstile-expired":
				// Turnstile auto-re-challenges; clear the stale token so a
				// submit can't reuse it (siteverify would reject anyway).
				tokenInput.value = "";
				listener.onExpired?.();
				return;
			case "garrul:turnstile-error":
				// Anything that isn't a string is treated as no code at all, which
				// is the latching path — a frame that can't name its error doesn't
				// get to ask for a retry.
				listener.onError?.(
					typeof data.code === "string" ? data.code : undefined,
				);
				return;
			// The two mount-state messages exist so a submit waiting on a token
			// can tell "the challenge wants a click" from "the frame never came
			// up" — see the wire protocol in src/routes/embed-iframe.ts.
			case "garrul:turnstile-ready":
				listener.onReady?.();
				return;
			case "garrul:turnstile-interactive":
				listener.onInteractive?.();
				return;
		}
	};
	window.addEventListener("message", onMessage, { signal: ac.signal });

	return {
		reset: () => {
			tokenInput.value = "";
			// contentWindow is null only if the iframe was detached; in
			// that case there's nothing to reset.
			frame.contentWindow?.postMessage(
				{ type: "garrul:turnstile-reset" },
				apiOrigin,
			);
		},
		destroy: () => ac.abort(),
	};
};

const reactionsByKind = (rs: ReactionCount[]): Map<string, ReactionCount> => {
	const m = new Map<string, ReactionCount>();
	for (const r of rs) m.set(r.kind, r);
	return m;
};

// Vote up/down buttons. Anonymous viewers can vote — the server hashes
// their IP into a ghost user (same identity rules as anonymous comments
// and reactions). On click we POST and patch the local TreeNode + DOM
// rather than reloading the whole list: the vote endpoint does not bust
// the tree cache by design, so a reload would just re-fetch the stale
// counters until the next comment-write triggers invalidation.
const buildVotes = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-votes");
	const score = n.score_up - n.score_down;

	// Self-voting is blocked server-side (vote_self_forbidden) and the
	// anonymous case can't be detected client-side without leaking ghost
	// identities. For signed-in viewers, render a read-only score so the
	// author still sees who's reacting to their comment, just without the
	// affordance to game it.
	if (ctx.me && ctx.me.id === n.author.id) {
		wrap.appendChild(el("span", "gr-vote-score", String(score)));
		return wrap;
	}

	const up = el("button", "gr-vote");
	up.type = "button";
	up.setAttribute("aria-label", s("w.vote.up"));
	up.appendChild(document.createTextNode("▲"));
	if (n.my_vote === 1) up.dataset.mine = "1";

	const scoreEl = el("span", "gr-vote-score", String(score));

	const down = el("button", "gr-vote");
	down.type = "button";
	down.setAttribute("aria-label", s("w.vote.down"));
	down.appendChild(document.createTextNode("▼"));
	if (n.my_vote === -1) down.dataset.mine = "1";

	const cast = async (value: -1 | 0 | 1): Promise<void> => {
		up.disabled = true;
		down.disabled = true;
		try {
			const res = await fetch(apiUrl(ctx.apiBase, "/api/v1/votes"), {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ comment_id: n.id, value }),
			});
			if (!res.ok) return;
			const body = (await res.json()) as VoteResponse;
			// Mutate the node so a later re-render (Load more, reload) reflects
			// the new state, and patch the DOM directly so the user sees the
			// change without a full list reload.
			n.score_up = body.score_up;
			n.score_down = body.score_down;
			n.my_vote = body.my_vote;
			scoreEl.textContent = String(body.score_up - body.score_down);
			if (body.my_vote === 1) up.dataset.mine = "1";
			else delete up.dataset.mine;
			if (body.my_vote === -1) down.dataset.mine = "1";
			else delete down.dataset.mine;
		} catch {
			// Network/parse failure: leave UI untouched; user can retry.
		} finally {
			up.disabled = false;
			down.disabled = false;
		}
	};

	up.addEventListener("click", () => {
		void cast(n.my_vote === 1 ? 0 : 1);
	});
	down.addEventListener("click", () => {
		void cast(n.my_vote === -1 ? 0 : -1);
	});

	wrap.append(up, scoreEl, down);
	// Hide the downvote button when downvotes are disabled site-wide. The
	// flag is exposed via /api/v1/config; we read it once on widget mount.
	if (!ctx.downvotesEnabled) down.hidden = true;
	return wrap;
};

// Emoji reactions. Like votes above, a click patches the local TreeNode and
// this one row rather than reloading: `ctx.reload()` runs replaceChildren() on
// the whole shadow tree, so the most frequent interaction in the widget was
// also the most destructive one — it dropped scroll position and any open
// composer with a half-typed draft in it.
const buildReactions = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-reactions");
	const cells = new Map<
		string,
		{ btn: HTMLButtonElement; count: HTMLElement }
	>();

	// The single place that knows how a reaction renders: run at build time and
	// again after every toggle, reading whatever is currently on the node.
	const paint = (): void => {
		const map = reactionsByKind(n.reactions);
		for (const [kind, cell] of cells) {
			const r = map.get(kind);
			const count = r?.count ?? 0;
			if (r?.mine) cell.btn.dataset.mine = "1";
			else delete cell.btn.dataset.mine;
			// `data-mine` is what the stylesheet highlights; aria-pressed is the
			// same fact for a reader who can't see the highlight.
			cell.btn.setAttribute("aria-pressed", r?.mine ? "true" : "false");
			cell.count.textContent = String(count);
			cell.count.hidden = count === 0;
			// An anonymous reader who un-reacts the last 👍 has to see the button
			// go away, because that is the rule the initial render below applies.
			// The old full reload got this for free.
			if (!ctx.me) cell.btn.hidden = count === 0;
		}
	};

	const map = reactionsByKind(n.reactions);
	for (const { kind, emoji, labelKey } of REACTION_KINDS) {
		// Hide zero-count kinds unless the viewer is signed in (so signed-in
		// users can react with a kind nobody else has used yet). Anonymous
		// readers see only used kinds.
		if ((map.get(kind)?.count ?? 0) === 0 && !ctx.me) continue;
		const btn = el("button", "gr-reaction");
		btn.type = "button";
		btn.dataset.kind = kind;
		// The label is hidden text rather than visible text: six labelled cells per
		// comment would be more chrome than the comment. Hidden *in the tree*
		// though, never an aria-label — that would become the whole accessible
		// name and drop the count child, so a screen reader announced "Funny, not
		// pressed" and never the number the button exists to report. The emoji is
		// taken out of the name for the reason the label is needed at all: on a
		// couple of them ("crying face") the glyph's own name reads as the wrong
		// sentiment entirely.
		btn.title = s(labelKey);
		const emojiSpan = el("span", "gr-reaction-emoji", emoji);
		emojiSpan.setAttribute("aria-hidden", "true");
		btn.append(el("span", "gr-sr", s(labelKey)), emojiSpan);
		const count = el("span", "gr-reaction-count", "");
		btn.appendChild(count);
		cells.set(kind, { btn, count });
		btn.addEventListener("click", async () => {
			btn.disabled = true;
			try {
				const res = await fetch(apiUrl(ctx.apiBase, "/api/v1/reactions"), {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ comment_id: n.id, kind }),
				});
				if (!res.ok) return;
				const body = (await res.json()) as ReactionResponse;
				// No counts to patch from means an API older than this bundle;
				// fall back to the reload this used to do rather than merging
				// against `{}`, which would blank every reaction on the comment.
				if (!body.reactions) {
					ctx.reload();
					return;
				}
				// Mutate the node so a later re-render (Load more, sort change)
				// still reflects the toggle, then repaint this row.
				n.reactions = mergeReactionTotals(
					n.reactions,
					body.reactions,
					kind,
					body.added,
				);
				paint();
			} catch {
				// Network/parse failure: leave the UI untouched; user can retry.
			} finally {
				btn.disabled = false;
			}
		});
		wrap.appendChild(btn);
	}
	paint();
	return wrap;
};

/**
 * Article-level engagement bar (emoji reactions + a helpful/up vote tally)
 * shown above the thread. Gated by ctx.pageReactionsEnabled /
 * pageVotesEnabled. Built synchronously, then populated from the mount's
 * bootstrap payload (or GET /api/v1/page-engagement on the legacy path); clicks
 * optimistically patch from the authoritative totals each POST returns (same
 * no-cache-bust pattern as comment votes).
 */
const buildPageEngagement = (ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-page-engage");

	// --- reactions ---
	const reactCells = new Map<
		string,
		{ btn: HTMLButtonElement; count: HTMLElement }
	>();
	if (ctx.pageReactionsEnabled) {
		// The prompt is what turns a row of chips into an invitation — without it
		// the bar reads as a tally of what other people did.
		wrap.appendChild(
			el("div", "gr-page-react-prompt", s("w.page.react_prompt")),
		);
		const reactWrap = el("div", "gr-page-reactions");
		for (const { kind, emoji, labelKey } of REACTION_KINDS) {
			const btn = el("button", "gr-reaction gr-reaction-labelled");
			btn.type = "button";
			btn.dataset.kind = kind;
			// Emoji and count on one line, label under it. Unlike the per-comment
			// row there is space for the label here, and it is the only thing that
			// says what the emoji is *for* before the reader commits to a click.
			const face = el("span", "gr-reaction-face");
			face.appendChild(el("span", "gr-reaction-emoji", emoji));
			const count = el("span", "gr-reaction-count", "0");
			face.appendChild(count);
			btn.append(face, el("span", "gr-reaction-label", s(labelKey)));
			reactCells.set(kind, { btn, count });
			reactWrap.appendChild(btn);
		}
		wrap.appendChild(reactWrap);
	}

	const setReactions = (
		totals: Record<string, number>,
		mine: string[],
	): void => {
		const mineSet = new Set(mine);
		for (const [kind, cell] of reactCells) {
			cell.count.textContent = String(totals[kind] ?? 0);
			const isMine = mineSet.has(kind);
			if (isMine) cell.btn.dataset.mine = "1";
			else delete cell.btn.dataset.mine;
			cell.btn.setAttribute("aria-pressed", isMine ? "true" : "false");
		}
	};

	const toggleReaction = async (
		kind: string,
		cell: { btn: HTMLButtonElement; count: HTMLElement },
	): Promise<void> => {
		cell.btn.disabled = true;
		try {
			const res = await fetch(
				apiUrl(ctx.apiBase, "/api/v1/page-engagement/reactions"),
				{
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ slug: ctx.slug, kind }),
				},
			);
			if (!res.ok) return;
			const body = (await res.json()) as {
				added: boolean;
				reactions: Record<string, number>;
			};
			for (const [k, c] of reactCells) {
				c.count.textContent = String(body.reactions[k] ?? 0);
			}
			if (body.added) cell.btn.dataset.mine = "1";
			else delete cell.btn.dataset.mine;
			cell.btn.setAttribute("aria-pressed", body.added ? "true" : "false");
		} catch {
			// leave UI as-is; user can retry
		} finally {
			cell.btn.disabled = false;
		}
	};

	for (const [kind, cell] of reactCells) {
		cell.btn.addEventListener("click", () => void toggleReaction(kind, cell));
	}

	// --- vote tally ---
	let up: HTMLButtonElement | null = null;
	let down: HTMLButtonElement | null = null;
	let scoreEl: HTMLElement | null = null;
	let myVote: -1 | 0 | 1 = 0;

	const setVote = (s: PageVoteState): void => {
		myVote = s.my_vote;
		if (scoreEl) scoreEl.textContent = String(s.score_up - s.score_down);
		if (up) {
			if (myVote === 1) up.dataset.mine = "1";
			else delete up.dataset.mine;
		}
		if (down) {
			if (myVote === -1) down.dataset.mine = "1";
			else delete down.dataset.mine;
		}
	};

	const castVote = async (value: -1 | 0 | 1): Promise<void> => {
		if (!up || !down) return;
		up.disabled = true;
		down.disabled = true;
		try {
			const res = await fetch(apiUrl(ctx.apiBase, "/api/v1/page-engagement/votes"), {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ slug: ctx.slug, value }),
			});
			if (!res.ok) return;
			setVote((await res.json()) as PageVoteState);
		} catch {
			// leave UI as-is
		} finally {
			up.disabled = false;
			down.disabled = false;
		}
	};

	if (ctx.pageVotesEnabled) {
		const voteWrap = el("div", "gr-page-votes");
		const label = el("span", "gr-page-vote-label", s("w.page.helpful"));
		up = el("button", "gr-vote");
		up.type = "button";
		up.setAttribute("aria-label", s("w.page.up"));
		up.appendChild(document.createTextNode("▲"));
		scoreEl = el("span", "gr-vote-score", "0");
		down = el("button", "gr-vote");
		down.type = "button";
		down.setAttribute("aria-label", s("w.page.down"));
		down.appendChild(document.createTextNode("▼"));
		if (!ctx.downvotesEnabled) down.hidden = true;
		up.addEventListener("click", () => void castVote(myVote === 1 ? 0 : 1));
		down.addEventListener("click", () => void castVote(myVote === -1 ? 0 : -1));
		voteWrap.append(label, up, scoreEl, down);
		wrap.appendChild(voteWrap);
	}

	// Populate initial state. Anonymous viewers get totals only (their own
	// state appears after they first interact) — matches the GET endpoint.
	const apply = (body: EngagementSection): void => {
		if (body.reactions) setReactions(body.reactions, body.my_reactions ?? []);
		if (body.votes) setVote(body.votes);
	};
	// The mount's bootstrap call already carried this, so the seed is the normal
	// path and the GET below only runs on the legacy fallback. This bar exists
	// only when a page_* flag is on, which is the same condition bootstrap emits
	// `engagement` under, so a bootstrapped mount always has a seed to apply.
	if (ctx.seed.bootstrapped) {
		if (ctx.seed.engagement) apply(ctx.seed.engagement);
	} else {
		void (async () => {
			try {
				const res = await fetch(
					apiUrl(
						ctx.apiBase,
						`/api/v1/page-engagement?slug=${encodeURIComponent(ctx.slug)}`,
					),
					{ credentials: "include" },
				);
				if (!res.ok) return;
				apply((await res.json()) as EngagementSection);
			} catch {
				// initial counts stay at 0; interaction still works
			}
		})();
	}

	return wrap;
};

/**
 * Subscribe-to-thread bell for the thread toolbar.
 *
 * Until this existed, the only way to subscribe was the composer's notify
 * checkbox — so a reader who wanted replies by email but had nothing to say
 * could not subscribe at all. No new endpoint: `POST /api/v1/subscribe` already
 * accepts a standalone `{post_slug, email?}` with double opt-in, a per-address
 * pending cap and a global send budget.
 *
 * **Two bells, and which one you get is a security decision.**
 *
 * *Anonymous* (and signed-in-with-no-address, below): an action, never a state
 * toggle. `POST /api/v1/subscribe` deliberately returns a constant shape for a
 * caller who has not proved they own the inbox, because mirroring the stored
 * `confirmed_at` would make it a subscription oracle — an unauthenticated prober
 * could learn "this address already follows this post", from a branch that sends
 * no mail, so the victim would never see it. A bell that rendered
 * subscribed-vs-not would have to ask that question. So on this path: no state
 * query, no localStorage marker, and no unsubscribe (that stays token-based via
 * the emailed link). Repeat clicks are fine by design — the upsert is
 * non-destructive and refunds send budget when no mail actually goes out.
 *
 * *Session with a provider-verified address*: a real toggle, whose mount state
 * arrives in the bootstrap payload (`GET /api/v1/subscribe/mine?post_slug=` on
 * the legacy path) and which cancels through
 * `DELETE /api/v1/subscribe/mine/:id`. There is no oracle to leak here, because
 * the only address in play is one the session already proved it owns — the
 * question "does this address follow this post" is being asked by the address.
 *
 * The branch is on `sessionEmail`, **not** on "is signed in". An X/Twitter
 * reader is signed in and has no address at all (their v2 API exposes none under
 * our scopes), so a session-shaped bell would post no address, take a 400 on
 * every click, and read back as never-subscribed no matter what. They get the
 * anonymous bell, which works.
 */
const buildSubscribeBell = (
	apiBase: string,
	slug: string,
	sessionEmail: string | null,
	seed: MountSeed,
): HTMLElement => {
	// The whole managed/unmanaged split in one flag. `sessionEmail` itself is
	// never sent — the server reads the address off the session — but its
	// presence is what says the server *can*.
	const managed = sessionEmail != null;
	const wrap = el("div", "gr-subscribe");
	const btn = el("button", "gr-subscribe-btn");
	btn.type = "button";
	const glyph = el("span", "gr-reaction-emoji", "🔔");
	btn.appendChild(glyph);
	// Announce the outcome: the click's only visible result is this text, and a
	// reader on a screen reader would otherwise get nothing back at all.
	//
	// It has to be a `statusBox`, not a hidden span promoted to a live region on
	// use. A `hidden` element is outside the accessibility tree, so filling it and
	// revealing it in the same task is not a mutation of a live region — it is a
	// region appearing already-populated, which announces nothing. The box stays
	// in the tree from mount and CSS collapses it while it is `:empty`, exactly as
	// the composer's status box does.
	const status = statusBox("gr-subscribe-status");

	const say = (msg: string): void => {
		status.textContent = msg;
	};

	// Managed-path state. `subId` is both the flag and the handle: non-null means
	// this reader follows the thread *and* holds the id `DELETE /mine/:id` needs.
	// `pending` is the un-confirmed half — a row exists, but no mail flows until
	// the reader clicks the link, so the bell is honestly neither lit nor unlit.
	let subId: string | null = null;
	let pending = false;

	const renderBell = (): void => {
		const label = subId
			? s(pending ? "w.subscribe.awaiting" : "w.unsubscribe")
			: s("w.subscribe");
		btn.setAttribute("aria-label", label);
		btn.title = label;
		glyph.textContent = subId && !pending ? "🔕" : "🔔";
		btn.classList.toggle("gr-subscribe-pending", pending);
		// A toggle on the managed path, a disclosure on the anonymous one (set
		// below). Never both — they describe different controls.
		if (managed) btn.setAttribute("aria-pressed", String(subId != null));
	};

	// Anonymous readers need to supply an address; a signed-in reader's comes
	// from the session (and auto-confirms when the provider vouched for it), so
	// asking would be a worse experience *and* would let them subscribe an inbox
	// that isn't theirs. Declared before `send` because `send` hides it on
	// success.
	const form = el("form", "gr-subscribe-form");
	form.hidden = true;
	const emailInput = el("input") as HTMLInputElement;
	// Assigned only on the anonymous path: the signed-in bell posts straight from
	// its own click and never builds a form, so `setBusy` has to tolerate null.
	let submit: HTMLButtonElement | null = null;

	// Disabling the bell alone left the form wide open — the submit button and the
	// Enter key inside the input both reach `send` without going near the bell. So
	// disable whichever control is actually live. Disabling the submit button also
	// suppresses implicit submission, which is what closes the Enter-key path.
	const setBusy = (busy: boolean): void => {
		btn.disabled = busy;
		if (submit) submit.disabled = busy;
	};

	// One flag for every write below — subscribe, cancel-from-the-bell and
	// cancel-from-a-row — rather than one per control, because the bell and a
	// panel row can act on the same subscription.
	let inFlight = false;

	/**
	 * The manage disclosure: everything this address follows, not just this
	 * thread. Managed readers only — an address the session hasn't proved is an
	 * address whose list it has no business being handed.
	 *
	 * Lazy on purpose. The bell's own state read fires on every widget mount, but
	 * this one only ever fires for a reader who asked, which is rare enough that
	 * loading it up front would be pure waste on every page view.
	 */
	const panel = el("div", "gr-subscribe-panel");
	panel.hidden = true;
	const manageBtn = el("button", "gr-subscribe-manage", s("w.manage"));
	manageBtn.type = "button";
	manageBtn.setAttribute("aria-expanded", "false");
	let panelLoaded = false;

	const applyState = (body: SubscriptionSection): void => {
		// Both halves or neither: a `subscribed` with no id is a server too old
		// to have sent one, and a toggle with no id to cancel is a button that
		// lies. Falling back to the unlit bell leaves subscribing working.
		subId = body.subscribed && body.id ? body.id : null;
		pending = subId != null && body.pending === true;
		renderBell();
	};

	const loadState = async (): Promise<void> => {
		try {
			const res = await fetch(
				apiUrl(
					apiBase,
					`/api/v1/subscribe/mine?post_slug=${encodeURIComponent(slug)}`,
				),
				{ credentials: "include" },
			);
			if (!res.ok) return;
			applyState((await res.json()) as SubscriptionSection);
		} catch {
			// Fail soft, matching the reactions block: the bell stays unlit and
			// subscribing still works, which is exactly what it did before it had
			// any state to read. An unreachable /mine must not cost the reader the
			// control itself.
		}
	};

	const cancel = async (id: string): Promise<boolean> => {
		if (inFlight) return false;
		inFlight = true;
		setBusy(true);
		try {
			const res = await fetch(
				apiUrl(apiBase, `/api/v1/subscribe/mine/${encodeURIComponent(id)}`),
				{ method: "DELETE", credentials: "include" },
			);
			if (!res.ok) {
				say(
					res.status === 429
						? s("w.subscribe.ratelimit")
						: s("w.unsubscribe.failed"),
				);
				return false;
			}
			say(s("w.unsubscribe.done"));
			// The bell tracks this thread; a row cancelled from the panel may be it.
			if (subId === id) {
				subId = null;
				pending = false;
				renderBell();
			}
			return true;
		} catch {
			say(s("w.unsubscribe.failed"));
			return false;
		} finally {
			inFlight = false;
			setBusy(false);
		}
	};

	type PanelRow = { id: string; post_slug: string; title: string | null };

	const renderPanel = (rows: PanelRow[]): void => {
		panel.textContent = "";
		if (rows.length === 0) {
			panel.appendChild(el("p", "gr-subscribe-empty", s("w.manage.empty")));
			return;
		}
		const ul = el("ul", "gr-subscribe-list");
		for (const row of rows) {
			const li = el("li");
			// `title` is null until the host page has told the server one, so the
			// slug is the honest fallback — a row with no label is a row the reader
			// cannot tell apart from the next one.
			li.appendChild(el("span", "gr-subscribe-title", row.title || row.post_slug));
			const drop = el("button", "gr-subscribe-drop", s("w.unsubscribe.row"));
			drop.type = "button";
			drop.addEventListener("click", () => {
				drop.disabled = true;
				void cancel(row.id).then((ok) => {
					if (!ok) {
						drop.disabled = false;
						return;
					}
					li.remove();
					if (!ul.firstChild) renderPanel([]);
				});
			});
			li.appendChild(drop);
			ul.appendChild(li);
		}
		panel.appendChild(ul);
	};

	const loadPanel = async (): Promise<void> => {
		panelLoaded = true;
		try {
			const res = await fetch(apiUrl(apiBase, "/api/v1/subscribe/mine"), {
				credentials: "include",
			});
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { subscriptions?: PanelRow[] };
			renderPanel(body.subscriptions ?? []);
		} catch {
			// Not sticky: clearing the flag lets a second open retry, which is the
			// only recovery a reader has for a blip.
			panelLoaded = false;
			panel.textContent = "";
			panel.appendChild(el("p", "gr-subscribe-empty", s("w.manage.failed")));
		}
	};

	// A write from either control invalidates the list. Re-fetching rather than
	// splicing keeps one source of truth — the panel can be stale for reasons
	// this tab never saw (another tab, an emailed unsubscribe link).
	const invalidatePanel = (): void => {
		panelLoaded = false;
		if (!panel.hidden) void loadPanel();
	};

	manageBtn.addEventListener("click", () => {
		panel.hidden = !panel.hidden;
		manageBtn.setAttribute("aria-expanded", String(!panel.hidden));
		if (!panel.hidden && !panelLoaded) void loadPanel();
	});

	// `message` is already localized by the server (it negotiates from ?lang=).
	// Rendered via textContent — as every server string in this widget is — so a
	// future message containing markup is text, not markup.
	const send = async (email: string): Promise<void> => {
		// The disabled attributes are the affordance; this flag is the guarantee.
		// A subscribe POST costs the operator send budget and the reader a
		// duplicate email, so it is worth being certain rather than trusting that
		// no path can re-enter while a request is open.
		if (inFlight) return;
		inFlight = true;
		setBusy(true);
		try {
			const res = await fetch(apiUrl(apiBase, "/api/v1/subscribe"), {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(email ? { post_slug: slug, email } : { post_slug: slug }),
			});
			const body = (await res.json().catch(() => null)) as {
				message?: string;
			} | null;
			if (!res.ok) {
				// A rate limit is the one failure where "try again" is actively bad
				// advice: the retry cannot succeed and each one pushes the window
				// further out. Every other status keeps the generic message, which
				// is honest — the widget cannot tell a bad address from an outage.
				//
				// Deliberately not rendering `body.error`: on some paths the server
				// puts localized prose there, on others a machine code
				// ("invalid_email"), and there is no way to tell them apart from
				// here. Only `message`, on success, is contracted to be prose.
				say(res.status === 429 ? s("w.subscribe.ratelimit") : s("w.subscribe.failed"));
				return;
			}
			say(body?.message ?? s("w.subscribe.done"));
			if (managed) {
				// Re-read rather than assume. The POST deliberately returns no
				// subscription id (it would tell a caller who may not own the address
				// *when* it subscribed), and only the re-read settles
				// pending-vs-confirmed honestly — a provider-verified address
				// auto-confirms and never gets a confirmation mail at all.
				await loadState();
				invalidatePanel();
			} else {
				form.hidden = true;
				btn.hidden = true;
			}
		} catch {
			say(s("w.subscribe.failed"));
		} finally {
			inFlight = false;
			setBusy(false);
		}
	};

	if (!managed) {
		emailInput.className = "gr-email-input";
		emailInput.type = "email";
		emailInput.required = true;
		emailInput.placeholder = s("w.email_ph");
		emailInput.autocomplete = "email";
		submit = el("button", "gr-subscribe-submit", s("w.subscribe.submit"));
		submit.type = "submit";
		form.append(emailInput, submit);
		// Only on this path is the bell a disclosure — managed, it is a toggle and
		// carries aria-pressed instead. Safe to expose: this says whether the email
		// field is showing, never whether the reader is subscribed, which is the
		// one thing the endpoint refuses to reveal.
		btn.setAttribute("aria-expanded", "false");
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const email = emailInput.value.trim();
			if (email) void send(email);
		});
	}

	btn.addEventListener("click", () => {
		if (managed) {
			// Read `subId` at click time, not at bind time: the panel, a cancel, and
			// the post-subscribe re-read all move it underneath this handler.
			const id = subId;
			if (id) {
				void cancel(id).then((ok) => {
					if (ok) invalidatePanel();
				});
			} else {
				void send("");
			}
			return;
		}
		form.hidden = !form.hidden;
		btn.setAttribute("aria-expanded", String(!form.hidden));
		if (!form.hidden) emailInput.focus();
	});

	renderBell();
	wrap.append(btn);
	if (managed) wrap.append(manageBtn);
	wrap.append(form, status);
	if (managed) {
		wrap.append(panel);
		// Seeded from the mount request when there was one. An omitted section on a
		// bootstrapped mount is an answer — see MountSeed — so the bell stays unlit
		// rather than spending a request to be told so.
		if (seed.bootstrapped) {
			if (seed.subscription) applyState(seed.subscription);
		} else {
			void loadState();
		}
	}
	return wrap;
};

const buildActions = (n: TreeNode, ctx: WidgetCtx, main: HTMLElement): HTMLElement => {
	const row = el("div", "gr-actions");

	// `can_reply` is server-computed from the real stored depth. Past the flatten
	// threshold every node reports depth 4, so the old `n.depth < 4` test dead-ended
	// threads four levels before the server actually stops accepting replies — it
	// survives only as the fallback for edge-cached payloads that predate the field.
	const canReply = n.can_reply ?? n.depth < 4;
	if (ctx.acceptingComments && canReply && n.status !== "deleted") {
		const replyBtn = el("button", undefined, s("w.reply"));
		replyBtn.type = "button";
		replyBtn.addEventListener("click", () => {
			// Editor forms share the `gr-reply-form` class (and styling) but tag
			// themselves with `data-mode="edit"` — narrow the guard so an open
			// editor doesn't silently swallow Reply clicks.
			if (main.querySelector('.gr-reply-form:not([data-mode="edit"])')) {
				return;
			}
			main.appendChild(buildReplyForm(n, ctx));
		});
		row.appendChild(replyBtn);
	}

	const isOwn =
		ctx.me != null && n.author.id === ctx.me.id && n.status !== "deleted";
	const withinWindow = Date.now() - n.created_at < ctx.editWindowMs;
	if (isOwn && withinWindow) {
		const editBtn = el("button", undefined, s("w.edit"));
		editBtn.type = "button";
		editBtn.addEventListener("click", () => {
			openEditor(n, ctx, main);
		});
		row.appendChild(editBtn);
	}
	if (isOwn) {
		const delBtn = el("button", undefined, s("w.delete"));
		delBtn.type = "button";
		delBtn.addEventListener("click", () => {
			// Two steps in place, not window.confirm(). A native dialog is
			// unstyleable, says the *page's* origin rather than the site's name,
			// and is suppressed outright in some webviews and in cross-origin
			// iframes with no user-activation — where the old code silently did
			// nothing at all. This is the same in-place replacement the Report
			// button already does, so it needs no modal layer.
			const confirmWrap = el("span", "gr-confirm");
			const yes = el("button", "gr-confirm-yes", s("w.delete"));
			yes.type = "button";
			const no = el("button", undefined, s("w.cancel"));
			no.type = "button";
			confirmWrap.append(el("span", undefined, s("w.delete_confirm")), yes, no);
			delBtn.replaceWith(confirmWrap);
			// Replacing the focused button drops focus to <body>, stranding a
			// keyboard user mid-thread. Land on Cancel: for a destructive action
			// the safe option is the one a stray Enter should hit.
			no.focus();

			const dismiss = (): void => {
				confirmWrap.replaceWith(delBtn);
				delBtn.focus();
			};
			no.addEventListener("click", dismiss);
			confirmWrap.addEventListener("keydown", (e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				dismiss();
			});

			yes.addEventListener("click", async () => {
				yes.disabled = true;
				no.disabled = true;
				try {
					const res = await fetch(
						apiUrl(ctx.apiBase, `/api/v1/comments/${encodeURIComponent(n.id)}`),
						{ method: "DELETE", credentials: "include" },
					);
					if (res.ok) {
						ctx.reload();
						return;
					}
				} catch {
					// Network failure — same handling as a refusal below.
				}
				// The delete did not happen, so do not leave the row looking like
				// it is mid-flight. Back out to the button the reader started
				// from; a second attempt is one click away.
				dismiss();
			});
		});
		row.appendChild(delBtn);
	}

	// Report: any reader can flag a visible comment they didn't write. It's
	// independent of whether the thread accepts new comments (you can still
	// report on a closed thread) and of sign-in (the endpoint allows anon,
	// rate-limited + deduped server-side). Hidden on deleted comments and on
	// the viewer's own (reporting yourself is meaningless).
	const isOwnComment = ctx.me != null && n.author.id === ctx.me.id;
	if (n.status !== "deleted" && !isOwnComment) {
		const reportBtn = el("button", "gr-report", s("w.report"));
		reportBtn.type = "button";
		reportBtn.addEventListener("click", async () => {
			reportBtn.disabled = true;
			let ok = false;
			try {
				// The endpoint returns 200 for both new and duplicate reports and
				// never discloses which (anti-enumeration), so a 2xx is the only
				// success signal we get — and the only one we need. fetch does NOT
				// reject on a 4xx/5xx, so we must inspect res.ok explicitly.
				const res = await fetch(
					apiUrl(
						ctx.apiBase,
						`/api/v1/comments/${encodeURIComponent(n.id)}/report`,
					),
					{
						method: "POST",
						credentials: "include",
						headers: { "content-type": "application/json" },
						body: "{}",
					},
				);
				ok = res.ok;
			} catch {
				// Network failure — fall through to the retry path below.
			}
			if (ok) {
				// Replace the button with a non-interactive confirmation so a
				// reader can't report-bomb one comment from the UI. (Server-side
				// dedup + rate-limit are the real guard; this is just UX.)
				reportBtn.replaceWith(el("span", "gr-reported", s("w.reported")));
			} else {
				// A real refusal (429 rate-limit, 4xx/5xx, or a dropped network
				// call) — don't claim success; re-enable so the reader can retry.
				reportBtn.disabled = false;
			}
		});
		row.appendChild(reportBtn);
	}

	return row;
};

const openEditor = (n: TreeNode, ctx: WidgetCtx, main: HTMLElement): void => {
	// Symmetric to the Reply-button guard: only one editor at a time on a
	// given comment. Reply forms (no data-mode) may coexist alongside.
	if (main.querySelector('.gr-reply-form[data-mode="edit"]')) return;
	const bodyEl = main.querySelector(".gr-body");
	if (!bodyEl) return;
	const wrap = el("form", "gr-reply-form");
	wrap.setAttribute("data-mode", "edit");
	const ta = el("textarea");
	ta.value = "";
	ta.placeholder = s("w.loading");
	ta.required = true;
	const actions = el("div", "gr-reply-actions");
	const save = el("button", undefined, s("w.save"));
	save.type = "submit";
	const cancel = el("button", undefined, s("w.cancel"));
	cancel.type = "button";
	// One dismissal path for the button and for Escape. An abandoned edit keeps
	// nothing: the original body is still on the node, and the box was never a
	// draft surface (attachDraft is only on the reply and top-level composers).
	const dismiss = (): void => wrap.remove();
	cancel.addEventListener("click", dismiss);
	bindComposerKeys(wrap, dismiss);
	actions.append(save, cancel);

	// Prefill with the original markdown source. The tree payload only carries
	// body_html, so we fetch body_md on demand from the author-only source
	// endpoint (same author + edit-window gate as the PATCH). Disable both the
	// field and Save while it loads so the author can't type over content that's
	// about to be replaced, nor submit an empty body before the prefill lands;
	// re-enable and focus once it arrives.
	ta.disabled = true;
	save.disabled = true;
	fetch(
		`${ctx.apiBase}/api/v1/comments/${encodeURIComponent(n.id)}/source`,
		{ credentials: "include" },
	)
		.then((res) => (res.ok ? res.json() : null))
		.then((data: { body_md?: string } | null) => {
			if (data && typeof data.body_md === "string") ta.value = data.body_md;
		})
		.catch(() => {})
		.finally(() => {
			// The author may have hit Cancel before the fetch resolved.
			if (!ta.isConnected) return;
			ta.disabled = false;
			save.disabled = false;
			ta.placeholder = s("w.edit_ph");
			// The whole point of issue #52: the box opens showing the comment, not
			// a 3-line window onto it. Has to run here, after the prefill lands.
			autoSize(ta);
			ta.focus();
		});
	wrap.append(buildWritePreview(ta, ctx.apiBase, true), actions);
	wrap.addEventListener("submit", async (e) => {
		e.preventDefault();
		save.disabled = true;
		try {
			const res = await fetch(
				apiUrl(ctx.apiBase, `/api/v1/comments/${encodeURIComponent(n.id)}`),
				{
					method: "PATCH",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ body: ta.value }),
				},
			);
			if (res.ok) ctx.reload();
			else save.disabled = false;
		} catch {
			save.disabled = false;
		}
	});
	bodyEl.insertAdjacentElement("afterend", wrap);
};

const buildReplyForm = (parent: TreeNode, ctx: WidgetCtx): HTMLElement => {
	// Mint the timing token now so the honeypot-timing heuristic has
	// real elapsed seconds to measure when the user eventually submits.
	prefetchFormToken(ctx.apiBase);
	const wrap = el("form", "gr-reply-form");
	const ta = el("textarea");
	ta.placeholder = s("w.reply_ph", { name: parent.author.name });
	ta.required = true;
	const dkey = attachDraft(ta, draftKey(ctx.slug, parent.id));

	let nameInput: HTMLInputElement | null = null;
	if (!ctx.me) {
		nameInput = el("input");
		nameInput.type = "text";
		nameInput.placeholder = s("w.name_ph");
		nameInput.required = true;
		wrap.appendChild(nameInput);
	}
	wrap.appendChild(buildWritePreview(ta, ctx.apiBase, true));

	// Honeypot: mirrors the top-level form's anti-spam input. Hidden offscreen
	// via .gr-honeypot, readonly to defeat browser autofill, tabIndex -1 so
	// keyboard users skip it. Browser-driven bots that fill every visible
	// input still get caught by the server's "website non-empty → reject"
	// check; without this input, the reply surface had no such signal.
	const honey = el("input");
	honey.className = "gr-honeypot";
	honey.name = "website";
	honey.type = "text";
	honey.tabIndex = -1;
	honey.setAttribute("aria-hidden", "true");
	honey.autocomplete = "off";
	honey.readOnly = true;
	wrap.appendChild(honey);

	// Placeholder for the Turnstile iframe. The mount is deferred until
	// after `submit` and `errBox` exist so the error-callback closure can
	// disable/notify them; we just reserve the DOM slot here.
	const tsSlot =
		ctx.turnstileSiteKey && (!ctx.me || ctx.turnstileAlways)
			? el("div", "gr-turnstile")
			: null;
	if (tsSlot) wrap.appendChild(tsSlot);

	const actions = el("div", "gr-reply-actions");
	const submit = el("button", undefined, s("w.post_reply"));
	submit.type = "submit";
	const cancel = el("button", undefined, s("w.cancel"));
	cancel.type = "button";
	actions.append(submit, cancel);
	wrap.appendChild(actions);

	const errBox = statusBox("gr-error is-inline");
	wrap.appendChild(errBox);

	// Mount Turnstile inside its same-origin iframe (see mountTurnstileFrame
	// docs) so api.js's parent-chain fingerprinter never crosses our Shadow
	// DOM boundary. Cleanup tracks the wrap's removal from the DOM (cancel
	// button, reply submit success, reload) so the global message listener
	// doesn't accumulate across the page lifetime.
	let tsHandle: TurnstileFrameHandle | null = null;
	let tsGate: TurnstileGate | null = null;
	if (tsSlot) {
		// Unlike the top-level composer, this mounts eagerly: opening a reply form
		// *is* the intent signal, so there is nothing left to defer. The gate is
		// here for the other half of its job — letting submit wait for a token
		// that hasn't arrived yet.
		tsGate = createTurnstileGate({
			mount: () => {
				tsHandle = mountTurnstileFrame(tsSlot, ctx.apiBase, {
					onToken: (token) => tsGate?.token(token),
					onExpired: () => tsGate?.signal("expired"),
					onError: (code) => tsGate?.signal("error", code),
					onReady: () => tsGate?.signal("ready"),
					onInteractive: () => tsGate?.signal("interactive"),
				});
			},
			// Turnstile said to retry, and the gate has budget for it. Re-arm the
			// challenge and leave everything else alone: the composer stays usable
			// and no message is written, so a blip nobody was waiting on heals
			// without the visitor ever seeing it.
			onRetry: () => tsHandle?.reset(),
			onFailed: () => {
				tsSlot.hidden = true;
				submit.disabled = true;
				showStatus(
					errBox,
					s("w.ts.failed"),
				);
			},
		});
		tsGate.arm();
		const cleanupObserver = new MutationObserver(() => {
			if (!wrap.isConnected) {
				tsGate?.dispose();
				tsHandle?.destroy();
				cleanupObserver.disconnect();
			}
		});
		queueMicrotask(() => {
			if (wrap.parentNode) {
				cleanupObserver.observe(wrap.parentNode, { childList: true });
			}
		});
	}

	// Escape and the Cancel button are the same act, so they run the same
	// teardown — dropping the draft, disposing the Turnstile gate and removing
	// the form. An Escape that only hid the box would leak the gate's global
	// message listener for the rest of the page's life.
	const dismiss = (): void => {
		clearDraft(dkey);
		tsGate?.dispose();
		tsHandle?.destroy();
		wrap.remove();
	};
	cancel.addEventListener("click", dismiss);
	bindComposerKeys(wrap, dismiss);

	// Same precedence as the top-level composer: the Turnstile failure message
	// is sticky, so nothing here overwrites it or hands the button back.
	const notice = (message: string): void => {
		if (tsGate?.failed) return;
		showStatus(errBox, message, "notice");
		submit.disabled = false;
	};

	wrap.addEventListener("submit", async (e) => {
		e.preventDefault();
		submit.disabled = true;
		if (!tsGate?.failed) clearStatus(errBox);

		// Turnstile needs a moment even when it mounted with the form: a reply
		// posted within about a second of opening the box used to send an empty
		// token, which the API rejects outright.
		let waitedToken = "";
		if (tsGate) {
			const label = submit.textContent ?? "";
			submit.textContent = s("w.ts.checking");
			const waited = await tsGate.wait();
			submit.textContent = label;
			if (!waited.ok) {
				switch (waited.reason) {
					case "interactive":
						notice(s("w.ts.interactive"));
						return;
					case "timeout":
						notice(s("w.ts.timeout"));
						return;
					case "retrying":
						// Recoverable by construction: the gate has already asked the
						// frame to re-challenge, so the next attempt has a real chance.
						notice(s("w.ts.retrying"));
						return;
					case "failed":
						// onFailed already wrote the message and disabled the button.
						return;
				}
			}
			waitedToken = waited.token;
		}

		try {
			const formTs = await getFormToken(ctx.apiBase);
			// Read the live input last, preferring it over the resolved token in
			// case Turnstile refreshed in between, and never post an empty one.
			const turnstileToken =
				(wrap.querySelector(
					'input[name="cf-turnstile-response"]',
				) as HTMLInputElement | null)?.value ||
				waitedToken ||
				"";
			if (tsGate && !turnstileToken) {
				notice(s("w.ts.interactive"));
				return;
			}
			const res = await fetch(apiUrl(ctx.apiBase, "/api/v1/comments"), {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					slug: ctx.slug,
					name: nameInput?.value ?? "",
					body: ta.value,
					parent_id: parent.id,
					turnstile_token: turnstileToken,
					website: honey.value,
					form_ts: formTs,
					post_title: ctx.host.dataset.title ?? null,
					post_url: ctx.host.dataset.url ?? null,
				}),
			});
			const json = (await res.json()) as {
				error?: string;
				comment?: { status?: string };
			};
			if (!res.ok) {
				if (tsGate?.failed) return;
				showStatus(errBox, json.error ?? `HTTP ${res.status}`);
				submit.disabled = false;
				// Single-use once siteverify has seen it: re-challenge, and make the
				// next wait actually wait instead of replaying the spent token.
				tsHandle?.reset();
				tsGate?.clear();
				return;
			}
			// Reply landed — drop the saved draft before the list re-renders.
			clearDraft(dkey);
			// Pending replies reload like approved ones: the author's own
			// queued comment comes back from the list endpoint and renders
			// inline with a "Pending approval" badge.
			ctx.reload();
		} catch (err) {
			if (tsGate?.failed) return;
			showStatus(errBox, String(err));
			submit.disabled = false;
			tsHandle?.reset();
			tsGate?.clear();
		}
	});

	return wrap;
};

/**
 * Community auto-collapse (Reddit/HN "below threshold"). Purely cosmetic and
 * reversible: a heavily-downvoted comment's body is folded behind a toggle, the
 * content stays in the payload, and votes stay live so it can recover. Derived
 * client-side because votes deliberately don't bust the tree cache — a server
 * flag would be stale against the score the widget already shows. The
 * min-votes floor is the brigading guard (without it, 1 downvote = 100% would
 * fold every fresh comment).
 */
const shouldCollapseLowScore = (n: TreeNode, ctx: WidgetCtx): boolean => {
	if (!ctx.downvotesEnabled || ctx.communityCollapseRatio <= 0) return false;
	const total = n.score_up + n.score_down;
	if (total < ctx.communityMinVotes) return false;
	return (n.score_down / total) * 100 >= ctx.communityCollapseRatio;
};

const buildComment = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const row = el("div", "gr-comment");
	row.dataset.id = n.id;
	if (n.flatten_from) row.dataset.flat = "1";
	row.appendChild(buildAvatar(n.author));

	const main = el("div", "gr-main");

	const meta = el("div", "gr-meta");
	meta.appendChild(el("span", "gr-name", n.author.name));
	if (n.author.provider !== "anon") {
		meta.appendChild(el("span", "gr-verified", s("w.verified")));
	}
	meta.appendChild(buildTime(n.created_at));
	if (n.edited_at) meta.appendChild(el("span", "gr-edited", s("w.edited")));
	// Author-only signal: the list endpoint returns the viewer's own queued
	// comments, so this badge is only ever seen by the author themselves.
	if (n.status === "pending") {
		meta.appendChild(el("span", "gr-pending", s("w.pending")));
	}

	const body = el("div", "gr-body");
	if (n.status === "deleted") {
		const label = s(
			n.deleted_by === "moderator" ? "w.removed_by_mod" : "w.deleted",
		);
		const p = el("p", "gr-deleted", label);
		body.appendChild(p);
	} else {
		if (n.flatten_from) {
			// Visual hint that this reply was lifted out of a deeper level.
			const tag = el("span", "gr-flatten", `@${n.flatten_from} `);
			body.appendChild(tag);
		}
		// body_html is sanitized by src/lib/markdown.ts before storage.
		body.appendChild(parseTrustedHtml(n.body_html));
	}

	main.append(meta, body);

	// Community auto-collapse: fold a heavily-downvoted (approved) comment's
	// body behind a toggle. Reversible and cosmetic — the content is already in
	// the DOM, just hidden.
	if (n.status === "approved" && shouldCollapseLowScore(n, ctx)) {
		body.hidden = true;
		const toggle = el("button", "gr-low-score") as HTMLButtonElement;
		toggle.type = "button";
		let shown = false;
		const apply = () => {
			body.hidden = !shown;
			toggle.textContent = s(shown ? "w.lowscore.hide" : "w.lowscore.show");
			toggle.setAttribute("aria-expanded", String(shown));
		};
		toggle.addEventListener("click", () => {
			shown = !shown;
			apply();
		});
		apply();
		body.insertAdjacentElement("beforebegin", toggle);
	}

	// Votes/reactions only on public (approved) comments — a pending comment
	// isn't visible to anyone but its author, so engagement is meaningless.
	if (n.status === "approved") {
		if (ctx.votingEnabled) main.appendChild(buildVotes(n, ctx));
		if (ctx.reactionsEnabled) main.appendChild(buildReactions(n, ctx));
	}
	main.appendChild(buildActions(n, ctx, main));

	row.appendChild(main);
	return row;
};

/** Total nested replies under a node (whole subtree), for the toggle label. */
const countDescendants = (n: TreeNode): number => {
	let total = n.replies.length;
	for (const r of n.replies) total += countDescendants(r);
	return total;
};

/**
 * Collapse/expand control for a node's replies. Hides/shows the replies
 * container in place (all replies are already in the DOM). `startCollapsed`
 * comes from the auto-collapse-depth setting.
 */
const buildCollapseToggle = (
	repliesEl: HTMLElement,
	count: number,
	startCollapsed: boolean,
): HTMLButtonElement => {
	const btn = el("button", "gr-collapse") as HTMLButtonElement;
	btn.type = "button";
	let collapsed = startCollapsed;
	const apply = () => {
		repliesEl.style.display = collapsed ? "none" : "";
		// The disclosure triangle is a glyph, not a word, so it stays outside the
		// string — the count and its noun do not.
		btn.textContent = `${collapsed ? "▸" : "▾"} ${s("w.replies", { n: count })}`;
		btn.setAttribute("aria-expanded", String(!collapsed));
	};
	btn.addEventListener("click", () => {
		collapsed = !collapsed;
		apply();
	});
	apply();
	return btn;
};

/**
 * Render a parent's direct replies into `container`, capping at
 * repliesPerThread and appending a "Show N more replies" button for the rest
 * (0 = show all). The cap applies recursively as each reply is itself a thread.
 */
const renderReplyList = (
	container: HTMLElement,
	replies: TreeNode[],
	ctx: WidgetCtx,
): void => {
	const limit = ctx.repliesPerThread;
	const initial = limit > 0 && replies.length > limit ? limit : replies.length;
	for (let i = 0; i < initial; i++) {
		container.appendChild(buildThread(replies[i]!, ctx));
	}
	if (initial < replies.length) {
		const hidden = replies.slice(initial);
		const more = el("button", "gr-showmore") as HTMLButtonElement;
		more.type = "button";
		more.textContent = s("w.more_replies", { n: hidden.length });
		more.addEventListener("click", () => {
			for (const r of hidden) {
				container.insertBefore(buildThread(r, ctx), more);
			}
			more.remove();
		});
		container.appendChild(more);
	}
};

const buildThread = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-thread");
	wrap.dataset.id = n.id;
	// Anchor id for the /c/:id permalink redirect to scroll into view.
	wrap.id = `garrul-comment-${n.id}`;
	wrap.appendChild(buildComment(n, ctx));
	if (n.replies.length > 0) {
		const replies = el("div", "gr-replies");
		renderReplyList(replies, n.replies, ctx);
		// Per-comment collapse toggle; auto-collapsed when this node is nested
		// at/deeper than the configured depth (0 = never auto-collapse).
		const startCollapsed =
			ctx.autoCollapseDepth > 0 && n.depth >= ctx.autoCollapseDepth;
		const toggle = buildCollapseToggle(
			replies,
			countDescendants(n),
			startCollapsed,
		);
		wrap.append(toggle, replies);
	}
	return wrap;
};

// Mirror of src/lib/oauth.ts ProviderId. The widget is bundled separately
// (no server imports) so the union is duplicated here. The server's
// /api/v1/config derives the provider list from PROVIDERS + env presence
// (see src/routes/api.config.ts); PROVIDER_LABELS is the widget-side set of
// ids it knows how to render, and the widget filters the /config response
// against it so an unknown id can never reach the button renderer.
type OAuthProvider = "github" | "google" | "facebook" | "twitter" | "discord";

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
	github: "GitHub",
	google: "Google",
	facebook: "Facebook",
	twitter: "X",
	discord: "Discord",
};

const buildAuthBlock = (
	me: Me,
	apiBase: string,
	providers: ReadonlyArray<OAuthProvider>,
	onSignedIn: () => void,
	onSignedOut: () => void,
): HTMLElement | null => {
	if (me) {
		const wrap = el("div", "gr-signed");
		// The name renders in its own styled span, so the sentence is split around
		// the slot rather than cut into two half-sentences — a translator can move
		// {name} to wherever their language puts it and the styling follows.
		const [before, after] = sAround("w.posting_as", "name");
		if (before) wrap.appendChild(el("span", undefined, before));
		wrap.appendChild(el("span", "gr-signed-name", `@${me.name}`));
		if (after) wrap.appendChild(el("span", undefined, after));
		if (me.provider !== "anon") {
			wrap.appendChild(el("span", "gr-verified", s("w.verified")));
		}
		const out = el("button", undefined, s("w.sign_out"));
		out.type = "button";
		out.addEventListener("click", async () => {
			out.disabled = true;
			try {
				await fetch(apiUrl(apiBase, "/api/v1/auth/signout"), {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
			} catch {
				// signout is best-effort; the cookie clears server-side and
				// reload will pick up the new state regardless.
			}
			onSignedOut();
		});
		wrap.appendChild(out);
		return wrap;
	}

	// No OAuth providers configured on the server → no sign-in row at all.
	// Anonymous commenting still works via the regular form.
	if (providers.length === 0) return null;

	const wrap = el("div", "gr-signin");
	wrap.appendChild(
		el("span", "gr-signin-label", s("w.signin_prompt")),
	);
	for (const p of providers) {
		const btn = el("button", undefined, PROVIDER_LABELS[p]);
		btn.type = "button";
		btn.addEventListener("click", () => startOauth(p, apiBase, onSignedIn));
		wrap.appendChild(btn);
	}
	return wrap;
};

const buildForm = (
	apiBase: string,
	siteKey: string | null,
	signedIn: boolean,
	subscriptionsEnabled: boolean,
	// Separate from `signedIn` on purpose: it governs one branch, the notify
	// checkbox's email field. The name field keys off the session existing,
	// which is a different question.
	sessionEmail: string | null,
	// Operator opted into challenging signed-in commenters too, so the Turnstile
	// slot is no longer implied by `!signedIn` alone.
	turnstileAlways: boolean,
): HTMLFormElement => {
	const form = document.createElement("form");
	form.className = "gr-form";
	form.autocomplete = "off";

	if (!signedIn) {
		const name = el("input");
		name.className = "gr-name-input";
		name.name = "name";
		name.type = "text";
		name.placeholder = s("w.name_ph");
		name.required = true;
		form.appendChild(name);
	}

	const body = el("textarea");
	body.className = "gr-body-input";
	body.name = "body";
	body.placeholder = s("w.body_ph");
	body.required = true;
	form.appendChild(buildWritePreview(body, apiBase));

	const honey = el("input");
	honey.className = "gr-honeypot";
	honey.name = "website";
	honey.type = "text";
	honey.tabIndex = -1;
	honey.setAttribute("aria-hidden", "true");
	honey.autocomplete = "off";
	// `readonly` makes browser autofill / password managers skip the field
	// (they universally ignore readonly inputs). Naive form-spam bots that
	// POST the form body directly still submit values for it, so the trap
	// still fires — `autocomplete="off"` alone isn't honored by most fillers.
	honey.readOnly = true;
	form.appendChild(honey);

	// Notify-me opt-in. No address on the session: an email field appears
	// alongside the checkbox. With one: just the box, since we already have it.
	//
	// Skipped entirely on an install with no outbound mail configured. The
	// endpoint 503s there, so the checkbox was an opt-in that could never
	// deliver — the reader ticked it, posted, and simply never heard anything.
	// The submit handler reads the checkbox out of the DOM, so its absence is
	// also what stops the POST being attempted.
	if (subscriptionsEnabled) {
		const notifyWrap = el("label", "gr-notify");
		const notifyCb = el("input") as HTMLInputElement;
		notifyCb.type = "checkbox";
		notifyCb.className = "gr-notify-cb";
		notifyCb.name = "notify";
		// The leading space separates the label from its checkbox; it's layout, not
		// copy, so it stays out of the string table.
		const notifyText = document.createTextNode(` ${s("w.notify")}`);
		notifyWrap.append(notifyCb, notifyText);
		form.appendChild(notifyWrap);

		// `sessionEmail`, not `signedIn`. An X/Twitter reader is signed in with no
		// address at all, so the no-field branch posted `{post_slug}` with nothing
		// for the server to fall back to — a 400 on every tick, silently, since the
		// subscribe POST here is fire-and-forget.
		if (sessionEmail == null) {
			const emailInput = el("input") as HTMLInputElement;
			emailInput.className = "gr-email-input";
			emailInput.name = "email";
			emailInput.type = "email";
			emailInput.placeholder = s("w.email_ph");
			emailInput.autocomplete = "email";
			emailInput.hidden = true;
			notifyCb.addEventListener("change", () => {
				emailInput.hidden = !notifyCb.checked;
				emailInput.required = notifyCb.checked;
			});
			form.appendChild(emailInput);
		}
	}

	// Turnstile renders for anonymous posts, and for signed-in ones too when the
	// operator set `turnstile_always`. Otherwise a signed-in post skips the
	// challenge server-side, so don't include the widget either. This just
	// reserves the slot in the right spot relative to siblings; loadOnce wires
	// the gate that fills it on the visitor's first composer focus.
	//
	// Keep this immediately before the submit button. The mount grows the slot
	// from 0 to ~78px synchronously, so anything focusable *below* it would move
	// out from under the cursor between mousedown and mouseup and lose the
	// click. The focusin trigger excludes the submit button for exactly that
	// reason — moving the slot means revisiting that exclusion.
	if (siteKey && (!signedIn || turnstileAlways)) {
		form.appendChild(el("div", "gr-turnstile"));
	}

	const submit = el("button", undefined, s("w.post_comment"));
	submit.type = "submit";

	const errBox = statusBox("gr-error is-inline");

	form.append(submit, errBox);
	return form;
};

/**
 * Teardown for the in-flight sign-in attempt's recovery watcher, if any. A
 * reader who opens the GitHub popup, abandons it and clicks Google would
 * otherwise leave the first watcher armed: both would see the Google session
 * and each would fire a full widget reload.
 */
let stopPreviousRecovery: (() => void) | null = null;

const startOauth = (
	provider: OAuthProvider,
	apiBase: string,
	onSuccess: () => void,
): void => {
	const ret = encodeURIComponent(window.location.origin);
	const url = `${apiBase}/api/v1/auth/${provider}/start?return=${ret}`;
	// We intentionally do NOT pass `noopener` here: the OAuth callback page
	// posts a `garrul:auth` message back via `window.opener.postMessage`, and
	// `noopener` would null `window.opener` in the popup AND make this call
	// return `null` (defeating the popup-blocked fallback below). Cross-origin
	// `opener.location` writes are blocked by modern browsers for cross-origin
	// popups, so the opener relationship is safe in practice.
	const popup = window.open(
		url,
		"garrul-oauth",
		"width=520,height=640,menubar=no,toolbar=no",
	);
	const handler = (e: MessageEvent): void => {
		const apiOrigin = new URL(apiBase).origin;
		// Accept the message only from the API origin AND from our popup window
		// (e.source check is best-effort — popup is null in some browsers when
		// cross-origin). The shape check is the real defense.
		if (e.origin !== apiOrigin) return;
		const data = e.data as {
			type?: string;
			ok?: boolean;
			handoff?: string | null;
		} | null;
		if (!data || data.type !== "garrul:auth") return;
		window.removeEventListener("message", handler);
		if (!data.ok) {
			stopRecovery();
			return;
		}
		// The popup's Set-Cookie is in its own (api-origin) CHIPS partition and
		// won't be visible to this top-level on cross-site embeds. Exchange the
		// handoff token from THIS context so the Set-Cookie lands in our
		// partition. Servers without handoff support omit the field — fall
		// through to onSuccess (same-site embeds still see the popup cookie).
		const handoff = typeof data.handoff === "string" ? data.handoff : "";
		if (!handoff) {
			stopRecovery();
			onSuccess();
			return;
		}
		void fetch(apiUrl(apiBase, "/api/v1/auth/session/exchange"), {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: handoff }),
		})
			.then((res) => {
				if (!res.ok) return;
				stopRecovery();
				onSuccess();
			})
			// Leave the recovery watcher armed on a failed exchange: the popup
			// already minted a session, and on a same-site embed its cookie is
			// readable from here, so /auth/me can still rescue this.
			.catch(() => {});
	};
	// Second channel, for host pages that send `Cross-Origin-Opener-Policy:
	// same-origin`. That header severs the popup's `window.opener`, so the
	// `garrul:auth` message above is never sent and the handler never runs —
	// silently, since the popup still reports success. See issue #58 and the
	// module header in ./auth-recovery.
	//
	// Armed before the message listener so `handler` can never observe
	// `stopRecovery` in its temporal dead zone.
	stopPreviousRecovery?.();
	const stopRecovery = watchForSignIn({
		checkSignedIn: () => fetchMe(apiBase).then((me) => me != null),
		onSignedIn: () => {
			window.removeEventListener("message", handler);
			onSuccess();
		},
		win: window,
		doc: document,
		// Survives COOP: the header nulls `opener` inside the popup, but this
		// side of the handle keeps reporting `closed` accurately. Spread rather
		// than passing undefined — exactOptionalPropertyTypes is on.
		...(popup ? { popupClosed: () => popup.closed } : {}),
	});
	stopPreviousRecovery = stopRecovery;
	window.addEventListener("message", handler);
	if (!popup) {
		// Popup blocked — fall back to top-level redirect. The browser will
		// land back at /callback which sets the cookie + closes; the user
		// then has to navigate back manually. Documented behavior.
		window.location.href = url;
	}
};

/**
 * Mirror the host page's text direction onto the widget's own element.
 *
 * Direction already inherits through the shadow boundary — a shadow root is
 * style encapsulation, not a separate document — so this changes no layout on
 * its own. What it buys is a `dir` attribute the widget's *own* CSS and JS can
 * key off: `:host-context([dir="rtl"])` is the obvious way to reach the host
 * page's direction from inside a shadow tree and Firefox has never implemented
 * it, so the direction has to be readable locally instead.
 *
 * The computed style is what's read, not the attribute: a host page can set
 * `direction: rtl` in a stylesheet and never write `dir` anywhere.
 */
const applyDirection = (host: HTMLElement) => {
	const dir = getComputedStyle(document.documentElement).direction;
	host.dir = dir === "rtl" ? "rtl" : "ltr";
};

/**
 * Origin of the <script> that loaded this bundle, or null if it can't be
 * determined — the fallback for `data-api` when the host page omits it.
 *
 * Read here, at module scope, and not inside init(): `document.currentScript`
 * is only non-null *while* a script is executing. init() runs synchronously
 * from the tail of this file when the document is already parsed, but a plain
 * (non-deferred) <script> in the body defers it to DOMContentLoaded — where
 * currentScript is null and the origin silently fell back to the *host page's*.
 * Every cross-origin embed on that path pointed the widget's whole API at the
 * blog it was embedded in unless the integrator set data-api by hand.
 */
const SCRIPT_ORIGIN: string | null = (() => {
	const s = document.currentScript as HTMLScriptElement | null;
	try {
		// `.src` is "" for an inline script; new URL("") throws, hence the catch.
		return s?.src ? new URL(s.src).origin : null;
	} catch {
		return null;
	}
})();

const init = () => {
	const host = document.getElementById("garrul");
	if (!host) return;

	const slug = host.dataset.slug;
	if (!slug) {
		// Release before returning: nothing else in this file ever will, and a
		// one-line error message marooned in 220px of reserved space is a worse
		// diagnostic than the message on its own.
		releaseSpace(host);
		host.textContent = "[garrul] missing data-slug";
		return;
	}

	const apiBase = host.dataset.api ?? SCRIPT_ORIGIN ?? window.location.origin;

	applyDirection(host);
	// Locale is a property of the site, not of the reader: data-lang is what the
	// operator chose, <html lang> is what their theme claims. Accept-Language and
	// navigator.language are deliberately never consulted — a German comment box
	// under English prose reads as broken, not helpful.
	langExplicit = host.dataset.lang ?? "";
	langHint = document.documentElement.lang;

	const root = host.attachShadow({ mode: "open" });
	const style = el("style");
	style.textContent = STYLE_CSS;
	root.append(style, buildSkeleton());

	// Hand the height back as soon as there is real content to measure. Holding
	// the reservation would leave a short thread — "be the first to comment"
	// plus a composer — sitting in 220px of dead space forever.
	void load(root, slug, apiBase, host).finally(() => {
		releaseSpace(host);
	});
};

/**
 * Did `reserveSpace` actually write the inline `min-height`?
 *
 * Load-bearing, because `releaseSpace` clears an inline style rather than
 * restoring one. A host that sized #garrul inline themselves sends
 * `reserveSpace` down its early return — and clearing unconditionally once the
 * thread arrived would then delete *their* value, collapsing the element at the
 * exact moment it filled up. Only what we wrote is ours to take back.
 */
let reservedHeight = false;

/**
 * Claim the widget's eventual height before the document finishes parsing.
 *
 * A plain (non-deferred) <script> in the body executes during parse, but
 * init() waits for DOMContentLoaded. In between, #garrul is 0px tall — and
 * then it jumps to the skeleton's height, shoving the footer and everything
 * else below the thread down the page. Claiming the box at execution time
 * turns that jump into nothing moving at all.
 *
 * Two shifts this cannot fix, so the docs cover them instead:
 * - With the recommended `defer`, this runs in the same tick as init() and
 *   buys nothing. Reserving space before a deferred script runs is the host
 *   page's job — AGENTS.md §3 and docs/THEMING.md say so.
 * - The skeleton → real thread swap. Nobody can size a thread they have not
 *   fetched.
 *
 * `min-height`, so a longer thread outgrows it rather than being clipped, and
 * only when the host has not sized the element themselves — this writes an
 * inline style, which would otherwise silently beat their stylesheet.
 */
const reserveSpace = () => {
	// Absent when the <script> sits above the mount element. Nothing to reserve
	// yet, and init() will find it on DOMContentLoaded either way.
	const host = document.getElementById("garrul");
	if (!host) return;
	const existing = getComputedStyle(host).minHeight;
	if (existing && existing !== "0px" && existing !== "auto") return;
	// Three skeleton rows and their gaps. Deliberately not the loaded widget's
	// height: over-reserving trades one shift for a page-length hole.
	host.style.minHeight = "220px";
	reservedHeight = true;
};

/**
 * Hand the reservation back. Every exit from init() has to reach this: the
 * value is inline and nothing else ever clears it, so a path that skips it
 * leaves 220px of dead space under the widget for the life of the page.
 */
const releaseSpace = (host: HTMLElement) => {
	if (!reservedHeight) return;
	host.style.minHeight = "";
	reservedHeight = false;
};

const renderError = (root: ShadowRoot, err: unknown) => {
	root.replaceChildren();
	const style = el("style");
	style.textContent = STYLE_CSS;
	const wrap = el("div", "gr-root");
	wrap.appendChild(el("div", "gr-error", loadErrorMessage(err, s)));
	root.append(style, wrap);
};

const fetchPage = async (
	apiBase: string,
	slug: string,
	cursor: string | null,
	sort: SortKey | null = null,
): Promise<ListResponse> => {
	const qs = new URLSearchParams({ slug });
	if (cursor) qs.set("before", cursor);
	if (sort) qs.set("sort", sort);
	const res = await fetch(apiUrl(apiBase, `/api/v1/comments?${qs.toString()}`), {
		credentials: "include",
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as ListResponse;
};

const appendThreads = (
	list: HTMLElement,
	threads: TreeNode[],
	ctx: WidgetCtx,
): void => {
	for (const t of threads) list.appendChild(buildThread(t, ctx));
};

const fetchMe = async (apiBase: string): Promise<Me> => {
	try {
		const res = await fetch(apiUrl(apiBase, "/api/v1/auth/me"), {
			credentials: "include",
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { user: Me };
		return json.user;
	} catch {
		return null;
	}
};


// Squash overlapping load() invocations: if a load is in flight when a
// second one is requested (e.g. the user reacts and submits quickly), we
// just flag a follow-up and re-run once after the current one finishes.
// Prevents two concurrent root.replaceChildren() calls racing each other.
// `sort` is sticky across reloads on the same mount so an in-flight reload
// triggered by a reply doesn't drop the reader's selection. It starts `null`
// — "no preference", i.e. whatever the operator's `default_sort` resolves to —
// and is pinned to the order the first response reports, so a reload can't
// silently land in a different order than the page the reader is looking at.
const loadState = new WeakMap<
	ShadowRoot,
	{ running: boolean; queued: boolean; sort: SortKey | null }
>();

const load = async (
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
): Promise<void> => {
	let st = loadState.get(root);
	if (!st) {
		st = { running: false, queued: false, sort: null };
		loadState.set(root, st);
	}
	if (st.running) {
		st.queued = true;
		return;
	}
	st.running = true;
	try {
		await loadOnce(root, slug, apiBase, host, st.sort);
	} finally {
		st.running = false;
		if (st.queued) {
			st.queued = false;
			await load(root, slug, apiBase, host);
		}
	}
};

const setSort = (root: ShadowRoot, sort: SortKey): void => {
	const st = loadState.get(root);
	if (st) st.sort = sort;
};

// Closed-state notice copy, picked from the server's closed_reason enum so the
// reader sees *why* the thread is frozen rather than a generic line.
const closedNotice = (reason: ListResponse["closed_reason"]): string => {
	// The switch is logic and stays; each branch names its own key so a
	// translator sees four independent sentences rather than one to disambiguate.
	switch (reason) {
		case "post_closed":
			return s("w.closed.post");
		case "aged_out":
			return s("w.closed.aged");
		case "sunset":
			return s("w.closed.sunset");
		default:
			return s("w.closed.other");
	}
};

const loadOnce = async (
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
	sort: SortKey | null,
) => {
	let siteKey: string | null = null;
	let turnstileAlways = false;
	// Only used when /api/v1/config never answers — the server always sends a
	// resolved value. Mirrors the server default (src/lib/settings.ts).
	let editWindowMinutes = 15;
	let providers: ReadonlyArray<OAuthProvider> = [];
	let brandingHidden = false;
	let commentsEnabled = true;
	let reactionsEnabled = true;
	let votingEnabled = true;
	let downvotesEnabled = true;
	let pageReactionsEnabled = false;
	let pageVotesEnabled = false;
	// True by default, and read below as `!== false`, so a server older than this
	// bundle — which sends no such field — keeps offering the notify checkbox it
	// has always offered. Only an explicit `false` hides the subscribe UI.
	let subscriptionsEnabled = true;
	// Defaults mirror the server (src/lib/settings.ts) so a failed/absent
	// config fetch degrades gracefully to the same behavior.
	let repliesPerThread = 3;
	let autoCollapseDepth = 3;
	let communityMinVotes = 5;
	let communityCollapseRatio = 0;
	// The mount request. `null` means this Worker cannot answer it, and every
	// branch below then does exactly what it did before the endpoint existed. A
	// throw means the edge answered and refused, where the fallback would only
	// spend five more requests to be refused five more times — so it renders the
	// error here, exactly as the legacy tree fetch does further down.
	let boot: BootstrapResponse | null;
	try {
		boot = await fetchBootstrap(apiBase, slug, sort, langExplicit, langHint);
	} catch (err) {
		// renderError replaces the shadow tree, so the composer this handle
		// belongs to is about to vanish.
		destroyTopComposerTurnstile();
		renderError(root, err as Error);
		return;
	}
	try {
		// Bootstrap's `config` section is byte-identical to /api/v1/config's body
		// (pinned by tests/bootstrap.test.ts), which is what lets one block parse
		// either — including the defensive reads below, so a field missing from a
		// bootstrap payload degrades exactly as one missing from /config does.
		const cfg: ConfigResponse | null = boot
			? (boot.config ?? null)
			: await fetchConfig(apiBase, langExplicit, langHint);
		if (cfg) {
			// Install the locale before anything renders below. The table is the
			// locale's own overrides, not a merged copy — makeS falls back to the
			// bundled English per key, so a partial translation renders English
			// exactly where it is incomplete and correct everywhere else.
			if (typeof cfg.locale === "string" && cfg.locale) {
				locale = cfg.locale;
				host.lang = locale;
				({ s, sAround } = makeS(
					(cfg.strings ?? {}) as StringTable,
					locale,
				));
				// An RTL locale on an LTR page still has to lay out RTL. The host
				// page's own direction already applied at mount (applyDirection);
				// this only ever tightens it, never flips a page back to LTR.
				if (cfg.rtl === true) host.dir = "rtl";
			}
			siteKey = cfg.turnstile_site_key ?? null;
			// Absent on an older server, which is the same as off — that server
			// won't demand a token from a signed-in post either.
			turnstileAlways = cfg.turnstile_always === true;
			editWindowMinutes = cfg.edit_window_minutes ?? 15;
			// Guard the value rather than trusting it: a zero or negative ceiling
			// from a mis-deployed Worker would put every composer permanently in
			// the over-limit state.
			if (typeof cfg.max_body_chars === "number" && cfg.max_body_chars > 0)
				maxBodyChars = cfg.max_body_chars;
			providers = (cfg.providers ?? []).filter((p): p is OAuthProvider =>
				// biome-ignore lint/suspicious/noPrototypeBuiltins: the rule wants Object.hasOwn (ES2022); the widget builds for es2020 and esbuild will not polyfill it. This is already the safe `.call` form.
				Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, p),
			);
			brandingHidden = cfg.branding_hidden === true;
			commentsEnabled = cfg.comments_enabled !== false;
			reactionsEnabled = cfg.reactions_enabled !== false;
			votingEnabled = cfg.voting_enabled !== false;
			downvotesEnabled = cfg.downvotes_enabled !== false;
			pageReactionsEnabled = cfg.page_reactions_enabled === true;
			pageVotesEnabled = cfg.page_votes_enabled === true;
			subscriptionsEnabled = cfg.subscriptions_enabled !== false;
			if (typeof cfg.replies_per_thread === "number")
				repliesPerThread = cfg.replies_per_thread;
			if (typeof cfg.auto_collapse_depth === "number")
				autoCollapseDepth = cfg.auto_collapse_depth;
			if (typeof cfg.community_min_votes === "number")
				communityMinVotes = cfg.community_min_votes;
			if (typeof cfg.community_collapse_ratio === "number")
				communityCollapseRatio = cfg.community_collapse_ratio;
		}
	} catch {
		// The config is optional; the widget still renders without Turnstile (the
		// server will reject anonymous POSTs in that case). Only the legacy branch
		// can throw here — a bootstrapped mount already has its config section in
		// hand, and fetchBootstrap's own throw was handled before this block.
	}

	let me: Me;
	let data: ListResponse;
	if (boot) {
		// boot.ts hands these two through uncast on purpose — see BootstrapResponse.
		// The same casts the legacy branch below makes on its own two responses.
		me = (boot.user ?? null) as Me;
		data = boot.comments as ListResponse;
	} else {
		const [meResult, dataResult] = await Promise.all([
			fetchMe(apiBase),
			fetchPage(apiBase, slug, null, sort).catch((err: unknown) => err),
		]);
		if (dataResult instanceof Error) {
			// renderError replaces the shadow tree, so the composer this handle
			// belongs to is about to vanish.
			destroyTopComposerTurnstile();
			renderError(root, dataResult);
			return;
		}
		me = meResult;
		data = dataResult as ListResponse;
	}

	// The order this page is actually in, which is only the same as `sort` once
	// the reader has chosen one: until then `sort` is null and the server picked.
	// Pinned into the mount state so the next reload asks for it explicitly —
	// otherwise an operator changing `default_sort` mid-session would reorder the
	// thread under a reader who never touched the control. Load-more reads it for
	// the same reason, one step sharper: `next_cursor` is a keyset cursor into
	// *this* order and means something else in any other one.
	const activeSort: SortKey = data.sort ?? sort ?? "new";
	setSort(root, activeSort);

	// Per-post acceptance: the server resolves the global flag, per-post close,
	// and auto-close into one boolean + reason. Fall back to the global flag for
	// an older server that doesn't send these fields.
	const acceptingComments =
		typeof data.accepting_comments === "boolean"
			? data.accepting_comments
			: commentsEnabled;
	const closedReason = data.closed_reason ?? null;

	// Last point of no return before the old tree goes away. Deliberately not at
	// the top of loadOnce: the awaited fetches above take hundreds of ms, during
	// which the currently-displayed composer must keep working.
	destroyTopComposerTurnstile();

	root.replaceChildren();
	const style = el("style");
	style.textContent = STYLE_CSS;

	const wrap = el("div", "gr-root");
	const reload = () => {
		void load(root, slug, apiBase, host);
	};
	const ctx: WidgetCtx = {
		apiBase,
		slug,
		host,
		root,
		me,
		editWindowMs: editWindowMinutes * 60_000,
		turnstileSiteKey: siteKey,
		turnstileAlways,
		commentsEnabled,
		acceptingComments,
		closedReason,
		reactionsEnabled,
		votingEnabled,
		downvotesEnabled,
		pageReactionsEnabled,
		pageVotesEnabled,
		subscriptionsEnabled,
		repliesPerThread,
		autoCollapseDepth,
		communityMinVotes,
		communityCollapseRatio,
		seed: {
			bootstrapped: boot != null,
			engagement: boot?.engagement,
			subscription: boot?.subscription,
		},
		reload,
	};
	// Article-level engagement bar sits at the very top, above the composer.
	if (pageReactionsEnabled || pageVotesEnabled) {
		wrap.appendChild(buildPageEngagement(ctx));
	}
	const authBlock = buildAuthBlock(me, apiBase, providers, reload, reload);
	// The composer is always built (its submit/Turnstile wiring lives further
	// down) but only mounted when comments are enabled. When disabled, existing
	// comments stay visible (read-only) and we show a "closed" notice instead.
	const form = buildForm(
		apiBase,
		siteKey,
		me != null,
		subscriptionsEnabled,
		me?.email ?? null,
		turnstileAlways,
	);
	// Restore/persist the top-level composer draft (cleared on successful post
	// in submit()). Reply-form drafts are wired separately in buildReplyForm.
	const composer = form.querySelector(
		".gr-body-input",
	) as HTMLTextAreaElement | null;
	if (composer) attachDraft(composer, draftKey(slug, null));
	const list = el("div", "gr-list");
	if (data.threads.length === 0) {
		// Don't invite a comment the reader can't leave: when comments are
		// closed the closed-state notice below is the whole story.
		list.appendChild(
			el(
				"p",
				"gr-empty",
				s(acceptingComments ? "w.empty.open" : "w.empty.closed"),
			),
		);
	} else {
		appendThreads(list, data.threads, ctx);
	}
	if (acceptingComments) {
		if (authBlock) wrap.appendChild(authBlock);
		// Mint the timing token now so the honeypot-timing heuristic has
		// real elapsed seconds to measure when the user eventually submits.
		prefetchFormToken(apiBase);
		wrap.append(form);
	} else {
		wrap.appendChild(el("p", "gr-empty", closedNotice(closedReason)));
	}

	// Thread toolbar: sort on the left, subscribe bell on the right. This row
	// used to exist only to hold the sort selector, hence the generalization
	// rather than a second row — the bell wants exactly this slot, immediately
	// above the list.
	// Chronological order needs no scores, so the selector is no longer gated on
	// voting — only on there being something to sort. A post with no comments
	// used to render "Sort by" over "No comments yet" wherever voting was on;
	// ungating without this check would have spread that to every install.
	const showSort = data.threads.length > 0;
	if (showSort || subscriptionsEnabled) {
		const bar = el("div", "gr-threadbar");
		if (showSort) {
			const sortWrap = el("div", "gr-sort");
			const label = el("label");
			const sel = el("select") as HTMLSelectElement;
			const opts: ReadonlyArray<readonly [SortKey, string]> = [
				["new", s("w.sort.new")],
				["old", s("w.sort.old")],
				// Ranking needs scores. Kept when it is the order on screen even so:
				// voting can be switched off while a reader is sorted by it, and an
				// option that vanishes under the value it holds leaves the control
				// naming an order other than the one being displayed.
				...(votingEnabled || activeSort === "top"
					? ([["top", s("w.sort.top")]] as const)
					: []),
			];
			for (const [value, text] of opts) {
				const opt = el("option") as HTMLOptionElement;
				opt.value = value;
				opt.textContent = text;
				sel.appendChild(opt);
			}
			sel.value = activeSort;
			// The control sits inside the label, so the label text is split around it
			// rather than hard-coded as a "Sort by " prefix — languages that put the
			// control first (or wrap it) can say so in the string.
			const [beforeSel, afterSel] = sAround("w.sort_by", "control");
			label.append(beforeSel, sel, afterSel);
			sortWrap.appendChild(label);
			sel.addEventListener("change", () => {
				const picked = opts.find(([value]) => value === sel.value);
				if (!picked) return;
				setSort(root, picked[0]);
				reload();
			});
			bar.appendChild(sortWrap);
		}
		if (subscriptionsEnabled) {
			// `me?.email`, not `me != null` — a session with no address (X/Twitter,
			// or an anonymous ghost) cannot drive the stateful bell. See the note on
			// buildSubscribeBell.
			bar.appendChild(
				buildSubscribeBell(apiBase, slug, me?.email ?? null, ctx.seed),
			);
		}
		wrap.appendChild(bar);
	}

	wrap.appendChild(list);

	if (data.next_cursor) {
		const more = el("button", "gr-loadmore", s("w.load_more"));
		more.type = "button";
		let cursor: string | null = data.next_cursor;
		more.addEventListener("click", async () => {
			if (!cursor) return;
			more.disabled = true;
			try {
				const page = await fetchPage(apiBase, slug, cursor, activeSort);
				appendThreads(list, page.threads, ctx);
				cursor = page.next_cursor;
				if (cursor) {
					more.disabled = false;
				} else {
					more.remove();
				}
			} catch (err) {
				more.disabled = false;
				const errBox = el(
					"div",
					"gr-error",
					s("w.load_more_failed", { detail: String(err) }),
				);
				more.insertAdjacentElement("afterend", errBox);
			}
		});
		wrap.appendChild(more);
	}

	if (!brandingHidden) {
		const attr = el("p", "gr-attribution");
		const link = document.createElement("a");
		link.href = "https://garrul.com";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		// The product name is never translated; only the sentence around it is.
		link.textContent = "Garrul";
		const [beforeLink, afterLink] = sAround("w.powered_by", "link");
		attr.append(beforeLink, link, afterLink);
		wrap.appendChild(attr);
	}

	root.append(style, wrap);

	// Scroll a permalink target (#garrul-comment-<id>) into view once the
	// tree is in the DOM. Browsers don't auto-scroll to anchors inside a
	// shadow root, so we have to do it manually.
	if (window.location.hash.startsWith("#garrul-comment-")) {
		const target = root.getElementById(window.location.hash.slice(1));
		if (target) {
			// The CSS half of the reduced-motion promise lives in styles.css;
			// scroll behavior is set here, so it has to be honored here too.
			// `matchMedia` is guarded because the widget also runs under the
			// iframe route and in test DOMs that don't implement it.
			const still = window.matchMedia?.(
				"(prefers-reduced-motion: reduce)",
			)?.matches;
			target.scrollIntoView({
				block: "center",
				behavior: still ? "auto" : "smooth",
			});
		}
	}

	// Turnstile mounts on the visitor's first composer focus, not here. api.js
	// plus the challenge platform it pulls in is larger than this entire widget,
	// and almost nobody who loads a page comments — so a reader who never
	// touches the composer never pays for it (#49). The cost is that a submit
	// can now outrun the token; `submit()` waits for one.
	const tsBox = form.querySelector(".gr-turnstile") as HTMLElement | null;
	// Slot presence already encodes `siteKey && (!signedIn || turnstileAlways)`
	// (see buildForm), so only the accepting-comments condition is left here.
	if (tsBox && acceptingComments) {
		const submitBtn = form.querySelector(
			"button[type=submit]",
		) as HTMLButtonElement | null;
		let handle: TurnstileFrameHandle | null = null;

		const gate = createTurnstileGate({
			mount: () => {
				handle = mountTurnstileFrame(tsBox, apiBase, {
					onToken: (token) => gate.token(token),
					onExpired: () => gate.signal("expired"),
					onError: (code) => gate.signal("error", code),
					onReady: () => gate.signal("ready"),
					onInteractive: () => gate.signal("interactive"),
				});
			},
			// Turnstile said to retry, and the gate has budget for it. Re-arm the
			// challenge and touch nothing else: the composer stays usable, and a
			// blip that nobody was waiting on heals with the visitor none the
			// wiser. A submit that *was* waiting gets the `retrying` verdict.
			onRetry: () => handle?.reset(),
			// Turnstile's own verdict on something a retry can't fix, and the only
			// thing that disables the composer for good. The cap expiring in the
			// gate is a guess and deliberately does not come through here.
			onFailed: () => {
				tsBox.hidden = true;
				if (submitBtn) submitBtn.disabled = true;
				const errEl = form.querySelector(".gr-error") as HTMLElement | null;
				if (errEl) {
					showStatus(
						errEl,
						s("w.ts.failed"),
					);
				}
			},
		});

		// Listen on the form, not the textarea: the textarea is a grandchild
		// (buildWritePreview wraps it in div.gr-compose), and focusin covers the
		// name field, email field, notify checkbox and toolbar too.
		const onFocusIn = (e: Event): void => {
			// Never mount from the submit button. It sits directly below the
			// slot, so growing the slot on mousedown-focus would slide the button
			// out from under the cursor and swallow the click — the visitor sees
			// a captcha appear and nothing happen. submit() arms the gate itself
			// on that path. A plain listener rather than `{ once: true }`,
			// because an ignored button focus would otherwise consume it; arm()
			// is idempotent.
			if (e.target === submitBtn) return;
			gate.arm();
		};
		form.addEventListener("focusin", onFocusIn);

		topComposerTurnstile = {
			form,
			gate,
			reset: () => handle?.reset(),
			destroy: () => {
				form.removeEventListener("focusin", onFocusIn);
				gate.dispose();
				handle?.destroy();
			},
		};
	}

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		void submit(form, root, slug, apiBase, host);
	});

	// No cancel handler: the top-level composer is the page's resting state, so
	// Escape has nothing to back out to. Cmd/Ctrl+Enter still posts.
	bindComposerKeys(form);
};

const submit = async (
	form: HTMLFormElement,
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
) => {
	// Two things write to this box: submit failures, and Turnstile. Precedence:
	// the "anti-spam check failed to load" message wins and is sticky. It means
	// the composer cannot produce a valid post at all, so nothing may overwrite
	// it and nothing may re-enable the button — otherwise the visitor is invited
	// to retry something guaranteed to fail. Every write below is therefore
	// gated on the failure not having happened.
	const errEl = form.querySelector(".gr-error") as HTMLElement | null;
	const ts = turnstileFor(form);
	if (errEl && !ts?.gate.failed) clearStatus(errEl);
	const submitBtn = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
	if (submitBtn) submitBtn.disabled = true;

	const notice = (message: string): void => {
		if (ts?.gate.failed) return;
		if (errEl) showStatus(errEl, message, "notice");
		// Recoverable, unlike `onFailed` — the visitor can solve the challenge
		// or retry, so give them the button back.
		if (submitBtn) submitBtn.disabled = false;
	};

	// Wait for a token before reading anything else. The mount is deferred to
	// first composer focus, and a draft restored by attachDraft dispatches no
	// events, so a returning visitor can submit a pre-filled composer having
	// focused nothing at all — the hidden input wouldn't even exist yet.
	let waitedToken = "";
	if (ts) {
		const label = submitBtn?.textContent ?? "";
		if (submitBtn) submitBtn.textContent = s("w.ts.checking");
		const waited = await ts.gate.wait();
		if (submitBtn) submitBtn.textContent = label;
		if (!waited.ok) {
			switch (waited.reason) {
				case "interactive":
					notice(s("w.ts.interactive"));
					return;
				case "timeout":
					notice(s("w.ts.timeout"));
					return;
				case "retrying":
					// Recoverable by construction: the gate has already asked the
					// frame to re-challenge, so the next attempt has a real chance.
					notice(s("w.ts.retrying"));
					return;
				case "failed":
					// `onFailed` already wrote the message and disabled the button.
					// Leave both alone.
					return;
			}
		}
		waitedToken = waited.token;
	}

	// Read the fields *after* the wait: the visitor can keep typing while it
	// runs, and posting a pre-wait snapshot would then clearDraft() over text
	// that never made it to the server.
	const nameInput = form.querySelector(".gr-name-input") as HTMLInputElement | null;
	const name = nameInput?.value ?? "";
	const body = (form.querySelector(".gr-body-input") as HTMLTextAreaElement).value;
	const honeypot = (form.querySelector(".gr-honeypot") as HTMLInputElement).value;

	try {
		const formTs = await getFormToken(apiBase);
		// Read the token at the last possible moment — after the form-token
		// await — and prefer the live input over what the gate resolved with, in
		// case Turnstile refreshed in between. Never post an empty or stale one:
		// the API's presence check returns before the rate limiter, but a token
		// that fails siteverify burns the caller's write budget and their retry
		// can eat a 429 (see api.comments.ts).
		const tokenInput = form.querySelector(
			'input[name="cf-turnstile-response"]',
		) as HTMLInputElement | null;
		const turnstileToken = tokenInput?.value || waitedToken || "";
		if (ts && !turnstileToken) {
			notice(s("w.ts.interactive"));
			return;
		}
		const res = await fetch(apiUrl(apiBase, "/api/v1/comments"), {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				slug,
				name,
				body,
				turnstile_token: turnstileToken,
				website: honeypot,
				form_ts: formTs,
				post_title: host.dataset.title ?? null,
				post_url: host.dataset.url ?? null,
			}),
		});
		const json = (await res.json()) as {
			error?: string;
			comment?: { status?: string };
		};
		if (!res.ok) {
			// A Turnstile error can arrive while this request is in flight.
			if (ts?.gate.failed) return;
			if (errEl) showStatus(errEl, json.error ?? `HTTP ${res.status}`);
			if (submitBtn) submitBtn.disabled = false;
			// The token is single-use once siteverify has seen it, so re-challenge
			// and make the next wait actually wait rather than replay it.
			ts?.reset();
			ts?.gate.clear();
			return;
		}

		// Comment landed — drop the saved composer draft so the reload starts
		// from a clean field.
		clearDraft(draftKey(slug, null));

		// Pending comments fall through to the same reload path as approved
		// ones: the list endpoint returns the author's own queued comment, so
		// `load()` re-renders it inline with a "Pending approval" badge — a
		// visible, persistent confirmation rather than a transient notice.

		// Fire-and-forget subscription — failure here doesn't roll back
		// the comment. The widget already has both inputs handy.
		const notifyCb = form.querySelector(".gr-notify-cb") as HTMLInputElement | null;
		const emailInput = form.querySelector(".gr-email-input") as HTMLInputElement | null;
		if (notifyCb?.checked) {
			// Field presence encodes "the session carries no address" (see
			// buildForm), much as the Turnstile slot encodes its own gate. No field
			// means the server has an address to fall back to, so omitting it is
			// safe. Guarding on a non-empty `email` alone made the checkbox a
			// silent no-op for every signed-in reader.
			const email = emailInput?.value.trim() ?? "";
			if (email || !emailInput) {
				void fetch(apiUrl(apiBase, "/api/v1/subscribe"), {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						email ? { post_slug: slug, email } : { post_slug: slug },
					),
				}).catch(() => {});
			}
		}

		await load(root, slug, apiBase, host);
	} catch (err) {
		// Same race, and the one that actually bit: a Turnstile error landing
		// mid-submit had its message replaced by String(err) here, and the
		// composer was handed back to the visitor with a dead anti-spam widget.
		if (ts?.gate.failed) return;
		if (errEl) showStatus(errEl, String(err));
		if (submitBtn) submitBtn.disabled = false;
		ts?.reset();
		ts?.gate.clear();
	}
};

// Runs now, at script-execution time — that is the whole point of it.
reserveSpace();

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
