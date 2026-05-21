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
 *   3. Fetch GET /api/v1/comments?slug=<slug> in parallel.
 *   4. Render the threaded tree once data arrives.
 *   5. On submit, POST /api/v1/comments. Reload list on success.
 *   6. "Load more" appends older top-level threads via ?before=<cursor>.
 *
 * XSS posture:
 *   - All untrusted text → textContent (never as parsed HTML).
 *   - Server-sanitized HTML (body_html, identicon SVG) is the only thing
 *     parsed as HTML, and it's parsed via Range.createContextualFragment
 *     after src/lib/markdown.ts has already allowlist-sanitized it.
 *   - Style + skeleton blocks are static template strings (no user input).
 *
 * Why Shadow DOM: total style isolation. Host CSS can't bleed in; ours
 * can't bleed out. Public theming surface is the documented CSS variables
 * (docs/THEMING.md).
 */

type TreeAuthor = {
	id: string;
	name: string;
	provider: string;
	is_admin: boolean;
	avatar_svg: string | null;
	avatar_url: string | null;
};

type ReactionCount = { kind: string; count: number; mine: boolean };

type TreeNode = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: "approved" | "pending" | "spam" | "deleted";
	edited_at: number | null;
	deleted_at: number | null;
	created_at: number;
	author: TreeAuthor;
	depth: number;
	flatten_from: string | null;
	reactions: ReactionCount[];
	replies: TreeNode[];
};

type ListResponse = {
	post: unknown;
	threads: TreeNode[];
	next_cursor: string | null;
};

type Me = {
	id: string;
	provider: string;
	name: string;
	email: string | null;
	avatar_url: string | null;
	is_admin: boolean;
} | null;

