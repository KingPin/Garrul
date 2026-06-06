import type { Bindings } from "../../index";
import type {
	AdminStats,
	CommentsByHostRow,
	SpamRate,
	TimelinePoint,
	TopCommenter,
	TopPost,
} from "../../db/queries";
import { spamSummary } from "../components/spam-summary";
import { identiconSvg } from "../../lib/identicon";
import { barChartSvg } from "../charts";
import { escapeHtml } from "../escape";

export type DashboardData = {
	stats: AdminStats;
	timeline: TimelinePoint[];
	top_posts: TopPost[];
	top_commenters: TopCommenter[];
	oldest_pending: { id: string; created_at: number } | null;
	spam_rate: SpamRate;
	by_host: CommentsByHostRow[];
};

const relAge = (ts: number, now: number = Date.now()): string => {
	const diff = Math.max(0, now - ts);
	const m = Math.floor(diff / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	const hRem = h % 24;
	return hRem ? `${d}d ${hRem}h` : `${d}d`;
};

const topPostsList = (posts: TopPost[]): string => {
	if (posts.length === 0)
		return '<li class="muted">No approved comments yet.</li>';
	return posts
		.map((p) => {
			const label = p.title?.trim() || p.post_slug;
			const href = `/admin/queue?status=all&post_slug=${encodeURIComponent(p.post_slug)}`;
			return `<li><a href="${href}">${escapeHtml(label)}</a> <span class="muted">· ${p.count}</span></li>`;
		})
		.join("");
};

const topCommentersList = (commenters: TopCommenter[]): string => {
	if (commenters.length === 0)
		return '<li class="muted">No approved comments yet.</li>';
	return commenters
		.map((u) => {
			const avatar = u.avatar_url
				? `<img class="author-avatar" src="${escapeHtml(u.avatar_url)}" alt="" width="20" height="20">`
				: `<span class="author-avatar" style="width:20px;height:20px">${identiconSvg(u.user_id, 20)}</span>`;
			return `<li><a href="/admin/users/${escapeHtml(u.user_id)}" style="display:inline-flex;gap:0.4rem;align-items:center">${avatar}${escapeHtml(u.name)}</a> <span class="muted">· ${u.count}</span></li>`;
		})
		.join("");
};

const oldestPendingCell = (
	oldest: { id: string; created_at: number } | null,
): string => {
	if (!oldest)
		return '<div class="muted">No pending comments.</div>';
	return `<a href="/admin/comments/${escapeHtml(oldest.id)}">${relAge(oldest.created_at)} ago</a>`;
};

const spamRatePct = (r: SpamRate): string => {
	if (r.total === 0) return "—";
	const pct = (r.spam / r.total) * 100;
	return `${pct.toFixed(1)}%`;
};

const HOSTS_VISIBLE = 10;

const byHostPanel = (rows: CommentsByHostRow[]): string => {
	if (rows.length === 0)
		return `<div class="card"><h3>Comments by domain</h3><div class="muted">No comments yet.</div></div>`;
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
  <td>${r.pending}</td>
  <td>${r.spam}</td>
  <td class="muted">${rate}%</td>
</tr>`;
		})
		.join("");
	const more = overflow > 0
		? `<div class="muted" style="font-size:0.85em;margin-top:0.4rem">…and ${overflow} more domain${overflow === 1 ? "" : "s"}</div>`
		: "";
	return `
<div class="card">
  <h3>Comments by domain</h3>
  <table>
    <thead><tr>
      <th>Host</th><th>Total</th><th>Pending</th><th>Spam</th><th>Spam %</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  ${more}
</div>`;
};

// Best-effort public origin for the embed snippet. PUBLIC_BASE_URL is the
// operator-configured canonical URL of this Worker; if it's unset (e.g. a
// fresh dev instance) we fall back to a clearly-placeholder host so the
// snippet still reads correctly and the operator knows what to replace.
const embedOrigin = (env: Bindings): string => {
	const raw = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
	return raw || "https://comments.example.com";
};

const embedCard = (env: Bindings): string => {
	const origin = escapeHtml(embedOrigin(env));
	// The snippet is shown verbatim AND copied from $refs.embed.textContent,
	// so it must be valid host markup with entities the browser decodes back
	// to real characters on copy. data-slug is a placeholder the operator
	// swaps per page.
	const snippet = `&lt;div id="garrul" data-slug="YOUR_PAGE_SLUG" data-api="${origin}"&gt;&lt;/div&gt;
&lt;script src="${origin}/embed.js" defer&gt;&lt;/script&gt;`;
	return `
<div class="card" x-data>
  <div class="card-head">
    <h3>Embed on your site</h3>
    <button class="btn btn-secondary"
            @click="navigator.clipboard && navigator.clipboard.writeText($refs.embed.textContent).then(
              () => $dispatch('toast', { text: 'Embed code copied' }),
              () => $dispatch('toast', { text: 'Copy failed', kind: 'bad' }))">Copy</button>
  </div>
  <p class="muted">Paste this where comments should appear. Set <code>data-slug</code> to a stable per-page id.</p>
  <pre class="embed-snippet" x-ref="embed"><code>${snippet}</code></pre>
</div>`;
};

export const renderDashboard = (
	data: DashboardData,
	env: Bindings,
): string => {
	const { stats, timeline, top_posts, top_commenters, oldest_pending, spam_rate, by_host } = data;
	return `
<div class="card">
  <h2>Overview</h2>
  <div class="stat-grid">
    <div class="stat accent"><div class="v">${stats.total_comments}</div><div class="l">total comments</div></div>
    <div class="stat${stats.pending_comments > 0 ? " warn" : ""}"><div class="v">${stats.pending_comments}</div><div class="l">pending</div></div>
    <div class="stat${stats.spam_comments > 0 ? " bad" : ""}"><div class="v">${stats.spam_comments}</div><div class="l">spam</div></div>
    <div class="stat"><div class="v">${stats.total_users}</div><div class="l">users</div></div>
    <div class="stat${stats.banned_users > 0 ? " bad" : ""}"><div class="v">${stats.banned_users}</div><div class="l">banned</div></div>
    <div class="stat">
      <div class="v" style="font-size:1.1rem">${oldestPendingCell(oldest_pending)}</div>
      <div class="l">oldest pending</div>
    </div>
    <div class="stat">
      <div class="v">${spamRatePct(spam_rate)}</div>
      <div class="l">spam rate (30d)</div>
    </div>
  </div>
  <p class="muted">Anti-spam: ${spamSummary(env)}. See <a href="/admin/settings">Settings</a> to change.</p>
</div>

${embedCard(env)}

<div class="card">
  <h3>Comments per day (30d)</h3>
  ${barChartSvg(timeline)}
</div>

<div class="dash-cols">
  <div class="card">
    <h3>Top posts (30d)</h3>
    <ul class="dash-list">${topPostsList(top_posts)}</ul>
  </div>
  <div class="card">
    <h3>Top commenters (30d)</h3>
    <ul class="dash-list">${topCommentersList(top_commenters)}</ul>
  </div>
</div>

${byHostPanel(by_host)}

<div class="card">
  <h3>Quick actions</h3>
  <ul>
    <li><a href="/admin/queue?status=pending">Review ${stats.pending_comments} pending comment(s)</a></li>
    <li><a href="/admin/queue?status=spam">Inspect spam folder</a></li>
    <li><a href="/admin/audit">Audit log</a></li>
    <li><a href="/admin/users">Manage users</a></li>
  </ul>
</div>`;
};
