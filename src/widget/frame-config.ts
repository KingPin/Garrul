/**
 * The iframe embed's inputs, resolved from its query string. DOM-free and
 * shared: the Worker route (src/routes/embed-iframe.ts) renders from it, and
 * so does the static shell (src/widget/frame.ts) in the browser, so the two
 * paths apply one set of rules. The route header documents each param.
 */
import { matchLocaleIn } from "./locale-match";

/** Named palettes shipped in src/widget/styles.css. Keep the two in step. */
export const FRAME_PRESETS: ReadonlySet<string> = new Set(["minimal", "soft", "contrast"]);

export type FrameEnv = {
	/** ALLOWED_ORIGINS entries. */
	allowed: readonly string[];
	/** Locale registry keys, for `<html lang>`. */
	locales: readonly string[];
	/** ENV=dev waives the parent-origin allowlist, as lib/cors.ts does. */
	dev: boolean;
};

export type FrameConfig = {
	apiBase: string;
	theme: "light" | "dark" | "auto";
	/** `<html lang>`: a locale that will actually render, else English. */
	docLang: string;
	/** postMessage target for the height protocol, or "" to stay silent. */
	parentOrigin: string;
	/** `data-*` attributes for the mount element, in emit order. */
	data: [string, string][];
};

/** The origin of an absolute http(s) URL, or null. */
export const safeApiOrigin = (raw: string): string | null => {
	if (!/^https?:\/\//i.test(raw)) return null;
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
};

/** Null when the slug is missing or too long: the caller answers "invalid slug". */
export const frameConfig = (
	slug: string,
	q: URLSearchParams,
	selfOrigin: string,
	env: FrameEnv,
): FrameConfig | null => {
	if (!slug || slug.length > 200) return null;
	const allowed = new Set(env.allowed);

	// `?api=` must be in ALLOWED_ORIGINS, or a crafted link could load
	// attacker-controlled JS into the frame.
	const override = safeApiOrigin(q.get("api") ?? "");
	const apiBase = override && allowed.has(override) ? override : selfOrigin;

	// Validated, not merely escaped: it reaches a CSS declaration.
	const themeRaw = q.get("theme") ?? "auto";
	const theme = themeRaw === "light" || themeRaw === "dark" ? themeRaw : "auto";
	const presetRaw = q.get("preset") ?? "";
	const preset = FRAME_PRESETS.has(presetRaw) ? presetRaw : "";
	const mode = q.get("mode") === "reactions" ? "reactions" : "";
	// `data-lang` forwards the raw request; `<html lang>` only ever claims a
	// locale that exists.
	const lang = q.get("lang") ?? "";
	const docLang = matchLocaleIn(env.locales, lang) ?? "en";
	// Passed through, not validated: the server parses it as post_published.
	const published = q.get("published") ?? "";

	// Must already be a bare origin, and an allowlisted one (or this Worker's
	// own, which the Turnstile frame inside uses). No referrer fallback.
	const parentRaw = q.get("parent_origin") ?? "";
	let parentOrigin = "";
	if (parentRaw && safeApiOrigin(parentRaw) === parentRaw) {
		if (env.dev || parentRaw === selfOrigin || allowed.has(parentRaw)) parentOrigin = parentRaw;
	}

	const data: [string, string][] = [
		["slug", slug],
		["api", apiBase],
		["title", q.get("title") ?? ""],
		["url", q.get("url") ?? ""],
	];
	if (published) data.push(["published", published]);
	data.push(["theme", theme]);
	if (preset) data.push(["preset", preset]);
	data.push(["lang", lang]);
	if (mode) data.push(["mode", mode]);

	return { apiBase, theme, docLang, parentOrigin, data };
};
