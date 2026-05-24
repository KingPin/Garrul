import type { AdminComment, CommentStatus } from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { escapeHtml } from "../escape";

const authorCell = (c: AdminComment): string => {
	const name = c.author_name ?? "(deleted user)";
	const provider = c.author_provider ?? "anon";
	const avatar = c.author_avatar_url
		? `<img class="author-avatar" src="${escapeHtml(c.author_avatar_url)}" alt="" width="28" height="28">`
		: `<span class="author-avatar">${identiconSvg(c.user_id, 28)}</span>`;
	const badges: string[] = [];
	if (c.author_is_admin) badges.push('<span class="pill admin">admin</span>');
	if (c.author_is_banned) badges.push('<span class="pill banned">banned</span>');
	return `
<a class="author-cell" href="/admin/users/${escapeHtml(c.user_id)}">
  ${avatar}
  <span class="author-meta">
    <span class="author-name">${escapeHtml(name)} ${badges.join(" ")}</span>
    <span class="author-sub muted">${escapeHtml(provider)}</span>
  </span>
</a>`;
};

const actionButtons = (id: string, status: CommentStatus): string => {
	const parts: string[] = [];
	if (status !== "approved") {
		parts.push(
			`<button :disabled="busy" @click="busy=true; act('${id}','approve').finally(()=>busy=false)">${status === "deleted" || status === "spam" ? "Restore" : "Approve"}</button>`,
		);
	}
	if (status !== "spam" && status !== "deleted") {
		parts.push(
			`<button :disabled="busy" class="bad" @click="busy=true; act('${id}','spam').finally(()=>busy=false)">Spam</button>`,
		);
	}
	if (status !== "deleted") {
		parts.push(
			`<button :disabled="busy" class="bad" @click="busy=true; act('${id}','delete').finally(()=>busy=false)">Delete</button>`,
		);
	}
	return parts.join("");
};

export const renderQueue = (
	rows: AdminComment[],
	status: string,
	nextCursor: string | null,
): string => {
	const tabs = ["all", "approved", "pending", "spam", "deleted"]
		.map(
			(s) =>
				`<a href="/admin/queue?status=${s}" ${s === status ? 'style="font-weight:600"' : ""}>${s}</a>`,
		)
		.join(" · ");

	const rowsHtml = rows.length
		? rows
				.map(
					(c) => `
<tr x-data="{ busy: false }">
  <td><span class="pill ${c.status}">${c.status}</span></td>
  <td>${authorCell(c)}</td>
  <td>
    <div class="muted">${new Date(c.created_at).toISOString().slice(0, 16).replace("T", " ")}</div>
    <div><code>${escapeHtml(c.post_slug)}</code></div>
    <div class="muted" style="font-size:0.75rem">${escapeHtml(c.id)}</div>
  </td>
  <td class="row-body"><div class="md">${resanitizeBodyHtml(c.body_html)}</div></td>
  <td class="actions">${actionButtons(c.id, c.status)}</td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="5" class="muted">No comments match.</td></tr>`;

	const next = nextCursor
		? `<a href="/admin/queue?status=${status}&before=${encodeURIComponent(nextCursor)}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<div class="filter-bar"><span class="muted">filter:</span> ${tabs}</div>
<div class="card" x-data="{
  act(id, action) {
    return fetch('/admin/api/comments/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
      location.reload();
    });
  }
}">
  <table>
    <thead><tr><th>Status</th><th>Author</th><th>Meta</th><th>Body</th><th>Actions</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};