const STYLE_CSS = `
:host {
	all: initial;
	display: block;
	font-family: var(--garrul-font, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
	color: var(--garrul-fg, #1a1a1a);
	background: var(--garrul-bg, transparent);
	font-size: var(--garrul-font-size, 15px);
	line-height: 1.5;
}
* { box-sizing: border-box; }
.gr-root { display: flex; flex-direction: column; gap: 1rem; }
.gr-form { display: flex; flex-direction: column; gap: 0.5rem; }
.gr-form input, .gr-form textarea {
	font: inherit; color: inherit;
	background: var(--garrul-input-bg, #fff);
	border: 1px solid var(--garrul-border, #d0d3d8);
	border-radius: var(--garrul-radius, 6px);
	padding: 0.5rem 0.7rem;
}
.gr-form textarea { min-height: 6em; resize: vertical; }
.gr-form .gr-honeypot { position: absolute; left: -9999px; top: -9999px; }
.gr-form .gr-notify { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9em; cursor: pointer; }
.gr-form .gr-notify .gr-notify-cb { width: auto; }
.gr-form .gr-email-input[hidden] { display: none; }
.gr-form button {
	font: inherit;
	background: var(--garrul-accent, #2563eb);
	color: var(--garrul-accent-fg, #fff);
	border: none;
	border-radius: var(--garrul-radius, 6px);
	padding: 0.55rem 1rem;
	cursor: pointer;
	align-self: flex-start;
}
.gr-form button[disabled] { opacity: 0.6; cursor: progress; }
.gr-error { color: var(--garrul-error, #b91c1c); font-size: 0.9em; }
.gr-error.is-notice { color: var(--garrul-notice, #1e6091); }
.gr-list { display: flex; flex-direction: column; gap: 1rem; }
.gr-thread { display: flex; flex-direction: column; gap: 0.75rem; }
.gr-replies { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; padding-left: 1.25rem; border-left: 2px solid var(--garrul-border, #d0d3d8); }
.gr-comment { display: flex; gap: 0.75rem; }
.gr-comment[data-flat="1"] .gr-flatten { font-size: 0.85em; color: var(--garrul-muted, #6b7280); margin-right: 0.3em; }
.gr-avatar { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%; overflow: hidden; }
.gr-avatar svg, .gr-avatar img { width: 100%; height: 100%; display: block; }
.gr-main { flex: 1; min-width: 0; }
.gr-meta { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
.gr-name { font-weight: 600; }
.gr-verified {
	background: var(--garrul-badge-bg, #e0e7ff);
	color: var(--garrul-badge-fg, #1e3a8a);
	font-size: 0.75em;
	padding: 0.05em 0.4em;
	border-radius: 999px;
}
.gr-time { color: var(--garrul-muted, #6b7280); font-size: 0.85em; }
.gr-body { margin: 0.25rem 0 0; }
.gr-body p { margin: 0.3em 0; }
.gr-body a { color: var(--garrul-link, #2563eb); }
.gr-deleted { color: var(--garrul-muted, #6b7280); font-style: italic; }
.gr-actions { display: flex; gap: 0.75rem; margin-top: 0.35rem; font-size: 0.85em; }
.gr-actions button {
	font: inherit;
	background: transparent;
	color: var(--garrul-muted, #6b7280);
	border: none;
	padding: 0;
	cursor: pointer;
}
.gr-actions button:hover { color: var(--garrul-link, #2563eb); }
.gr-reactions { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; }
.gr-reaction {
	font: inherit;
	background: var(--garrul-input-bg, #fff);
	color: var(--garrul-fg, #1a1a1a);
	border: 1px solid var(--garrul-border, #d0d3d8);
	border-radius: 999px;
	padding: 0.05em 0.55em;
	font-size: 0.85em;
	cursor: pointer;
	line-height: 1.5;
}
.gr-reaction[data-mine="1"] {
	background: var(--garrul-badge-bg, #e0e7ff);
	color: var(--garrul-badge-fg, #1e3a8a);
	border-color: var(--garrul-accent, #2563eb);
}
.gr-reaction-count { margin-left: 0.25em; font-variant-numeric: tabular-nums; }
.gr-reply-form { margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.4rem; }
.gr-reply-form textarea { min-height: 4em; }
.gr-reply-form .gr-reply-actions { display: flex; gap: 0.5rem; }
.gr-reply-form .gr-reply-actions button {
	font: inherit;
	border-radius: var(--garrul-radius, 6px);
	padding: 0.4rem 0.9rem;
	cursor: pointer;
	border: 1px solid var(--garrul-border, #d0d3d8);
	background: var(--garrul-input-bg, #fff);
	color: var(--garrul-fg, #1a1a1a);
}
.gr-reply-form .gr-reply-actions button[type="submit"] {
	background: var(--garrul-accent, #2563eb);
	color: var(--garrul-accent-fg, #fff);
	border-color: var(--garrul-accent, #2563eb);
}
.gr-empty { color: var(--garrul-muted, #6b7280); margin: 0; }
.gr-loadmore {
	font: inherit;
	background: transparent;
	color: var(--garrul-link, #2563eb);
	border: 1px solid var(--garrul-border, #d0d3d8);
	border-radius: var(--garrul-radius, 6px);
	padding: 0.5rem 1rem;
	cursor: pointer;
	align-self: center;
}
.gr-loadmore[disabled] { opacity: 0.6; cursor: progress; }
.gr-signin { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.gr-signin button {
	font: inherit;
	background: var(--garrul-input-bg, #fff);
	color: var(--garrul-fg, #1a1a1a);
	border: 1px solid var(--garrul-border, #d0d3d8);
	border-radius: var(--garrul-radius, 6px);
	padding: 0.4rem 0.8rem;
	cursor: pointer;
}
.gr-signed { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; color: var(--garrul-muted, #6b7280); font-size: 0.9em; }
.gr-signed .gr-signed-name { color: var(--garrul-fg, #1a1a1a); font-weight: 600; }
.gr-signed button {
	font: inherit;
	background: transparent;
	color: var(--garrul-link, #2563eb);
	border: none;
	padding: 0;
	cursor: pointer;
	text-decoration: underline;
}
.gr-skel { background: var(--garrul-skel, #e7e9ec); border-radius: 6px; animation: gr-pulse 1.2s ease-in-out infinite; }
.gr-skel-line { height: 0.9em; }
.gr-skel-avatar { width: 40px; height: 40px; border-radius: 50%; }
@keyframes gr-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.45; }
}
`;

const fmtTime = (ts: number): string =>
	new Date(ts).toISOString().replace("T", " ").slice(0, 16);

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
 * Parse a TRUSTED HTML chunk into a DocumentFragment. Use only for content
 * we control (style tag) or server-sanitized output (body_html, identicon SVG).
 */
