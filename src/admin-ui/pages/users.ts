import type { User } from "../../db/queries";
import { escapeHtml } from "../escape";

export const renderUsers = (
	rows: User[],
	q: string,
	nextCursor: string | null,
): string => {
	const rowsHtml = rows.length
		? rows
				.map(
					(u) => `
<tr x-data="{ busy: false, banned: ${u.is_banned} }">
  <td>
    <div>${escapeHtml(u.name)} ${u.is_admin ? '<span class="pill admin">admin</span>' : ""}
      <span x-show="banned" class="pill banned">banned</span></div>
    <div class="muted">${escapeHtml(u.email ?? "—")}</div>
  </td>
  <td>${escapeHtml(u.provider)}</td>
  <td class="muted">${new Date(u.created_at).toISOString().slice(0, 10)}</td>
  <td class="actions">
    <template x-if="!banned">
      <button :disabled="busy" class="bad" @click="busy=true; setBanned('${u.id}', true).then(()=>{banned=true}).finally(()=>busy=false)">Ban</button>
    </template>
    <template x-if="banned">
      <button :disabled="busy" @click="busy=true; setBanned('${u.id}', false).then(()=>{banned=false}).finally(()=>busy=false)">Unban</button>
    </template>
  </td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="4" class="muted">No users match.</td></tr>`;

	const queryStr = q ? `&q=${encodeURIComponent(q)}` : "";
	const next = nextCursor
		? `<a href="/admin/users?before=${encodeURIComponent(nextCursor)}${queryStr}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<div class="card" x-data="{
  setBanned(id, banned) {
    return fetch('/admin/api/users/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ banned }),
    }).then(r => {
      if (!r.ok) throw new Error('action failed: ' + r.status);
    });
  }
}">
  <form class="filter-bar" method="get" action="/admin/users">
    <input type="text" name="q" placeholder="search name or email" value="${escapeHtml(q)}">
    <button type="submit">Search</button>
    ${q ? '<a href="/admin/users">clear</a>' : ""}
  </form>
  <table>
    <thead><tr><th>User</th><th>Provider</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};
