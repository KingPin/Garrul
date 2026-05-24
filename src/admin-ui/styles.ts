// SRI for the Alpine.js build the admin layout loads from jsdelivr. If
// the version in the <script> tag changes, regenerate this with:
//   curl -fsSL https://cdn.jsdelivr.net/npm/alpinejs@<ver>/dist/cdn.min.js \
//     | openssl dgst -sha384 -binary | openssl base64 -A
export const ALPINE_VERSION = "3.13.5";
export const ALPINE_SRI =
	"sha384-BxpSbjbDhVKwnC1UfcjsNEuMuxg4af5IXOaSi1Iq5rASQ/9a7uslhEXbP9UI/fXo";

export const ADMIN_CSP = [
	"default-src 'self'",
	// 'unsafe-eval' is required by Alpine.js's x-data expression evaluator
	// (Alpine compiles directive expressions at runtime). Confined to
	// /admin/* via this header; the public API + widget pages keep their
	// stricter CSP.
	//
	// 'unsafe-inline' is intentionally absent: Alpine attribute directives
	// (x-data="...", @click="...") are governed by 'unsafe-eval' not
	// 'unsafe-inline', and the admin layout has no inline <script> tags.
	// The pinned + SRI-verified Alpine CDN load is the only script source.
	//
	// static.cloudflareinsights.com is allowed because Cloudflare zones
	// with Web Analytics enabled auto-inject the RUM beacon into HTML
	// responses; without this entry the admin page logs a CSP violation
	// on every load. The beacon POSTs telemetry back to
	// cloudflareinsights.com (different host), so connect-src lists it too.
	"script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https:",
	"connect-src 'self' https://cloudflareinsights.com",
	"frame-ancestors 'none'",
].join("; ");

export const ADMIN_CSS = `
:root {
  --bg: #0b0d10; --panel: #131820; --border: #1e2530; --text: #e7eaf0;
  --muted: #8a93a6; --accent: #6aa9ff; --warn: #f7b955; --bad: #ef6a6a;
  --ok: #4ad295;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
       font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header { background: var(--panel); border-bottom: 1px solid var(--border);
         padding: 0.75rem 1rem; display: flex; gap: 1.5rem; align-items: center; }
header h1 { font-size: 1rem; margin: 0; }
header nav { display: flex; gap: 1rem; flex: 1; }
header .me { color: var(--muted); }
main { max-width: 1100px; margin: 1.5rem auto; padding: 0 1rem; }
.card { background: var(--panel); border: 1px solid var(--border);
        border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
.stat-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.stat { background: var(--bg); border: 1px solid var(--border);
        border-radius: 6px; padding: 0.75rem 1rem; }
.stat .v { font-size: 1.5rem; font-weight: 600; }
.stat .l { color: var(--muted); font-size: 0.8rem; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5rem 0.5rem; border-bottom: 1px solid var(--border);
         text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 0.8rem; text-transform: uppercase; }
.row-body { color: var(--text); max-width: 480px; overflow-wrap: anywhere; }
.row-body .md { font-size: 0.9rem; }
.pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
        font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em;
        border: 1px solid var(--border); color: var(--muted); }
.pill.approved { color: var(--ok); border-color: var(--ok); }
.pill.pending { color: var(--warn); border-color: var(--warn); }
.pill.spam, .pill.deleted, .pill.banned { color: var(--bad); border-color: var(--bad); }
.pill.admin { color: var(--accent); border-color: var(--accent); }
button, .btn { background: var(--bg); color: var(--text); border: 1px solid var(--border);
               padding: 0.3rem 0.6rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
button:hover { border-color: var(--accent); }
button.bad { color: var(--bad); }
button.bad:hover { border-color: var(--bad); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 0.4rem; }
.author-cell { display: flex; gap: 0.5rem; align-items: center; color: inherit;
               text-decoration: none; max-width: 180px; }
.author-cell:hover .author-name { text-decoration: underline; }
.author-avatar { display: inline-block; width: 28px; height: 28px;
                 border-radius: 50%; overflow: hidden; flex: 0 0 auto;
                 background: var(--bg); }
.author-avatar img, .author-avatar svg { width: 100%; height: 100%;
                                          display: block; border-radius: 50%; }
.author-meta { display: flex; flex-direction: column; min-width: 0;
               line-height: 1.15; }
.author-name { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; }
.author-sub { font-size: 0.7rem; }
.filter-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; }
.filter-bar input[type=text], .filter-bar input[type=date] {
                                background: var(--bg); border: 1px solid var(--border);
                                color: var(--text); padding: 0.4rem 0.6rem;
                                border-radius: 6px; }
.filter-bar input[type=text] { min-width: 200px; }
.filter-bar.queue-filter { flex-wrap: wrap; }
.filter-bar.queue-filter input[type=text] { min-width: 140px; }
.muted { color: var(--muted); }
.pager { display: flex; justify-content: space-between; margin-top: 1rem; }
.bulk-cell { width: 32px; }
.bulk-bar { position: sticky; bottom: 0; display: flex; align-items: center;
            gap: 0.5rem; padding: 0.75rem 1rem; background: var(--card);
            border-top: 1px solid var(--border); margin: 1rem -1rem -1rem;
            border-radius: 0 0 8px 8px; }
.bulk-bar span:first-child { font-weight: 600; margin-right: auto; }
[x-cloak] { display: none !important; }
code { background: var(--bg); padding: 0.1rem 0.3rem; border-radius: 3px;
       font-family: ui-monospace, monospace; font-size: 0.85em; }
.banner { display: flex; gap: 1rem; align-items: center; justify-content: space-between;
          padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.banner.update { background: #2a1f08; color: #f7d77a; border-bottom-color: #4a3a14; }
.banner.update a { color: #ffd57a; text-decoration: underline; }
.banner.update code { background: rgba(0,0,0,0.25); color: inherit; }
.banner.update button { background: transparent; color: inherit; border-color: #4a3a14; }
.banner.update button:hover { border-color: #f7d77a; }
`;
