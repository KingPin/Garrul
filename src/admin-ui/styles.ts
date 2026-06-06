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
/* ── Design tokens ──────────────────────────────────────────────────────
   Light is the default (:root). Dark is opt-in via [data-theme="dark"] on
   <html>. When the operator has made no explicit choice, the OS preference
   wins via the prefers-color-scheme block below (scoped to :not([data-theme])
   so an explicit data-theme="light" always beats a dark OS). */
:root {
  --bg: #f6f8fa; --surface: #ffffff; --surface-2: #f0f3f6;
  --border: #e2e7ec; --border-strong: #cdd5dd;
  --text: #1b2733; --muted: #5c6b7a;
  --accent: #2563eb; --accent-fg: #ffffff; --accent-weak: #e8f0fe;
  --ok: #15803d; --ok-weak: #e7f6ec;
  --warn: #b45309; --warn-weak: #fdf2e3;
  --bad: #dc2626; --bad-weak: #fdeaea;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10);
  --shadow-lg: 0 8px 28px rgba(16,24,40,.16);
  --radius: 10px; --radius-sm: 7px;
}
[data-theme="dark"] {
  --bg: #0b0d10; --surface: #131820; --surface-2: #0f141b;
  --border: #1e2530; --border-strong: #2a3340;
  --text: #e7eaf0; --muted: #8a93a6;
  --accent: #6aa9ff; --accent-fg: #0b0d10; --accent-weak: #16243a;
  --ok: #4ad295; --ok-weak: #11251c;
  --warn: #f7b955; --warn-weak: #2a2113;
  --bad: #ef6a6a; --bad-weak: #2a1717;
  --shadow: 0 1px 2px rgba(0,0,0,.4);
  --shadow-lg: 0 8px 28px rgba(0,0,0,.55);
  --radius: 10px; --radius-sm: 7px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --bg: #0b0d10; --surface: #131820; --surface-2: #0f141b;
    --border: #1e2530; --border-strong: #2a3340;
    --text: #e7eaf0; --muted: #8a93a6;
    --accent: #6aa9ff; --accent-fg: #0b0d10; --accent-weak: #16243a;
    --ok: #4ad295; --ok-weak: #11251c;
    --warn: #f7b955; --warn-weak: #2a2113;
    --bad: #ef6a6a; --bad-weak: #2a1717;
    --shadow: 0 1px 2px rgba(0,0,0,.4);
    --shadow-lg: 0 8px 28px rgba(0,0,0,.55);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
       font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
/* Consistent keyboard focus ring across all interactive chrome. The switch
   input manages its own ring (it's visually hidden), so exclude it here. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px;
                 border-radius: var(--radius-sm); }
.switch input:focus-visible { outline: none; }
/* ── App shell: fixed sidebar + scrolling content ───────────────────────── */
.app-shell { display: flex; min-height: 100vh; }
.sidebar { position: sticky; top: 0; align-self: flex-start; flex: 0 0 240px;
           width: 240px; height: 100vh; background: var(--surface);
           border-right: 1px solid var(--border); display: flex;
           flex-direction: column; overflow-y: auto; z-index: 50; }
.brand { display: flex; align-items: center; gap: 0.5rem; padding: 1rem 1.1rem;
         font-size: 1.1rem; font-weight: 700; color: var(--text);
         text-decoration: none; }
.brand:hover { text-decoration: none; }
.brand .icon { color: var(--accent); }
.sidebar-nav { flex: 1; padding: 0.25rem 0.6rem; }
.nav-section { margin-bottom: 1rem; }
.nav-heading { margin: 0.5rem 0.6rem 0.35rem; font-size: 0.68rem; font-weight: 600;
               text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.nav-link { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.6rem;
            border-radius: var(--radius-sm); color: var(--text); font-size: 0.9rem;
            text-decoration: none; }
.nav-link .icon { color: var(--muted); transition: color 0.12s; }
.nav-link:hover { background: var(--surface-2); text-decoration: none; }
.nav-link.active { background: var(--accent-weak); color: var(--accent); font-weight: 600; }
.nav-link.active .icon { color: var(--accent); }
.sidebar-footer { display: flex; align-items: center; gap: 0.5rem;
                  padding: 0.75rem 1.1rem; border-top: 1px solid var(--border); }
.sidebar-footer .me { color: var(--muted); font-size: 0.85rem; flex: 1; min-width: 0;
                      display: flex; align-items: center; gap: 0.4rem; }
.footer-actions { display: flex; gap: 0.3rem; flex: 0 0 auto; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center;
            min-width: 30px; height: 30px; padding: 0 0.4rem; background: transparent;
            border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--muted); }
.icon-btn:hover { background: var(--surface-2); color: var(--text); border-color: transparent; }
.content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 1.25rem;
          border-bottom: 1px solid var(--border); background: var(--surface);
          position: sticky; top: 0; z-index: 40; }
