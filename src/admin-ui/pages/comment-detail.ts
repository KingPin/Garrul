import type {
	AdminComment,
	AdminCommentDetail,
	AuditRowWithAdmin,
	CommentStatus,
	Report,
	SpamVerdictRow,
} from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { escapeHtml, jsLiteral } from "../escape";

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const authorBlock = (c: AdminComment): string => {
	const name = c.author_name ?? "(deleted user)";
	const avatar = c.author_avatar_url
		? `<img class="author-avatar" src="${escapeHtml(c.author_avatar_url)}" alt="" width="40" height="40">`
		: `<span class="author-avatar" style="width:40px;height:40px">${identiconSvg(c.user_id, 40)}</span>`;
	const badges: string[] = [];
	if (c.author_is_admin) badges.push('<span class="pill admin">admin</span>');
	if (c.author_is_banned) badges.push('<span class="pill banned">banned</span>');
	return `
<div class="author-cell" style="max-width:none">
  ${avatar}
  <span class="author-meta">
    <span class="author-name"><a href="/admin/users/${escapeHtml(c.user_id)}">${escapeHtml(name)}</a> ${badges.join(" ")}</span>
    <span class="author-sub muted">${escapeHtml(c.author_provider ?? "anon")} · <code>${escapeHtml(c.user_id)}</code></span>
  </span>
</div>`;
};

const commentCard = (c: AdminComment, heading: string): string => `
<div class="comment-card">
  <div class="muted" style="font-size:0.75rem">${heading}</div>
  <div class="comment-card-head">
    ${authorBlock(c)}
    <span class="pill ${c.status}">${c.status}</span>
  </div>
  <div class="muted" style="font-size:0.75rem">
    ${formatTs(c.created_at)} · <code>${escapeHtml(c.post_slug)}</code>
    · <a href="/admin/comments/${escapeHtml(c.id)}">${escapeHtml(c.id)}</a>
  </div>
  <div class="md">${resanitizeBodyHtml(c.body_html)}</div>
</div>`;

const verdictPill = (v: SpamVerdictRow): string => {
	const klass =
		v.verdict === "spam"
			? "spam"
			: v.verdict === "ham"
				? "approved"
				: "pending";
	const score = v.score != null ? ` ${v.score.toFixed(2)}` : "";
	return `<span class="pill ${klass}">${escapeHtml(v.source)}: ${escapeHtml(v.verdict)}${score}</span>`;
};

const verdictsSection = (verdicts: SpamVerdictRow[]): string => {
	if (verdicts.length === 0) return "";
	const rows = verdicts
		.map(
			(v) => `
<tr>
  <td>${verdictPill(v)}</td>
  <td class="muted">${formatTs(v.created_at)}</td>
  <td class="row-body"><code style="font-size:0.7rem">${escapeHtml(v.raw ?? "")}</code></td>
</tr>`,
		)
		.join("");
	return `
<div class="card">
  <h3>Spam verdicts</h3>
  <table>
    <thead><tr><th>Verdict</th><th>When</th><th>Raw</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
};

/**
 * Reader reports for the selected comment. Reasons are free-text from
 * (possibly anonymous) reporters, so they're escaped here. Reporter identity
 * (ip_hash / user_id) is intentionally NOT shown — operators act on the
 * content, not the reporter, and exposing the hash adds no moderation value.
 * "Dismiss reports" resolves every OPEN report on the comment in one click.
 */
const reportsSection = (commentId: string, reports: Report[]): string => {
	if (reports.length === 0) return "";
	const open = reports.filter((r) => r.status === "open");
	const rows = reports
		.map(
			(r) => `
<tr>
  <td><span class="pill ${r.status === "open" ? "pending" : "approved"}">${r.status}</span></td>
  <td class="muted">${formatTs(r.created_at)}</td>
  <td class="row-body">${r.reason ? escapeHtml(r.reason) : '<span class="muted">(no reason given)</span>'}</td>
</tr>`,
		)
		.join("");
	const dismiss =
		open.length > 0
			? `
  <div class="actions" style="margin-top:0.5rem"
       x-data="{ busy: false,
         resolve() {
           this.busy = true;
           return fetch('/admin/api/comments/${escapeHtml(commentId)}/reports/resolve', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: '{}',
           }).then(r => {
             if (!r.ok) throw new Error('action failed: ' + r.status);
             this.$dispatch('toast', { text: 'Reports dismissed' });
             setTimeout(() => location.reload(), 600);
           }).catch(e => {
             this.$dispatch('toast', { text: e.message, kind: 'bad' });
           }).finally(() => { this.busy = false; });
         }
       }">
    <button :disabled="busy" @click="resolve()">Dismiss reports</button>
  </div>`
			: "";
	return `
<div class="card">
  <h3>Reader reports (${open.length} open / ${reports.length} total)</h3>
  <table>
    <thead><tr><th>Status</th><th>When</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${dismiss}
