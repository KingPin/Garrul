import type { AdminComment, CommentStatus } from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { escapeHtml } from "../escape";

export type QueueFilters = {
	status: CommentStatus | "all";
	q: string;
	post_slug: string;
	user_id: string;
	from: string;
	to: string;
};

const queryString = (f: QueueFilters): string => {
	const params = new URLSearchParams();
	if (f.status !== "pending") params.set("status", f.status);
	if (f.q) params.set("q", f.q);
	if (f.post_slug) params.set("post_slug", f.post_slug);
	if (f.user_id) params.set("user_id", f.user_id);
	if (f.from) params.set("from", f.from);
	if (f.to) params.set("to", f.to);
	const s = params.toString();
	return s ? `?${s}` : "";
};

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
	filters: QueueFilters,
	nextCursor: string | null,
): string => {
	const tabs = ["all", "approved", "pending", "spam", "deleted"]
		.map((s) => {
			// Status tabs preserve every other active filter — clicking
			// "spam" while a search is active should keep the search.
			const tabFilters = { ...filters, status: s as QueueFilters["status"] };
			const href = `/admin/queue${queryString(tabFilters)}`;
			return `<a href="${href}" ${s === filters.status ? 'style="font-weight:600"' : ""}>${s}</a>`;
		})
		.join(" · ");

	const hasFilters =
		filters.q ||
		filters.post_slug ||
		filters.user_id ||
		filters.from ||
		filters.to;
	const filterBar = `
<form class="filter-bar queue-filter" method="get" action="/admin/queue">
  <input type="hidden" name="status" value="${escapeHtml(filters.status)}">
  <input type="text" name="q" placeholder="search body" value="${escapeHtml(filters.q)}">
  <input type="text" name="post_slug" placeholder="post slug" value="${escapeHtml(filters.post_slug)}">
  <input type="date" name="from" value="${escapeHtml(filters.from)}" title="from (UTC)">
  <input type="date" name="to" value="${escapeHtml(filters.to)}" title="to (UTC, inclusive)">
  ${filters.user_id ? `<input type="hidden" name="user_id" value="${escapeHtml(filters.user_id)}"><span class="muted">user: <code>${escapeHtml(filters.user_id)}</code></span>` : ""}
  <button type="submit">Filter</button>
  ${hasFilters ? `<a href="/admin/queue?status=${escapeHtml(filters.status)}" class="muted">clear</a>` : ""}
</form>`;

	const rowsHtml = rows.length
		? rows
				.map(
					(c) => `
<tr x-data="{ busy: false }">
  <td class="bulk-cell"><input type="checkbox" :value="'${c.id}'" x-model="selected" :disabled="busy"></td>
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
		: `<tr><td colspan="6" class="muted">No comments match.</td></tr>`;

	const allIds = rows.map((r) => r.id);

	const qs = queryString(filters);
	const nextHref = nextCursor
		? `/admin/queue${qs}${qs ? "&" : "?"}before=${encodeURIComponent(nextCursor)}`
		: null;
	const next = nextHref
		? `<a href="${nextHref}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<div class="filter-bar"><span class="muted">filter:</span> ${tabs}</div>
${filterBar}
<div class="card" x-data="{
  selected: [],
  bulkBusy: false,
  allIds: ${JSON.stringify(allIds)},
  toggleAll(e) {
    this.selected = e.target.checked ? this.allIds.slice() : [];
  },
  act(id, action) {
    return fetch('/admin/api/comments/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
      location.reload();
    });
  },
  bulk(action) {
    if (this.selected.length === 0) return;
    if (!confirm(action + ' ' + this.selected.length + ' comment(s)?')) return;
    this.bulkBusy = true;
    return fetch('/admin/api/comments/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: this.selected, action }),
    }).then(r => {
      if (!r.ok) throw new Error('bulk action failed: ' + r.status);
      location.reload();
    }).finally(() => { this.bulkBusy = false; });
  }
}">
  <table>
    <thead><tr>
      <th class="bulk-cell"><input type="checkbox" @change="toggleAll($event)" :checked="selected.length > 0 && selected.length === allIds.length"></th>
      <th>Status</th><th>Author</th><th>Meta</th><th>Body</th><th>Actions</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
  <div class="bulk-bar" x-show="selected.length > 0" x-cloak>
    <span><span x-text="selected.length"></span> selected</span>
    <button :disabled="bulkBusy" @click="bulk('approve')">Approve</button>
    <button :disabled="bulkBusy" class="bad" @click="bulk('spam')">Spam</button>
    <button :disabled="bulkBusy" class="bad" @click="bulk('delete')">Delete</button>
    <button :disabled="bulkBusy" @click="selected = []">Clear</button>
  </div>
</div>`;
};
