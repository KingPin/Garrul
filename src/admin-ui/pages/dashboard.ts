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

const sparklineSvg = (points: TimelinePoint[]): string => {
	if (points.length === 0)
		return '<div class="muted">No activity in this range.</div>';
	const w = 320;
	const h = 60;
	const pad = 4;
	const max = Math.max(1, ...points.map((p) => p.count));
	const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
	const coords = points.map((p, i) => {
		const x = pad + i * step;
		const y = h - pad - ((h - pad * 2) * p.count) / max;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const path = `M ${coords.join(" L ")}`;
	const last = points[points.length - 1];
	const first = points[0];
	return `
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
     aria-label="Comments per day sparkline">
  <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
  <title>${points.length} days · peak ${max}/day</title>
</svg>
<div class="muted" style="font-size:0.75rem">
  ${escapeHtml(first?.day ?? "")} → ${escapeHtml(last?.day ?? "")} · peak ${max}/day
</div>`;
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

export const renderDashboard = (
	data: DashboardData,
	env: Bindings,
): string => {
	const { stats, timeline, top_posts, top_commenters, oldest_pending, spam_rate, by_host } = data;
	return `
<div class="card">
  <h2>Overview</h2>
  <div class="stat-grid">
    <div class="stat"><div class="v">${stats.total_comments}</div><div class="l">total comments</div></div>
    <div class="stat"><div class="v">${stats.pending_comments}</div><div class="l">pending</div></div>
    <div class="stat"><div class="v">${stats.spam_comments}</div><div class="l">spam</div></div>
    <div class="stat"><div class="v">${stats.total_users}</div><div class="l">users</div></div>
    <div class="stat"><div class="v">${stats.banned_users}</div><div class="l">banned</div></div>
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

<div class="card">
  <h3>Comments per day (30d)</h3>
  ${sparklineSvg(timeline)}
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
