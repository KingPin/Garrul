import type {
	AdminComment,
	AdminUserDetail,
	AuditRowWithAdmin,
	User,
	UserRole,
} from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { escapeHtml, jsLiteral } from "../escape";

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
	if (u.erased_at) badges.push('<span class="pill">erased</span>');
	const canManageRole = viewer.role === "admin" && viewer.id !== u.id;
	const roleControls = canManageRole
		? `
  <div class="actions" x-data="{ busy: false, role: ${jsLiteral(u.role)} }">
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
	// Mirrors the guards in `eraseUser`: an admin, never yourself, never another
	// admin (demote first — an erasure clears the provider_id their next login is
	// matched on). Offering a button that can only 400 is worse than no button.
	const canErase =
		viewer.role === "admin" && viewer.id !== u.id && u.role !== "admin";
	// Export has none of erasure's guards: it's a read, and an access request can
	// legitimately concern your own account or another admin's. Admin-only all the
	// same — the file is a personal-data dump.
	const canExport = viewer.role === "admin";
	return `
<div class="user-head">
  ${avatar}
  <div class="user-meta">
    <h2 style="margin:0">${escapeHtml(u.name)} ${badges.join(" ")}</h2>
    <div class="muted">${escapeHtml(u.email ?? "—")} · ${escapeHtml(u.provider)} · joined ${formatTs(u.created_at)}</div>
    <div class="muted"><code>${escapeHtml(u.id)}</code></div>
    ${u.erased_at ? `<div class="muted">Personal data erased ${formatTs(u.erased_at)}.</div>` : ""}
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
${roleControls}
${canExport ? exportPanel(u.id) : ""}
${canErase ? erasePanel() : ""}`;
};

/**
 * Art. 15 / Art. 20 response, as a file. A plain link rather than a fetch: the
 * route answers with `Content-Disposition: attachment`, so the browser's own
 * download path is both simpler and the one that won't hold a personal-data
 * payload in a JS variable.
 */
const exportPanel = (id: string): string => `
<details style="margin-top:1rem;border-top:1px solid #e5e7eb;padding-top:0.75rem">
  <summary style="cursor:pointer">Export personal data…</summary>
  <p class="muted">
    Everything the instance holds about this account, as JSON: profile,
    comments (including stored IP hashes and user agents), reports they filed,
    subscriptions for their address, Telegram link, votes and reactions, spam
    classifications, and moderation actions taken against them. Which moderator
    acted is omitted — that's a third party's data.
  </p>
  <p class="muted">
    The file is a personal-data export in the clear. Treat the download like a
    database dump, and confirm the requester's identity before sending it.
  </p>
  <p><a href="/admin/api/users/${encodeURIComponent(id)}/export">Download JSON</a></p>
</details>`;

/**
 * Erasure is irreversible, so the control is deliberately slow: it stays folded
 * away, and the button doesn't enable until the word ERASE is typed. The same
 * string goes in the request body, which the route requires — so a CSRF attempt
 * or a stray fetch can't erase anyone by hitting the URL.
 */
const erasePanel = (): string => `
<details style="margin-top:1rem;border-top:1px solid #e5e7eb;padding-top:0.75rem">
  <summary style="cursor:pointer">Erase personal data…</summary>
  <div x-data="{ busy: false, typed: '', bodies: false, done: false }">
    <p class="muted">
      Clears the display name, email, avatar and the provider/IP identifier on
      this account, plus the stored IP hash and user agent on every comment they
      wrote. Email subscriptions for their address and any linked Telegram
      account are removed, and their sessions are revoked. Votes, reactions and
      scores are left as they are.
    </p>
    <p class="muted">
      Comments are <strong>not</strong> deleted by default — the author becomes
      anonymous and the thread stays readable. Tick the box below if the comment
      text itself contains personal data.
    </p>
    <label style="display:block;margin:0.5rem 0">
      <input type="checkbox" x-model="bodies" :disabled="busy || done">
      Also blank their comment bodies and mark them deleted
    </label>
    <label style="display:block;margin:0.5rem 0">
      Type <code>ERASE</code> to confirm:
      <input type="text" x-model="typed" :disabled="busy || done"
             autocomplete="off" spellcheck="false" style="font:inherit">
    </label>
    <p class="muted">This cannot be undone.</p>
    <div class="actions">
      <button class="bad" :disabled="busy || done || typed !== 'ERASE'"
              @click="busy=true; erase(bodies).then(()=>{done=true}).finally(()=>busy=false)">
        Erase this user's data
      </button>
    </div>
    <template x-if="done">
      <p class="muted">Erased. Reload to see the anonymized record.</p>
    </template>
  </div>
</details>`;

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
  erase(bodies) {
    return fetch('/admin/api/users/${escapeHtml(u.id)}/erase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'ERASE', redact_bodies: bodies }),
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('action failed: ' + r.status));
      this.$dispatch('toast', { text: 'Personal data erased' });
      return j;
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