.topbar h1 { font-size: 1.05rem; margin: 0; font-weight: 600; }
.hamburger { display: none; }
.scrim { display: none; }
main { width: 100%; max-width: 1100px; margin: 1.5rem auto; padding: 0 1.25rem; }
.card { background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 1rem 1.25rem; margin-bottom: 1rem;
        box-shadow: var(--shadow); }
.card h2, .card h3 { margin-top: 0; }
.card-head { display: flex; align-items: center; justify-content: space-between;
             gap: 1rem; margin-bottom: 0.5rem; }
.card-head h2, .card-head h3 { margin: 0; }
.embed-snippet { background: var(--surface-2); border: 1px solid var(--border);
                 border-radius: var(--radius-sm); padding: 0.75rem 0.9rem; margin: 0;
                 overflow-x: auto; font-size: 0.82rem; line-height: 1.5; }
.embed-snippet code { background: transparent; padding: 0; }
.stat-grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.stat { background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 0.85rem 1.1rem; box-shadow: var(--shadow); }
.stat .v { font-size: 2rem; font-weight: 700; line-height: 1.1;
           font-variant-numeric: tabular-nums; color: var(--text); }
.stat .l { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
/* Status variants: tinted wash + colored value. */
.stat.ok { background: var(--ok-weak); border-color: transparent; }
.stat.ok .v { color: var(--ok); }
.stat.warn { background: var(--warn-weak); border-color: transparent; }
.stat.warn .v { color: var(--warn); }
.stat.bad { background: var(--bad-weak); border-color: transparent; }
.stat.bad .v { color: var(--bad); }
.stat.accent { background: var(--accent-weak); border-color: transparent; }
.stat.accent .v { color: var(--accent); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--border);
         text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 0.72rem; text-transform: uppercase;
     letter-spacing: 0.04em; position: sticky; top: 0; background: var(--surface);
     z-index: 1; }
tbody tr:nth-child(even) { background: var(--surface-2); }
tbody tr:hover { background: var(--accent-weak); }
.row-body { color: var(--text); max-width: 480px; overflow-wrap: anywhere; }
.row-body .md { font-size: 0.9rem; }
.pill { display: inline-block; padding: 0.12rem 0.5rem; border-radius: 999px;
        font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        border: 1px solid transparent; background: var(--surface-2); color: var(--muted); }
.pill.approved { color: var(--ok); background: var(--ok-weak); }
.pill.pending { color: var(--warn); background: var(--warn-weak); }
.pill.spam, .pill.deleted, .pill.banned { color: var(--bad); background: var(--bad-weak); }
.pill.admin { color: var(--accent); background: var(--accent-weak); }
.pill.mod { color: var(--warn); background: var(--warn-weak); }
button, .btn { display: inline-flex; align-items: center; gap: 0.4rem;
               background: var(--surface); color: var(--text); border: 1px solid var(--border);
               padding: 0.35rem 0.7rem; border-radius: var(--radius-sm); cursor: pointer;
               font-size: 0.85rem; font-weight: 500; transition: background 0.12s, border-color 0.12s; }
