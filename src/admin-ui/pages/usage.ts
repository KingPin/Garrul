/**
 * Cloudflare usage dashboard — renders today's Workers / D1 / KV usage
 * against the free-tier ceilings. Two render modes:
 *
 *   renderUsageSetup()    — token absent. Shows the wrangler secret put
 *                           commands and the required token scopes.
 *   renderUsageDashboard() — token present. Shows three usage panels,
 *                           each with its own success/error state.
 *
 * Chart strategy: each panel emits a tiny inline SVG bar with the
 * free-tier ceiling drawn as a vertical line. No JS chart library —
 * keeps the admin bundle thin and the page renderable without
 * client-side execution.
 */
import { escapeHtml } from "../escape";
import type { Panel, UsageSnapshot } from "../../lib/cf-usage";
import type { CommentsByHostRow } from "../../db/queries";

// Free-tier limits as of 2026-05. Update alongside Cloudflare's docs.
const LIMITS = {
	workers_requests_per_day: 100_000,
	d1_reads_per_day: 5_000_000,
	d1_writes_per_day: 100_000,
	d1_storage_bytes: 5 * 1024 * 1024 * 1024,
	kv_reads_per_day: 100_000,
	kv_writes_per_day: 1_000,
} as const;

const fmt = (n: number): string => n.toLocaleString("en-US");

const pct = (used: number, ceiling: number): number =>
	ceiling === 0 ? 0 : Math.min(100, (used / ceiling) * 100);

const barColor = (p: number): string =>
	p >= 90 ? "var(--bad)" : p >= 75 ? "var(--warn)" : "var(--ok)";

// Single-bar SVG with the ceiling tick. Width is fluid via viewBox so
// it scales inside the card.
const usageBar = (used: number, ceiling: number, label: string): string => {
	const p = pct(used, ceiling);
	const c = barColor(p);
	return `
<div class="usage-row">
  <div class="usage-label">
    <strong>${escapeHtml(label)}</strong>
    <span class="muted">${fmt(used)} / ${fmt(ceiling)}</span>
  </div>
  <svg viewBox="0 0 200 14" preserveAspectRatio="none"
       style="width:100%;height:14px;background:var(--surface-2);border-radius:3px"
       role="img" aria-label="${escapeHtml(`${label}: ${p.toFixed(1)}%`)}">
    <rect x="0" y="0" width="${p * 2}" height="14" fill="${c}"/>
  </svg>
  <div class="muted" style="font-size:0.75rem">${p.toFixed(1)}% of free-tier ceiling</div>
</div>`;
};

const panelError = (label: string, err: string): string => `
<div class="card">
  <h3 style="margin-top:0">${escapeHtml(label)}</h3>
  <p class="muted">Couldn't fetch this metric: <code>${escapeHtml(err)}</code></p>
</div>`;

const workersPanel = (
	w: Panel<{ today: number; last30d: number }>,
): string => {
	if (!w.ok) return panelError("Workers", w.error);
	return `
<div class="card">
  <h3 style="margin-top:0">Workers requests</h3>
  ${usageBar(w.data.today, LIMITS.workers_requests_per_day, "Today")}
  <p class="muted" style="margin-top:0.6rem">
    Last 30 days: <strong>${fmt(w.data.last30d)}</strong> total requests.
  </p>
</div>`;
};

const d1Panel = (
	d: Panel<{
		reads_today: number;
		writes_today: number;
		storage_bytes: number | null;
	}>,
): string => {
	if (!d.ok) return panelError("D1", d.error);
	return `
<div class="card">
  <h3 style="margin-top:0">D1 database</h3>
  ${usageBar(d.data.reads_today, LIMITS.d1_reads_per_day, "Row reads (today)")}
  ${usageBar(d.data.writes_today, LIMITS.d1_writes_per_day, "Row writes (today)")}
  <p class="muted" style="font-size:0.8rem;margin-top:0.6rem">
    Storage size is not exposed via the analytics API — check the
    <a href="https://dash.cloudflare.com" target="_blank" rel="noopener">Cloudflare dashboard</a>
    for current consumption (free-tier ceiling: ${fmt(LIMITS.d1_storage_bytes / 1024 / 1024 / 1024)} GB).
  </p>
</div>`;
};

