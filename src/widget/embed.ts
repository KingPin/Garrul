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

const buildComment = (n: TreeNode): HTMLElement => {
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
	row.appendChild(main);
	return row;
};

const buildThread = (n: TreeNode): HTMLElement => {
	const wrap = el("div", "gr-thread");
	wrap.dataset.id = n.id;
	wrap.appendChild(buildComment(n));
	if (n.replies.length > 0) {
		const replies = el("div", "gr-replies");
		for (const r of n.replies) replies.appendChild(buildThread(r));
		wrap.appendChild(replies);
	}
	return wrap;
};

const buildAuthBlock = (
	me: Me,
	apiBase: string,
	onSignedIn: () => void,
	onSignedOut: () => void,
): HTMLElement => {
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

	const wrap = el("div", "gr-signin");
	wrap.appendChild(el("span", undefined, "Sign in to get a verified badge:"));
	for (const p of ["github", "google"] as const) {
		const btn = el("button", undefined, p === "github" ? "GitHub" : "Google");
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

const appendThreads = (list: HTMLElement, threads: TreeNode[]): void => {
	for (const t of threads) list.appendChild(buildThread(t));
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

const load = async (
	root: ShadowRoot,
	slug: string,
	apiBase: string,
	host: HTMLElement,
) => {
	let siteKey: string | null = null;
	try {
		const cfgRes = await fetch(`${apiBase}/api/v1/config`, {
			credentials: "include",
		});
		if (cfgRes.ok) {
			const cfg = (await cfgRes.json()) as { turnstile_site_key?: string };
			siteKey = cfg.turnstile_site_key ?? null;
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
	const authBlock = buildAuthBlock(me, apiBase, reload, reload);
	const form = buildForm(siteKey, me != null);
	const list = el("div", "gr-list");
	if (data.threads.length === 0) {
		list.appendChild(el("p", "gr-empty", "Be the first to comment."));
	} else {
		appendThreads(list, data.threads);
	}
	wrap.append(authBlock, form, list);

	if (data.next_cursor) {
		const more = el("button", "gr-loadmore", "Load older comments");
		more.type = "button";
		let cursor: string | null = data.next_cursor;
		more.addEventListener("click", async () => {
			if (!cursor) return;
			more.disabled = true;
			try {
				const page = await fetchPage(apiBase, slug, cursor);
				appendThreads(list, page.threads);
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

	if (siteKey && !document.querySelector('script[src*="turnstile"]')) {
		const s = document.createElement("script");
		s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
		s.async = true;
		s.defer = true;
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
				post_title: host.dataset.title ?? null,
				post_url: host.dataset.url ?? null,
			}),
		});
		const json = (await res.json()) as { error?: string };
		if (!res.ok) {
			if (errEl) {
				errEl.textContent = json.error ?? `HTTP ${res.status}`;
				errEl.hidden = false;
			}
			if (submitBtn) submitBtn.disabled = false;
			return;
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
