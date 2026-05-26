/**
 * Saved Replies admin page — canned moderator responses.
 *
 * Two surfaces:
 *   - renderSavedRepliesList(replies, viewer)
 *     Tabular list of every reply visible to the viewer. Each row links
 *     to /admin/saved-replies/:id for edit; the new-reply button opens
 *     /admin/saved-replies/new.
 *   - renderSavedReplyForm(opts)
 *     The form is reused for both create and edit. The mode is implicit
 *     in `opts.existing`: when present, the form posts to PATCH; when
 *     absent, to POST.
 *
 * Mutate buttons only render when the viewer owns the reply — the API
 * enforces this server-side regardless, but hiding the buttons keeps
 * the UI honest.
 */
import type { SavedReply, User } from "../../db/queries";
import { escapeHtml } from "../escape";

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const ownerCell = (
	reply: SavedReply,
	viewer: User,
	ownerName: string | null,
): string => {
	if (reply.owner_id === viewer.id) return '<span class="muted">you</span>';
	return ownerName ? escapeHtml(ownerName) : `<span class="muted">deleted user</span>`;
};

const scopePill = (scope: SavedReply["scope"]): string =>
	scope === "shared"
		? '<span class="pill approved">shared</span>'
		: '<span class="pill" style="border-color:var(--accent);color:var(--accent)">private</span>';

const replyRow = (
	reply: SavedReply,
	viewer: User,
	ownerName: string | null,
): string => {
	const mine = reply.owner_id === viewer.id;
	return `
<tr>
  <td>
    <div><strong>${escapeHtml(reply.title)}</strong></div>
    <div class="muted" style="font-size:0.75rem">updated ${formatTs(reply.updated_at)}</div>
  </td>
  <td>${scopePill(reply.scope)}</td>
  <td>${ownerCell(reply, viewer, ownerName)}</td>
  <td class="actions">
    ${mine ? `<a href="/admin/saved-replies/${escapeHtml(reply.id)}" class="btn">Edit</a>` : '<span class="muted">read-only</span>'}
  </td>
</tr>`;
};

export const renderSavedRepliesList = (
	replies: SavedReply[],
	viewer: User,
	ownersById: Map<string, string>,
): string => {
	const rows = replies.length
		? replies
				.map((r) => replyRow(r, viewer, ownersById.get(r.owner_id) ?? null))
				.join("")
		: '<tr><td colspan="4" class="muted">No saved replies yet.</td></tr>';
	return `
<div class="card">
  <h3 style="margin-top:0">Saved replies</h3>
  <p class="muted">
    Pre-written replies you (or your team) can drop into the moderation
    queue. Mark a reply as <strong>shared</strong> to make it visible to
    every mod and admin; <strong>private</strong> replies are visible
    only to you. Markdown goes through the same sanitizer as comment
    bodies; raw HTML is stripped.
  </p>
  <p><a href="/admin/saved-replies/new" class="btn">+ New saved reply</a></p>
  <table>
    <thead><tr>
      <th>Title</th><th>Scope</th><th>Owner</th><th>Actions</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
};

export const renderSavedReplyForm = (opts: {
	existing: SavedReply | null;
	error: string | null;
}): string => {
	const e = opts.existing;
	const action = e
		? `/admin/api/saved-replies/${escapeHtml(e.id)}`
		: `/admin/api/saved-replies`;
	const method = e ? "PATCH" : "POST";
	const heading = e ? "Edit saved reply" : "New saved reply";
	const errorBanner = opts.error
		? `<div class="card" style="border-left:3px solid var(--bad)"><strong>Error:</strong> ${escapeHtml(opts.error)}</div>`
		: "";
	const title = e?.title ?? "";
	const body = e?.body_md ?? "";
	const scope = e?.scope ?? "private";
	const deleteButton = e
		? `
<button type="button" class="bad" :disabled="busy"
        @click="del('${escapeHtml(e.id)}')">Delete saved reply</button>`
		: "";
	return `
${errorBanner}
<div class="card" x-data="{
  busy: false,
  async submit(form) {
    this.busy = true;
    try {
      const body = {
        title: form.title.value,
        body_md: form.body_md.value,
        scope: form.scope.value,
      };
      const r = await fetch('${action}', {
        method: '${method}',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Save failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Saved' });
      setTimeout(() => location.href = '/admin/saved-replies', 300);
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Save failed', kind: 'bad' });
      this.busy = false;
    }
  },
  async del(id) {
    if (!confirm('Delete this saved reply?')) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/saved-replies/' + id, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Delete failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Deleted' });
      setTimeout(() => location.href = '/admin/saved-replies', 300);
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Delete failed', kind: 'bad' });
      this.busy = false;
    }
  },
}">
  <h3 style="margin-top:0">${heading}</h3>
  <form @submit.prevent="submit($event.target)">
    <p>
      <label>Title<br>
        <input type="text" name="title" required maxlength="120"
               value="${escapeHtml(title)}" style="width:100%;max-width:480px">
      </label>
    </p>
    <p>
      <label>Body (markdown)<br>
        <textarea name="body_md" required rows="10"
                  maxlength="8000" style="width:100%;min-height:160px;font-family:ui-monospace,monospace">${escapeHtml(body)}</textarea>
      </label>
    </p>
    <p>
      <label>Scope<br>
        <select name="scope">
          <option value="private"${scope === "private" ? " selected" : ""}>Private — only you</option>
          <option value="shared"${scope === "shared" ? " selected" : ""}>Shared — all mods + admins</option>
        </select>
      </label>
    </p>
    <p>
      <button type="submit" :disabled="busy">Save</button>
      ${deleteButton}
      <a href="/admin/saved-replies" class="btn">Cancel</a>
    </p>
  </form>
</div>`;
};