button:hover, .btn:hover { border-color: var(--border-strong); background: var(--surface-2); }
/* Primary: filled accent. */
button.btn-primary, .btn-primary { background: var(--accent); color: var(--accent-fg);
                                   border-color: var(--accent); }
button.btn-primary:hover, .btn-primary:hover { filter: brightness(1.05);
                                               border-color: var(--accent); background: var(--accent); }
/* Secondary alias keeps existing class="secondary" markup working. */
button.btn-secondary, .btn-secondary, button.secondary, .secondary {
  background: var(--surface-2); color: var(--text); border-color: var(--border); }
/* Danger; .bad is the historical alias used in <td class="actions"> rows. */
button.btn-danger, .btn-danger, button.bad, .btn.bad { color: var(--bad); }
button.btn-danger:hover, .btn-danger:hover, button.bad:hover, .btn.bad:hover {
  border-color: var(--bad); background: var(--bad-weak); }
button:disabled, .btn:disabled { opacity: 0.5; cursor: not-allowed; }
.actions { display: flex; gap: 0.4rem; }
.author-cell { display: flex; gap: 0.5rem; align-items: center; color: inherit;
               text-decoration: none; max-width: 180px; }
.author-cell:hover .author-name { text-decoration: underline; }
.author-avatar { display: inline-block; width: 28px; height: 28px;
                 border-radius: 50%; overflow: hidden; flex: 0 0 auto;
                 background: var(--surface-2); }
.author-avatar img, .author-avatar svg { width: 100%; height: 100%;
                                          display: block; border-radius: 50%; }
.author-meta { display: flex; flex-direction: column; min-width: 0;
               line-height: 1.15; }
.author-name { font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis;
               white-space: nowrap; }
.author-sub { font-size: 0.7rem; }
.filter-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 1rem; }
.filter-bar input[type=text], .filter-bar input[type=date] {
                                background: var(--surface); border: 1px solid var(--border);
                                color: var(--text); padding: 0.4rem 0.6rem;
                                border-radius: var(--radius-sm); }
.filter-bar input[type=text]:focus, .filter-bar input[type=date]:focus {
                                outline: 2px solid var(--accent); outline-offset: 1px;
                                border-color: var(--accent); }
.filter-bar input[type=text] { min-width: 200px; }
.filter-bar.queue-filter { flex-wrap: wrap; }
.filter-bar.queue-filter input[type=text] { min-width: 140px; }
.muted { color: var(--muted); }
.pager { display: flex; justify-content: space-between; margin-top: 1rem; }
.bulk-cell { width: 32px; }
.score-cell { width: 70px; text-align: center; font-variant-numeric: tabular-nums; }
.score { font-weight: 600; }
.score-pos { color: var(--ok); }
.score-neg { color: var(--bad); }
.bulk-bar { position: sticky; bottom: 0; display: flex; align-items: center;
            gap: 0.5rem; padding: 0.75rem 1rem; background: var(--surface);
            border-top: 1px solid var(--border); margin: 1rem -1rem -1rem;
            border-radius: 0 0 var(--radius) var(--radius); box-shadow: var(--shadow-lg); }
.bulk-bar span:first-child { font-weight: 600; margin-right: auto; }
[x-cloak] { display: none !important; }
.reply-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55);
               display: flex; align-items: flex-start; justify-content: center;
               padding-top: 6vh; z-index: 1100; }
.reply-modal-inner { background: var(--surface); border: 1px solid var(--border);
                     border-radius: var(--radius); padding: 1.25rem; width: min(560px, 92vw);
                     max-height: 85vh; overflow: auto; box-shadow: var(--shadow-lg); }
.reply-list { list-style: none; padding: 0; margin: 0 0 0.75rem; max-height: 30vh;
              overflow: auto; border: 1px solid var(--border); border-radius: 6px; }
