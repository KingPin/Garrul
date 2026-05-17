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
 *   4. Render the flat list once data arrives.
 *   5. On submit, POST /api/v1/comments. Reload list on success.
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

type CommentDto = {
	id: string;
	parent_id: string | null;
	body_html: string;
	status: "approved" | "pending" | "spam" | "deleted";
	edited_at: number | null;
	deleted_at: number | null;
	created_at: number;
	author: {
		id: string;
		name: string;
		provider: string;
		is_admin: boolean;
		avatar_svg: string | null;
		avatar_url: string | null;
	};
};

type ListResponse = { post: unknown; comments: CommentDto[] };

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
.gr-comment { display: flex; gap: 0.75rem; }
.gr-avatar { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%; overflow: hidden; }
.gr-avatar svg, .gr-avatar img { width: 100%; height: 100%; display: block; }
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
.gr-empty { color: var(--garrul-muted, #6b7280); margin: 0; }
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

const buildAvatar = (c: CommentDto): HTMLElement => {
	const wrap = el("div", "gr-avatar");
	if (c.author.avatar_url) {
		const img = el("img");
		img.setAttribute("src", c.author.avatar_url);
		img.setAttribute("alt", "");
		wrap.appendChild(img);
	} else if (c.author.avatar_svg) {
		wrap.appendChild(parseTrustedHtml(c.author.avatar_svg));
	}
	return wrap;
};

const buildComment = (c: CommentDto): HTMLElement => {
	const row = el("div", "gr-comment");
	row.dataset.id = c.id;
	row.appendChild(buildAvatar(c));

	const main = el("div");
	main.style.flex = "1";

	const meta = el("div", "gr-meta");
	meta.appendChild(el("span", "gr-name", c.author.name));
	if (c.author.provider !== "anon") {
		meta.appendChild(el("span", "gr-verified", "verified"));
	}
	const timeText = `${fmtTime(c.created_at)}${c.edited_at ? " · edited" : ""}`;
	meta.appendChild(el("span", "gr-time", timeText));

	const body = el("div", "gr-body");
	if (c.status === "deleted") {
		const p = el("p");
		p.appendChild(Object.assign(document.createElement("em"), { textContent: "[deleted]" }));
		body.appendChild(p);
	} else {
		// body_html is sanitized by src/lib/markdown.ts before storage.
		body.appendChild(parseTrustedHtml(c.body_html));
	}

	main.append(meta, body);
	row.appendChild(main);
	return row;
};

const buildForm = (siteKey: string | null): HTMLFormElement => {
	const form = document.createElement("form");
	form.className = "gr-form";
	form.autocomplete = "off";

	const name = el("input");
	name.className = "gr-name-input";
	name.name = "name";
	name.type = "text";
	name.placeholder = "Your name";
	name.required = true;

	const body = el("textarea");
	body.className = "gr-body-input";
	body.name = "body";
	body.placeholder = "Add a comment…";
	body.required = true;

	const honey = el("input");
	honey.className = "gr-honeypot";
	honey.name = "website";
	honey.type = "text";
	honey.tabIndex = -1;
	honey.setAttribute("aria-hidden", "true");
	honey.autocomplete = "off";

	const submit = el("button", undefined, "Post comment");
	submit.type = "submit";

	const errBox = el("div", "gr-error");
	errBox.hidden = true;

	form.append(name, body, honey);

	if (siteKey) {
		const t = el("div", "cf-turnstile");
		t.setAttribute("data-sitekey", siteKey);
		form.appendChild(t);
	}

	form.append(submit, errBox);
	return form;
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

	let data: ListResponse;
	try {
		const res = await fetch(
			`${apiBase}/api/v1/comments?slug=${encodeURIComponent(slug)}`,
			{ credentials: "include" },
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		data = (await res.json()) as ListResponse;
	} catch (err) {
		renderError(root, String(err));
		return;
	}

	root.replaceChildren();
	const style = el("style");
	style.textContent = STYLE_CSS;

	const wrap = el("div", "gr-root");
	const form = buildForm(siteKey);
	const list = el("div", "gr-list");
	if (data.comments.length === 0) {
		list.appendChild(el("p", "gr-empty", "Be the first to comment."));
	} else {
		for (const c of data.comments) list.appendChild(buildComment(c));
	}
	wrap.append(form, list);
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

	const name = (form.querySelector(".gr-name-input") as HTMLInputElement).value;
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