const parseTrustedHtml = (html: string): DocumentFragment => {
	const range = document.createRange();
	return range.createContextualFragment(html);
};

const buildSkeleton = (): DocumentFragment => {
	const frag = document.createDocumentFragment();
	const root = el("div", "gr-root");
	const list = el("div", "gr-list");
	list.setAttribute("aria-busy", "true");
	list.setAttribute("aria-label", "Loading comments");
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
			const res = await fetch(`${apiBase}/api/v1/comments/form-token`, {
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

const REACTION_KINDS: { kind: string; emoji: string }[] = [
	{ kind: "like", emoji: "👍" },
	{ kind: "love", emoji: "❤️" },
	{ kind: "laugh", emoji: "😂" },
	{ kind: "hmm", emoji: "🤔" },
	{ kind: "cry", emoji: "😢" },
];

const reactionsByKind = (rs: ReactionCount[]): Map<string, ReactionCount> => {
	const m = new Map<string, ReactionCount>();
	for (const r of rs) m.set(r.kind, r);
	return m;
};

const buildReactions = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-reactions");
	const map = reactionsByKind(n.reactions);
	for (const { kind, emoji } of REACTION_KINDS) {
		const r = map.get(kind);
		const count = r?.count ?? 0;
		const mine = r?.mine ?? false;
		// Hide zero-count kinds unless the viewer is signed in (so signed-in
		// users can react with a kind nobody else has used yet). Anonymous
		// readers see only used kinds.
		if (count === 0 && !ctx.me) continue;
		const btn = el("button", "gr-reaction");
		btn.type = "button";
		btn.dataset.kind = kind;
		if (mine) btn.dataset.mine = "1";
		btn.appendChild(document.createTextNode(emoji));
		if (count > 0) {
			btn.appendChild(el("span", "gr-reaction-count", String(count)));
		}
		btn.addEventListener("click", async () => {
			btn.disabled = true;
			try {
				const res = await fetch(`${ctx.apiBase}/api/v1/reactions`, {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ comment_id: n.id, kind }),
				});
				if (!res.ok) {
					btn.disabled = false;
					return;
				}
				ctx.reload();
			} catch {
				btn.disabled = false;
			}
		});
		wrap.appendChild(btn);
	}
	return wrap;
};

const buildActions = (n: TreeNode, ctx: WidgetCtx, main: HTMLElement): HTMLElement => {
	const row = el("div", "gr-actions");

	if (n.depth < 4 && n.status !== "deleted") {
		const replyBtn = el("button", undefined, "Reply");
		replyBtn.type = "button";
		replyBtn.addEventListener("click", () => {
			if (main.querySelector(".gr-reply-form")) return;
			main.appendChild(buildReplyForm(n, ctx));
		});
		row.appendChild(replyBtn);
	}

	const isOwn =
		ctx.me != null && n.author.id === ctx.me.id && n.status !== "deleted";
	const withinWindow = Date.now() - n.created_at < ctx.editWindowMs;
	if (isOwn && withinWindow) {
		const editBtn = el("button", undefined, "Edit");
		editBtn.type = "button";
		editBtn.addEventListener("click", () => {
			openEditor(n, ctx, main);
		});
		row.appendChild(editBtn);
	}
	if (isOwn) {
		const delBtn = el("button", undefined, "Delete");
		delBtn.type = "button";
		delBtn.addEventListener("click", async () => {
			// Plain confirm is the smallest robust UX; the widget doesn't
			// ship its own modal layer to keep the bundle small.
			if (!window.confirm("Delete this comment?")) return;
			try {
				const res = await fetch(
					`${ctx.apiBase}/api/v1/comments/${encodeURIComponent(n.id)}`,
					{ method: "DELETE", credentials: "include" },
				);
				if (res.ok) ctx.reload();
			} catch {
				// no-op; reload not triggered
			}
		});
		row.appendChild(delBtn);
	}

	return row;
};