.reply-list li { border-bottom: 1px solid var(--border); }
.reply-list li:last-child { border-bottom: none; }
.reply-pick { display: flex; justify-content: space-between; gap: 0.75rem;
              width: 100%; padding: 0.5rem 0.75rem; background: transparent;
              border: none; color: var(--text); text-align: left; cursor: pointer; }
.reply-pick:hover { background: var(--surface-2); }
.reply-pick.active { background: var(--accent); color: var(--accent-fg); }
.reply-pick.active .muted { color: var(--accent-fg); opacity: 0.85; }
.comment-card { border: 1px solid var(--border); border-radius: 6px;
                padding: 0.75rem; margin: 0.5rem 0; }
.comment-card-head { display: flex; justify-content: space-between;
                     align-items: center; gap: 1rem; margin-bottom: 0.25rem; }
.comment-card .md { margin-top: 0.5rem; font-size: 0.9rem; }
.user-head { display: flex; gap: 1rem; align-items: center; }
.user-meta { flex: 1; min-width: 0; }
.user-stats { display: flex; gap: 2rem; margin-top: 1rem;
              padding-top: 1rem; border-top: 1px solid var(--border); }
code { background: var(--surface-2); padding: 0.1rem 0.3rem; border-radius: 3px;
       font-family: ui-monospace, monospace; font-size: 0.85em; }
.toast-tray { position: fixed; right: 1rem; bottom: 1rem; display: flex;
              flex-direction: column; gap: 0.5rem; z-index: 1000;
              pointer-events: none; }
.toast { background: var(--surface); border: 1px solid var(--border);
         border-left: 3px solid var(--ok); border-radius: var(--radius-sm);
         padding: 0.6rem 0.9rem; box-shadow: var(--shadow-lg);
         max-width: 320px; font-size: 0.85rem; }
.toast.bad { border-left-color: var(--bad); }
.help-popover { position: fixed; bottom: 1rem; left: 1rem;
                background: var(--surface); border: 1px solid var(--border);
                border-radius: var(--radius); padding: 1rem 1.25rem; min-width: 220px;
                z-index: 900; box-shadow: var(--shadow-lg); }
.help-popover dl { display: grid; grid-template-columns: auto 1fr;
                   gap: 0.4rem 0.8rem; margin: 0; }
.help-popover dt { font-weight: 500; }
.help-popover dd { margin: 0; color: var(--muted); }
kbd { background: var(--surface-2); border: 1px solid var(--border);
      border-radius: 4px; padding: 0.05rem 0.4rem;
      font-family: ui-monospace, monospace; font-size: 0.8em; }