const kvPanel = (
	k: Panel<{
		reads_today: number;
		writes_today: number;
		storage_bytes: number | null;
	}>,
): string => {
	if (!k.ok) return panelError("KV", k.error);
	return `
<div class="card">
  <h3 style="margin-top:0">KV namespaces</h3>
  ${usageBar(k.data.reads_today, LIMITS.kv_reads_per_day, "Reads (today)")}
  ${usageBar(k.data.writes_today, LIMITS.kv_writes_per_day, "Writes (today)")}
  <p class="muted" style="font-size:0.8rem;margin-top:0.6rem">
    Includes every KV namespace on the account. Garrul uses four:
    <code>SESSIONS</code>, <code>OAUTH_STATE</code>, <code>RATE_LIMITS</code>,
    <code>TREE_CACHE</code>.
  </p>
</div>`;
};

const HOSTS_VISIBLE = 10;

const byHostPanel = (rows: CommentsByHostRow[]): string => {
	if (rows.length === 0) return "";
	const visible = rows.slice(0, HOSTS_VISIBLE);
	const overflow = rows.length - visible.length;
	const trs = visible
		.map((r) => {
			const rate = r.total > 0 ? ((r.spam / r.total) * 100).toFixed(1) : "0.0";
			const href = `/admin/queue?status=all&host=${encodeURIComponent(r.host)}`;
			return `
<tr>
  <td><a href="${href}"><code>${escapeHtml(r.host)}</code></a></td>
  <td>${r.total}</td>
  <td class="muted">${rate}%</td>
</tr>`;
		})
		.join("");
	const more = overflow > 0
		? `<div class="muted" style="font-size:0.85em;margin-top:0.4rem">…and ${overflow} more domain${overflow === 1 ? "" : "s"}</div>`
		: "";
	return `
<div class="card">
  <h3 style="margin-top:0">Comments by domain</h3>
  <table>
    <thead><tr><th>Host</th><th>Total</th><th>Spam %</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>
  ${more}
</div>`;
};

export const renderUsageDashboard = (
	snapshot: UsageSnapshot,
	byHost: CommentsByHostRow[] = [],
): string => {
	const asOf = new Date(snapshot.asOf).toISOString().replace("T", " ").slice(0, 16);
	return `
<div class="card">
  <h2 style="margin-top:0">Cloudflare usage</h2>
  <p class="muted">
    Live counters from Cloudflare's GraphQL Analytics API.
    Cached for 5 minutes (snapshot: <code>${escapeHtml(asOf)} UTC</code>).
    Free-tier ceilings shown next to each bar; bars turn yellow at 75%
    and red at 90%.
  </p>
</div>
${workersPanel(snapshot.workers)}
${d1Panel(snapshot.d1)}
${kvPanel(snapshot.kv)}
${byHostPanel(byHost)}`;
};

export const renderUsageSetup = (byHost: CommentsByHostRow[] = []): string => `
<div class="card">
  <h2 style="margin-top:0">Cloudflare usage — not configured</h2>
  <p>
    This page surfaces today's Workers, D1, and KV usage against the
    free-tier ceilings so you can see headroom before you hit a limit.
    It's fully optional — the rest of the admin works without it.
  </p>
  <h3>Setup</h3>
  <ol>
    <li>
      Create a Cloudflare API token at
      <a href="https://dash.cloudflare.com/profile/api-tokens"
         target="_blank" rel="noopener">dash.cloudflare.com/profile/api-tokens</a>
      with the following least-privilege scopes:
      <ul>
        <li><code>Account · Account Analytics · Read</code></li>
        <li><code>Account · D1 · Read</code></li>
        <li><code>Account · Workers KV Storage · Read</code></li>
      </ul>
    </li>
    <li>
      Find your account ID in the right sidebar of any zone's overview
      page (or run <code>wrangler whoami</code>).
    </li>
    <li>
      Set the two secrets and redeploy:
      <pre><code>wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID</code></pre>
    </li>
  </ol>
  <p class="muted">
    The token never leaves the Worker — there is no client-side JS that
    sees it, and it's not echoed in any UI. The Worker validates it on
    first load with a low-privilege <code>/user/tokens/verify</code>
    probe.
  </p>
</div>
${byHostPanel(byHost)}`;

export const renderUsageTokenError = (
	error: string,
	byHost: CommentsByHostRow[] = [],
): string => `
<div class="card">
  <h2 style="margin-top:0">Cloudflare usage — token error</h2>
  <p>
    The <code>CF_API_TOKEN</code> currently configured did not validate.
    Cloudflare's verify endpoint returned: <code>${escapeHtml(error)}</code>.
  </p>
  <p>
    Common causes: the token was revoked, the wrong account ID is set,
    or a scope was dropped. Re-create the token with the three scopes
    listed in the setup guide and run <code>wrangler secret put
    CF_API_TOKEN</code> again.
  </p>
</div>
${byHostPanel(byHost)}`;
