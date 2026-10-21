/**
 * The static iframe shell's files (public/embed/index.html + _headers block),
 * kept pure so tests can check them without running a build.
 *
 * The CSP is what the Worker route sends for `/embed/<slug>`, with two
 * differences that follow from being static. The origin list is the whole
 * ALLOWED_ORIGINS set plus 'self', because no request-time `?api=` is known.
 * And there is no 'unsafe-inline' for scripts: the shell's logic is
 * /embed/frame.js, not an inline block.
 */
import { parseTomlVars } from "./upgrade/toml-vars";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type FrameBuildEnv = { allowed: string[] };

/**
 * ALLOWED_ORIGINS from wrangler.toml's top-level [vars], or null. Null means
 * "do not emit the static shell": the Worker route keeps serving
 * `/embed/?slug=…`, at the old cost, and reads the deployed env at request
 * time. Entries that are not bare http(s) origins are dropped, so nothing odd
 * reaches a header.
 *
 * Also null when the file has any `[env.<name>]` table or sets ENV = "dev".
 * The build cannot know which environment `wrangler deploy --env` will pick,
 * and top-level [vars] baked into a production deploy could publish a dev
 * `frame-ancestors *` (any site may frame the comment page) or a staging
 * allowlist that leaves the real blogs out.
 */
export const readFrameEnv = (wranglerToml: string | null): FrameBuildEnv | null => {
	if (wranglerToml === null) return null;
	if (/^\s*\[\[?env\./m.test(wranglerToml)) return null;
	const vars = parseTomlVars(wranglerToml);
	if (vars.ENV === "dev") return null;
	const allowed = (vars.ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => {
			try {
				return /^https?:\/\//.test(s) && new URL(s).origin === s;
			} catch {
				return false;
			}
		});
	if (allowed.length === 0) return null;
	return { allowed };
};

export const frameShellCsp = ({ allowed }: FrameBuildEnv): string => {
	const origins = ["'self'", ...allowed].join(" ");
	return [
		"default-src 'none'",
		`script-src ${origins} ${TURNSTILE_ORIGIN}`,
		`connect-src ${origins} ${TURNSTILE_ORIGIN}`,
		`frame-src ${origins} ${TURNSTILE_ORIGIN}`,
		"style-src 'unsafe-inline'",
		"img-src data: https:",
		"font-src data:",
		`frame-ancestors ${origins}`,
	].join("; ");
};

/**
 * Every path Static Assets may serve index.html at. With the default
 * html_handling only `/embed/` answers, but an operator who changes it would
 * otherwise get a copy with no frame-ancestors, frameable by any site.
 */
const SHELL_PATHS = ["/embed/", "/embed", "/embed/index.html"];

/**
 * `_headers` lines for the shell and /embed/frame.js. frame.js carries the
 * baked allowlist, so it gets the page's 5-minute lifetime: an hour would
 * keep a just-added blog's parent_origin refused that long after a deploy.
 */
export const frameShellHeaders = (env: FrameBuildEnv): string[] => [
	...SHELL_PATHS.flatMap((path) => [
		path,
		`  Content-Security-Policy: ${frameShellCsp(env)}`,
		"  Referrer-Policy: no-referrer",
		"  X-Content-Type-Options: nosniff",
		"  Cache-Control: public, max-age=300, no-transform",
	]),
	"/embed/frame.js",
	"  Cache-Control: public, max-age=300",
	"  X-Content-Type-Options: nosniff",
];

export const FRAME_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Comments</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
</style>
</head>
<body>
<script src="/embed/frame.js"></script>
</body>
</html>
`;
