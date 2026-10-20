/**
 * The static iframe shell's script: public/embed/frame.js, loaded by
 * public/embed/index.html at `/embed/?slug=…`. Static Assets serves both
 * without running the Worker, so an iframe pageview costs only the widget's
 * own API calls.
 *
 * It does in the browser what src/routes/embed-iframe.ts does on the server
 * for `/embed/<slug>`: resolve the query through frameConfig, write the mount
 * element, load embed.js, and report the content height to the parent. The
 * allowlist and locale list are baked in at build time (scripts/build-embed.ts);
 * the page's CSP, from the same build, is what actually pins who may frame it.
 */
import { frameConfig } from "./frame-config";

declare const __GARRUL_FRAME_ENV__: {
	allowed: string[];
	locales: string[];
	dev: boolean;
};

const q = new URLSearchParams(location.search);
const cfg = frameConfig(q.get("slug") ?? "", q, location.origin, __GARRUL_FRAME_ENV__);

if (!cfg) {
	document.body.textContent = "invalid slug";
} else {
	const root = document.documentElement;
	root.lang = cfg.docLang;
	root.style.colorScheme = cfg.theme === "auto" ? "light dark" : cfg.theme;

	const host = document.createElement("div");
	host.id = "garrul";
	for (const [k, v] of cfg.data) host.setAttribute(`data-${k}`, v);
	document.body.append(host);

	const script = document.createElement("script");
	script.src = `${cfg.apiBase}/embed.js`;
	document.body.append(script);

	const parentOrigin = cfg.parentOrigin;
	if (window.parent !== window && parentOrigin) {
		let lastHeight = 0;
		const post = () => {
			const h = Math.max(root.scrollHeight, document.body.scrollHeight);
			if (h === lastHeight) return;
			lastHeight = h;
			window.parent.postMessage({ type: "garrul:height", height: h }, parentOrigin);
		};
		// ResizeObserver covers most changes; MutationObserver catches Shadow DOM
		// updates that don't resize the body (the skeleton-to-tree swap).
		new ResizeObserver(post).observe(document.body);
		new MutationObserver(post).observe(document.body, { childList: true, subtree: true });
		window.addEventListener("load", post);
		setTimeout(post, 100);
	}
}
