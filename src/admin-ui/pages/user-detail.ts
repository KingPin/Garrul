import type {
	AdminComment,
	AdminUserDetail,
	AuditRowWithAdmin,
	User,
	UserRole,
} from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { escapeHtml } from "../escape";

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const rolePill = (role: UserRole): string => {
	if (role === "admin") return '<span class="pill admin">admin</span>';
	if (role === "mod") return '<span class="pill mod">mod</span>';
	return "";
};

const userHeader = (d: AdminUserDetail, viewer: User): string => {
	const u = d.user;
	const avatar = u.avatar_url
		? `<img class="author-avatar" src="${escapeHtml(u.avatar_url)}" alt="" width="64" height="64">`
		: `<span class="author-avatar" style="width:64px;height:64px">${identiconSvg(u.id, 64)}</span>`;
	const badges: string[] = [];
	const pill = rolePill(u.role);
	if (pill) badges.push(pill);
	if (u.is_banned) badges.push('<span class="pill banned">banned</span>');
	const canManageRole = viewer.role === "admin" && viewer.id !== u.id;
	const roleControls = canManageRole
		? `
  <div class="actions" x-data="{ busy: false, role: ${escapeHtml(JSON.stringify(u.role))} }">
    <template x-if="role !== 'user'">
      <button :disabled="busy" @click="busy=true; setRole('user').then(r=>{role=r}).finally(()=>busy=false)">Demote to user</button>
    </template>
    <template x-if="role !== 'mod'">
      <button :disabled="busy" @click="busy=true; setRole('mod').then(r=>{role=r}).finally(()=>busy=false)">Make mod</button>
    </template>
    <template x-if="role !== 'admin'">
      <button :disabled="busy" @click="busy=true; setRole('admin').then(r=>{role=r}).finally(()=>busy=false)">Make admin</button>
    </template>
  </div>`
		: "";
	return `
<div class="user-head">
  ${avatar}
  <div class="user-meta">
    <h2 style="margin:0">${escapeHtml(u.name)} ${badges.join(" ")}</h2>
    <div class="muted">${escapeHtml(u.email ?? "—")} · ${escapeHtml(u.provider)} · joined ${formatTs(u.created_at)}</div>
    <div class="muted"><code>${escapeHtml(u.id)}</code></div>
  </div>
  <div class="actions" x-data="{ busy: false, banned: ${u.is_banned} }">
    <template x-if="!banned">
      <button :disabled="busy" class="bad" @click="busy=true; setBanned(true).then(()=>{banned=true}).finally(()=>busy=false)">Ban</button>
    </template>
    <template x-if="banned">
      <button :disabled="busy" @click="busy=true; setBanned(false).then(()=>{banned=false}).finally(()=>busy=false)">Unban</button>
    </template>
  </div>
</div>
${roleControls}`;
};

const commentRow = (c: AdminComment): string => `
<tr>
  <td><span class="pill ${c.status}">${c.status}</span></td>
  <td class="muted">${formatTs(c.created_at)}</td>
  <td><code>${escapeHtml(c.post_slug)}</code></td>
  <td class="row-body"><div class="md">${resanitizeBodyHtml(c.body_html)}</div></td>
  <td><a href="/admin/comments/${escapeHtml(c.id)}">open →</a></td>
</tr>`;

const auditTable = (rows: AuditRowWithAdmin[]): string => {
	if (rows.length === 0) return "";
	const trs = rows
		.map(
			(r) => `
<tr>
  <td>${formatTs(r.created_at)}</td>
  <td><span class="pill">${escapeHtml(r.action)}</span></td>
  <td>${escapeHtml(r.admin_name ?? r.admin_id)}</td>
  <td class="muted">${escapeHtml(r.reason ?? "")}</td>
</tr>`,
		)
		.join("");
	return `
<div class="card">
  <h3>Audit history affecting this user</h3>
  <table>
    <thead><tr><th>When</th><th>Action</th><th>Admin</th><th>Reason</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>
</div>`;
};

export const renderUserDetail = (
	d: AdminUserDetail,
	viewer: User,
): string => {
	const u = d.user;
	const commentsHtml = d.comments.length
		? d.comments.map(commentRow).join("")
		: `<tr><td colspan="5" class="muted">No comments yet.</td></tr>`;
	const nextHref = d.next_cursor
		? `/admin/users/${escapeHtml(u.id)}?before=${encodeURIComponent(d.next_cursor)}`
		: null;
	const next = nextHref
		? `<a href="${nextHref}">Next →</a>`
		: '<span class="muted">end</span>';
	return `
<a href="/admin/users" class="muted">← back to users</a>
<div class="card" x-data="{
  setBanned(banned) {
    return fetch('/admin/api/users/${escapeHtml(u.id)}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ banned }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
      this.$dispatch('toast', { text: banned ? 'User banned' : 'User unbanned' });
    }).catch(e => {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
      throw e;
    });
  },
  setRole(role) {
    return fetch('/admin/api/users/${escapeHtml(u.id)}/role', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('action failed: ' + r.status));
      this.$dispatch('toast', { text: 'Role updated to ' + j.role });
      return j.role;
    }).catch(e => {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
      throw e;
    });
  }
}">
  ${userHeader(d, viewer)}
  <div class="user-stats">
    <div><span class="muted">Reactions received:</span> ${d.reactions_received}</div>
  </div>
</div>

<div class="card">
  <h3>Comments by ${escapeHtml(u.name)}</h3>
  <p class="muted">All statuses, newest first.</p>
  <table>
    <thead><tr><th>Status</th><th>When</th><th>Post</th><th>Body</th><th></th></tr></thead>
    <tbody>${commentsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>

${auditTable(d.audit)}
`;
};