.dash-cols { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.dash-list { list-style: none; margin: 0; padding: 0; }
.dash-list li { padding: 0.25rem 0; border-bottom: 1px dashed var(--border); }
.dash-list li:last-child { border-bottom: 0; }
.banner { display: flex; gap: 1rem; align-items: center; justify-content: space-between;
          padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
.banner.update { background: var(--warn-weak); color: var(--warn); border-bottom-color: var(--border-strong); }
.banner.update a { color: var(--warn); text-decoration: underline; }
.banner.update code { background: rgba(0,0,0,0.08); color: inherit; }
.banner.update button { background: transparent; color: inherit; border-color: var(--border-strong); }
.banner.update button:hover { border-color: var(--warn); }
.link-list { list-style: none; padding: 0; margin: 0.5rem 0; display: grid;
             gap: 0.25rem; }
.link-list li { padding: 0.15rem 0; }
.release-card { border: 1px solid var(--border); border-radius: 6px;
                padding: 0.75rem 1rem; margin: 0.75rem 0; }
.release-card:last-child { margin-bottom: 0; }
.release-head { margin: 0 0 0.25rem; font-size: 1rem;
                display: flex; gap: 0.5rem; align-items: baseline;
                flex-wrap: wrap; }
.release-head a { font-family: ui-monospace, monospace; }
.release-name { color: var(--muted); font-weight: 400; font-size: 0.9rem; }
.release-body { font-size: 0.9rem; }
.release-body p:first-child { margin-top: 0; }
.release-body p:last-child { margin-bottom: 0; }
/* ── Shared controls (icons, switches, steppers, tabs, charts) ──────────── */
.icon { display: inline-block; vertical-align: -0.18em; flex: 0 0 auto; }
.field-row, .switch-row { display: flex; gap: 0.75rem; align-items: flex-start;
                          padding: 0.6rem 0; border-bottom: 1px solid var(--border); }
.field-row:last-child, .switch-row:last-child { border-bottom: 0; }
.switch-row { cursor: pointer; }
.field-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.field-text .muted { font-size: 0.8rem; }
.switch { position: relative; display: inline-flex; flex: 0 0 auto; margin-top: 0.1rem; }
.switch input { position: absolute; inset: 0; width: 100%; height: 100%;
                margin: 0; opacity: 0; cursor: pointer; }
.switch-track { width: 38px; height: 22px; border-radius: 999px;
                background: var(--border-strong); transition: background 0.15s;
                display: inline-block; position: relative; }
.switch-thumb { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
                border-radius: 50%; background: #fff; transition: transform 0.15s;
                box-shadow: 0 1px 2px rgba(0,0,0,0.35); }
.switch input:checked + .switch-track { background: var(--accent); }
.switch input:checked + .switch-track .switch-thumb { transform: translateX(16px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
.stepper { display: inline-flex; align-items: stretch; flex: 0 0 auto;
           border: 1px solid var(--border); border-radius: var(--radius-sm);
           overflow: hidden; background: var(--surface-2); }
.stepper-btn { background: transparent; border: 0; border-radius: 0;
               padding: 0 0.6rem; font-size: 1rem; line-height: 1; color: var(--muted); }
.stepper-btn:hover { background: var(--accent-weak); color: var(--text); border-color: transparent; }
.stepper input[type=number] { width: 3.5rem; border: 0; border-left: 1px solid var(--border);
                              border-right: 1px solid var(--border); background: var(--surface);
                              color: var(--text); text-align: center; padding: 0.35rem 0.25rem;
                              font-variant-numeric: tabular-nums; }
.tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border);
        margin-bottom: 1rem; flex-wrap: wrap; }
.tab { background: transparent; border: 0; border-bottom: 2px solid transparent;
       border-radius: 0; padding: 0.5rem 0.75rem; color: var(--muted);
       font-size: 0.9rem; cursor: pointer; }
.tab:hover { color: var(--text); border-color: transparent; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.chart { display: block; width: 100%; }
.settings-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }

/* Below 880px the sidebar becomes an off-canvas drawer toggled by the
   hamburger; a scrim covers the content behind it. navOpen drives both. */
@media (max-width: 880px) {
  .sidebar { position: fixed; top: 0; left: 0; height: 100vh;
             transform: translateX(-100%); transition: transform 0.2s ease;
             box-shadow: var(--shadow-lg); }
  .sidebar.open { transform: translateX(0); }
  .scrim { display: block; position: fixed; inset: 0; z-index: 45;
           background: rgba(0,0,0,0.45); }
  .hamburger { display: inline-flex; }
}

@media (max-width: 720px) {
  .topbar { padding: 0.5rem 0.75rem; }
  .topbar h1 { font-size: 0.95rem; }
  main { margin: 0.75rem auto; padding: 0 0.6rem; }
  .card { padding: 0.75rem 0.85rem; border-radius: 6px; }
  .card table { display: block; overflow-x: auto; }
  .author-cell { max-width: 140px; }
  .row-body { max-width: 280px; }
  .bulk-bar { flex-wrap: wrap; }
  .filter-bar.queue-filter { gap: 0.35rem; }
  .filter-bar.queue-filter input[type=text] { min-width: 120px; }
  .toast-tray { left: 0.5rem; right: 0.5rem; align-items: stretch; }
  .toast { max-width: none; }
}
`;