const openEditor = (n: TreeNode, ctx: WidgetCtx, main: HTMLElement): void => {
	const bodyEl = main.querySelector(".gr-body");
	if (!bodyEl) return;
	const wrap = el("form", "gr-reply-form");
	wrap.setAttribute("data-mode", "edit");
	const ta = el("textarea");
	ta.value = ""; // Plain-text rewrite would require body_md from the server;
	// here we just let the user retype. To round-trip the source markdown,
	// the API should also return body_md for the author within the edit
	// window. (Tracked as a follow-up; the server-side update endpoint
	// already accepts raw markdown.)
	ta.placeholder = "Edit your comment…";
	ta.required = true;
	const actions = el("div", "gr-reply-actions");
	const save = el("button", undefined, "Save");
	save.type = "submit";
	const cancel = el("button", undefined, "Cancel");
	cancel.type = "button";
	cancel.addEventListener("click", () => wrap.remove());
	actions.append(save, cancel);
	wrap.append(ta, actions);
	wrap.addEventListener("submit", async (e) => {
		e.preventDefault();
		save.disabled = true;
		try {
			const res = await fetch(
				`${ctx.apiBase}/api/v1/comments/${encodeURIComponent(n.id)}`,
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
	ta.placeholder = `Reply to @${parent.author.name}…`;
	ta.required = true;

	let nameInput: HTMLInputElement | null = null;
	if (!ctx.me) {
		nameInput = el("input");
		nameInput.type = "text";
		nameInput.placeholder = "Your name";
		nameInput.required = true;
		wrap.appendChild(nameInput);
	}
	wrap.appendChild(ta);

	const actions = el("div", "gr-reply-actions");
	const submit = el("button", undefined, "Post reply");
	submit.type = "submit";
	const cancel = el("button", undefined, "Cancel");
	cancel.type = "button";
	cancel.addEventListener("click", () => wrap.remove());
	actions.append(submit, cancel);
	wrap.appendChild(actions);

	const errBox = el("div", "gr-error");
	errBox.hidden = true;
	wrap.appendChild(errBox);

	wrap.addEventListener("submit", async (e) => {
		e.preventDefault();
		submit.disabled = true;
		errBox.hidden = true;
		errBox.textContent = "";
		errBox.classList.remove("is-notice");
		const turnstileToken =
			(wrap.querySelector(
				'input[name="cf-turnstile-response"]',
			) as HTMLInputElement | null)?.value ?? "";
		try {
			const formTs = await getFormToken(ctx.apiBase);
			const res = await fetch(`${ctx.apiBase}/api/v1/comments`, {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					slug: ctx.slug,
					name: nameInput?.value ?? "",
					body: ta.value,
					parent_id: parent.id,
					turnstile_token: turnstileToken,
					website: "",
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
				errBox.textContent = json.error ?? `HTTP ${res.status}`;
				errBox.hidden = false;
				submit.disabled = false;
				return;
			}
			if (json.comment?.status === "pending") {
				errBox.textContent = "Comment submitted — awaiting moderation.";
				errBox.classList.add("is-notice");
				errBox.hidden = false;
				ta.value = "";
				submit.disabled = false;
				return;
			}
			ctx.reload();
		} catch (err) {
			errBox.textContent = String(err);
			errBox.hidden = false;
			submit.disabled = false;
		}
	});

	return wrap;
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
		meta.appendChild(el("span", "gr-verified", "verified"));
	}
	const timeText = `${fmtTime(n.created_at)}${n.edited_at ? " · edited" : ""}`;
	meta.appendChild(el("span", "gr-time", timeText));

	const body = el("div", "gr-body");
	if (n.status === "deleted") {
		const p = el("p", "gr-deleted", "[deleted]");
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

	if (n.status !== "deleted") {
		main.appendChild(buildReactions(n, ctx));
	}
	main.appendChild(buildActions(n, ctx, main));

	row.appendChild(main);
	return row;
};

const buildThread = (n: TreeNode, ctx: WidgetCtx): HTMLElement => {
	const wrap = el("div", "gr-thread");
	wrap.dataset.id = n.id;
	// Anchor id for the /c/:id permalink redirect to scroll into view.
	wrap.id = `garrul-comment-${n.id}`;
	wrap.appendChild(buildComment(n, ctx));
	if (n.replies.length > 0) {
		const replies = el("div", "gr-replies");
		for (const r of n.replies) replies.appendChild(buildThread(r, ctx));
		wrap.appendChild(replies);
	}
	return wrap;
};

const PROVIDER_LABELS: Record<"github" | "google", string> = {
	github: "GitHub",
	google: "Google",
};

const buildAuthBlock = (
	me: Me,
	apiBase: string,
	providers: ReadonlyArray<"github" | "google">,
	onSignedIn: () => void,
	onSignedOut: () => void,
): HTMLElement | null => {
	if (me) {
		const wrap = el("div", "gr-signed");
		wrap.appendChild(el("span", undefined, "Posting as "));
		wrap.appendChild(el("span", "gr-signed-name", `@${me.name}`));
		if (me.provider !== "anon") {
			wrap.appendChild(el("span", "gr-verified", "verified"));
		}
		const out = el("button", undefined, "Sign out");
		out.type = "button";
		out.addEventListener("click", async () => {
			out.disabled = true;
			try {
				await fetch(`${apiBase}/api/v1/auth/signout`, {
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
	wrap.appendChild(el("span", undefined, "Sign in to get a verified badge:"));
	for (const p of providers) {
		const btn = el("button", undefined, PROVIDER_LABELS[p]);
		btn.type = "button";
		btn.addEventListener("click", () => startOauth(p, apiBase, onSignedIn));
		wrap.appendChild(btn);
	}
	return wrap;
};

const buildForm = (siteKey: string | null, signedIn: boolean): HTMLFormElement => {
	const form = document.createElement("form");
	form.className = "gr-form";
	form.autocomplete = "off";

	if (!signedIn) {
		const name = el("input");
		name.className = "gr-name-input";
		name.name = "name";
		name.type = "text";
		name.placeholder = "Your name";
		name.required = true;
		form.appendChild(name);
	}

	const body = el("textarea");
	body.className = "gr-body-input";
	body.name = "body";
	body.placeholder = "Add a comment…";
	body.required = true;
	form.appendChild(body);

	const honey = el("input");
	honey.className = "gr-honeypot";
	honey.name = "website";
	honey.type = "text";
	honey.tabIndex = -1;
	honey.setAttribute("aria-hidden", "true");
	honey.autocomplete = "off";
	form.appendChild(honey);

	// Notify-me opt-in. Anonymous: an email field appears alongside the
	// checkbox. Signed-in: we already have their email so just the box.
	const notifyWrap = el("label", "gr-notify");
	const notifyCb = el("input") as HTMLInputElement;
	notifyCb.type = "checkbox";
	notifyCb.className = "gr-notify-cb";
	notifyCb.name = "notify";
	const notifyText = document.createTextNode(" Email me on new replies");
	notifyWrap.append(notifyCb, notifyText);
	form.appendChild(notifyWrap);

	if (!signedIn) {
		const emailInput = el("input") as HTMLInputElement;
		emailInput.className = "gr-email-input";
		emailInput.name = "email";
		emailInput.type = "email";
		emailInput.placeholder = "you@example.com";
		emailInput.autocomplete = "email";
		emailInput.hidden = true;
		notifyCb.addEventListener("change", () => {
			emailInput.hidden = !notifyCb.checked;
			emailInput.required = notifyCb.checked;
		});
		form.appendChild(emailInput);
	}

	// Turnstile only renders for anonymous posts. Signed-in posts skip it
	// server-side, so don't include the widget either.
	if (siteKey && !signedIn) {
		const t = el("div", "cf-turnstile");
		t.setAttribute("data-sitekey", siteKey);
		form.appendChild(t);
	}

	const submit = el("button", undefined, "Post comment");
	submit.type = "submit";

	const errBox = el("div", "gr-error");
	errBox.hidden = true;

	form.append(submit, errBox);
	return form;
};

const startOauth = (
	provider: "github" | "google",
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
		const data = e.data as { type?: string; ok?: boolean } | null;
		if (!data || data.type !== "garrul:auth") return;
		window.removeEventListener("message", handler);
		if (data.ok) onSuccess();
	};
	window.addEventListener("message", handler);
	if (!popup) {
		// Popup blocked — fall back to top-level redirect. The browser will
		// land back at /callback which sets the cookie + closes; the user
		// then has to navigate back manually. Documented behavior.
		window.location.href = url;
	}
};

const init = () => {
	const host = document.getElementById("garrul");
	if (!host) return;

	const slug = host.dataset.slug;
	if (!slug) {
		host.textContent = "[garrul] missing data-slug";
		return;
	}

	const scriptEl = document.currentScript as HTMLScriptElement | null;
	const apiBase =
		host.dataset.api ??
		(scriptEl ? new URL(scriptEl.src).origin : window.location.origin);

	const root = host.attachShadow({ mode: "open" });
	const style = el("style");
	style.textContent = STYLE_CSS;
	root.append(style, buildSkeleton());

	void load(root, slug, apiBase, host);
};

const renderError = (root: ShadowRoot, message: string) => {
	root.replaceChildren();
	const style = el("style");
	style.textContent = STYLE_CSS;
	const wrap = el("div", "gr-root");
	wrap.appendChild(el("div", "gr-error", `Could not load comments: ${message}`));
	root.append(style, wrap);
};

const fetchPage = async (
	apiBase: string,
	slug: string,
	cursor: string | null,
): Promise<ListResponse> => {
	const qs = new URLSearchParams({ slug });
	if (cursor) qs.set("before", cursor);
	const res = await fetch(`${apiBase}/api/v1/comments?${qs.toString()}`, {
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
		const res = await fetch(`${apiBase}/api/v1/auth/me`, {
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
const loadState = new WeakMap<
	ShadowRoot,
	{ running: boolean; queued: boolean }
>();

const load = async (
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
): Promise<void> => {
	let st = loadState.get(root);
	if (!st) {
		st = { running: false, queued: false };
		loadState.set(root, st);
	}
	if (st.running) {
		st.queued = true;
		return;
	}
	st.running = true;
	try {
		await loadOnce(root, slug, apiBase, host);
	} finally {
		st.running = false;
		if (st.queued) {
			st.queued = false;
			await load(root, slug, apiBase, host);
		}
	}
};

const loadOnce = async (
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
) => {
	let siteKey: string | null = null;
	let editWindowMinutes = 5;
	let providers: ReadonlyArray<"github" | "google"> = [];
	try {
		const cfgRes = await fetch(`${apiBase}/api/v1/config`, {
			credentials: "include",
		});
		if (cfgRes.ok) {
			const cfg = (await cfgRes.json()) as {
				turnstile_site_key?: string;
				edit_window_minutes?: number;
				providers?: string[];
			};
			siteKey = cfg.turnstile_site_key ?? null;
			editWindowMinutes = cfg.edit_window_minutes ?? 5;
			providers = (cfg.providers ?? []).filter(
				(p): p is "github" | "google" => p === "github" || p === "google",
			);
		}
	} catch {
		// /api/v1/config is optional; the widget still renders without Turnstile
		// (the server will reject anonymous POSTs in that case).
	}

	const [me, dataResult] = await Promise.all([
		fetchMe(apiBase),
		fetchPage(apiBase, slug, null).catch((err: unknown) => err),
	]);
	if (dataResult instanceof Error) {
		renderError(root, String(dataResult));
		return;
	}
	const data = dataResult as ListResponse;

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
		reload,
	};
	const authBlock = buildAuthBlock(me, apiBase, providers, reload, reload);
	// Mint the timing token now so the honeypot-timing heuristic has
	// real elapsed seconds to measure when the user eventually submits.
	prefetchFormToken(apiBase);
	const form = buildForm(siteKey, me != null);
	const list = el("div", "gr-list");
	if (data.threads.length === 0) {
		list.appendChild(el("p", "gr-empty", "Be the first to comment."));
	} else {
		appendThreads(list, data.threads, ctx);
	}
	if (authBlock) wrap.appendChild(authBlock);
	wrap.append(form, list);

	if (data.next_cursor) {
		const more = el("button", "gr-loadmore", "Load older comments");
		more.type = "button";
		let cursor: string | null = data.next_cursor;
		more.addEventListener("click", async () => {
			if (!cursor) return;
			more.disabled = true;
			try {
				const page = await fetchPage(apiBase, slug, cursor);
				appendThreads(list, page.threads, ctx);
				cursor = page.next_cursor;
				if (cursor) {
					more.disabled = false;
				} else {
					more.remove();
				}
			} catch (err) {
				more.disabled = false;
				const errBox = el("div", "gr-error", `Could not load more: ${String(err)}`);
				more.insertAdjacentElement("afterend", errBox);
			}
		});
		wrap.appendChild(more);
	}

	root.append(style, wrap);

	// Scroll a permalink target (#garrul-comment-<id>) into view once the
	// tree is in the DOM. Browsers don't auto-scroll to anchors inside a
	// shadow root, so we have to do it manually.
	if (window.location.hash.startsWith("#garrul-comment-")) {
		const target = root.getElementById(window.location.hash.slice(1));
		if (target) {
			target.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	}

	if (siteKey && !document.querySelector('script[src*="turnstile"]')) {
		const s = document.createElement("script");
		s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
		s.async = true;
		s.defer = true;
		// The host page's CSP can block this load (the script lives on the
		// host's document, not in the widget's Shadow DOM). Without this
		// handler the user just sees a form with no captcha, types a comment,
		// and gets a confusing "Spam check failed" on submit.
		s.onerror = () => {
			const tsBox = form.querySelector(".cf-turnstile") as HTMLElement | null;
			if (!tsBox) return; // signed-in path doesn't render Turnstile
			tsBox.hidden = true;
			const submitBtn = form.querySelector(
				"button[type=submit]",
			) as HTMLButtonElement | null;
			if (submitBtn) submitBtn.disabled = true;
			const errEl = form.querySelector(".gr-error") as HTMLElement | null;
			if (errEl) {
				errEl.textContent =
					"Anti-spam check couldn't load — the host page's CSP may be blocking https://challenges.cloudflare.com. Site owner: see Garrul's troubleshooting docs.";
				errEl.hidden = false;
			}
		};
		document.head.appendChild(s);
	}

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		void submit(form, root, slug, apiBase, host);
	});
};

const submit = async (
	form: HTMLFormElement,
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
) => {
	const errEl = form.querySelector(".gr-error") as HTMLElement | null;
	if (errEl) {
		errEl.hidden = true;
		errEl.textContent = "";
		errEl.classList.remove("is-notice");
	}
	const submitBtn = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
	if (submitBtn) submitBtn.disabled = true;

	const nameInput = form.querySelector(".gr-name-input") as HTMLInputElement | null;
	const name = nameInput?.value ?? "";
	const body = (form.querySelector(".gr-body-input") as HTMLTextAreaElement).value;
	const honeypot = (form.querySelector(".gr-honeypot") as HTMLInputElement).value;

	const tokenInput = form.querySelector(
		'input[name="cf-turnstile-response"]',
	) as HTMLInputElement | null;
	const turnstileToken = tokenInput?.value ?? "";

	try {
		const formTs = await getFormToken(apiBase);
		const res = await fetch(`${apiBase}/api/v1/comments`, {
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
			if (errEl) {
				errEl.textContent = json.error ?? `HTTP ${res.status}`;
				errEl.hidden = false;
			}
			if (submitBtn) submitBtn.disabled = false;
			return;
		}

		if (json.comment?.status === "pending") {
			if (errEl) {
				errEl.textContent = "Comment submitted — awaiting moderation.";
				errEl.classList.add("is-notice");
				errEl.hidden = false;
			}
			const bodyInput = form.querySelector(
				".gr-body-input",
			) as HTMLTextAreaElement | null;
			if (bodyInput) bodyInput.value = "";
			if (submitBtn) submitBtn.disabled = false;
			return;
		}

		// Fire-and-forget subscription — failure here doesn't roll back
		// the comment. The widget already has both inputs handy.
		const notifyCb = form.querySelector(".gr-notify-cb") as HTMLInputElement | null;
		const emailInput = form.querySelector(".gr-email-input") as HTMLInputElement | null;
		if (notifyCb?.checked) {
			const email = emailInput?.value.trim() ?? "";
			if (email) {
				void fetch(`${apiBase}/api/v1/subscribe`, {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ post_slug: slug, email }),
				}).catch(() => {});
			}
		}

		await load(root, slug, apiBase, host);
	} catch (err) {
		if (errEl) {
			errEl.textContent = String(err);
			errEl.hidden = false;
		}
		if (submitBtn) submitBtn.disabled = false;
	}
};

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