</div>`;
};

const auditSection = (rows: AuditRowWithAdmin[], title: string): string => {
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
  <h3>${title}</h3>
  <table>
    <thead><tr><th>When</th><th>Action</th><th>Admin</th><th>Reason</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>
</div>`;
};

/**
 * One-click "Ban author" — reuses POST /admin/api/users/:id { banned } with the
 * comment's author and records the originating comment in the audit meta.
 * Admin-only (the ban route is admin-gated). For anonymous (ghost) authors a
 * ban blocks the hashed IP, i.e. the whole network egress — behind CGNAT or a
 * shared IP that can catch bystanders, so the confirm copy spells that out.
 */
const banAuthorAction = (c: AdminComment, isAdmin: boolean): string => {
	if (!isAdmin) return "";
	if (c.author_is_banned) {
		return `<div class="muted" style="margin-top:0.5rem">Author is already banned.</div>`;
	}
	const isAnon = (c.author_provider ?? "anon") === "anon";
	const warning = isAnon
		? "Ban this anonymous author? This blocks their hashed IP (the whole network egress) — behind shared IPs/CGNAT it can also block bystanders. Continue?"
		: "Ban this author? They will no longer be able to comment. Continue?";
	return `
<div class="actions" style="margin-top:0.5rem" x-data="{ busy: false,
  ban() {
    if (!confirm(${jsLiteral(warning)})) return;
    this.busy = true;
    return fetch('/admin/api/users/${escapeHtml(c.user_id)}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ banned: true, from_comment: ${jsLiteral(c.id)} }),
    }).then(r => {
      if (!r.ok) throw new Error('ban failed: ' + r.status);
      this.$dispatch('toast', { text: 'Author banned' });
      setTimeout(() => location.reload(), 600);
    }).catch(e => {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    }).finally(() => { this.busy = false; });
  }
}">
  <button class="bad" :disabled="busy" @click="ban()">Ban author</button>
</div>`;
};

const actionsFor = (status: CommentStatus): string => {
	const parts: string[] = [];
	if (status !== "approved")
		parts.push(
			`<button :disabled="busy" @click="busy=true; act('approve').finally(()=>busy=false)">${status === "spam" || status === "deleted" ? "Restore" : "Approve"}</button>`,
		);
	if (status !== "spam" && status !== "deleted")
		parts.push(
			`<button :disabled="busy" class="bad" @click="busy=true; act('spam').finally(()=>busy=false)">Spam</button>`,
		);
	if (status !== "deleted")
		parts.push(
			`<button :disabled="busy" class="bad" @click="busy=true; act('delete').finally(()=>busy=false)">Delete</button>`,
		);
	return parts.join("");
};

export const renderCommentDetail = (
	d: AdminCommentDetail,
	isAdmin = false,
): string => {
	const { comment, parent, replies, ip_siblings, user_recent, verdicts, reports, audit } = d;
	const parentSection = parent
		? `<div class="card">${commentCard(parent, "Parent")}</div>`
		: "";
	const repliesSection = replies.length
		? `<div class="card">
		     <h3>Replies (${replies.length})</h3>
		     ${replies.map((r) => commentCard(r, `Reply`)).join("")}
		   </div>`
		: "";
	const siblingsSection = ip_siblings.length
		? `<div class="card" x-data="{ open: false }">
		     <h3 style="cursor:pointer" @click="open = !open">
		       IP-hash siblings (${ip_siblings.length})
		       <span class="muted" x-text="open ? '▼' : '▶'"></span>
		     </h3>
		     <div x-show="open" x-cloak>
		       ${ip_siblings.map((s) => commentCard(s, `Same IP-hash`)).join("")}
		     </div>
		   </div>`
		: "";
	const userRecentSection = user_recent.length
		? `<div class="card">
		     <h3>Other comments by this author (latest 5)</h3>
		     ${user_recent.map((s) => commentCard(s, `Recent`)).join("")}
		   </div>`
		: "";

	return `
<a href="/admin/queue" class="muted">← back to queue</a>
<div class="card" x-data="{
  busy: false,
  act(action) {
    this.busy = true;
    return fetch('/admin/api/comments/${escapeHtml(comment.id)}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
      this.$dispatch('toast', { text: action + 'd' });
      setTimeout(() => location.reload(), 600);
    }).catch(e => {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    }).finally(() => { this.busy = false; });
  }
}">
  <h2>Comment</h2>
  ${commentCard(comment, "Selected")}
  <div class="actions" style="margin-top:0.5rem">${actionsFor(comment.status)}</div>
  ${banAuthorAction(comment, isAdmin)}
</div>

<div class="card">
  <h3>Raw markdown</h3>
  <pre style="white-space:pre-wrap;font-size:0.85rem">${escapeHtml(comment.body_md)}</pre>
</div>

${reportsSection(comment.id, reports)}
${verdictsSection(verdicts)}
${parentSection}
${repliesSection}
${siblingsSection}
${userRecentSection}
${auditSection(audit, "Audit history for this comment")}
`;
};
