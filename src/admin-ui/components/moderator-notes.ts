/**
 * Moderator notes card, shared by the comment-detail and user-detail pages.
 *
 * Internal context on one target: what a mod wants to write down when there
 * is no action to take yet. Every mod on the instance sees every note, and
 * no reader ever does — see 0023_moderator_notes.sql for why that is a table
 * of its own rather than more `audit_log.reason`.
 *
 * The list is server-rendered and a successful write reloads, which is how
 * every other mutating surface in this admin behaves. Rendering it from an
 * Alpine array instead would make the notes — the one thing on the page a
 * moderator is meant to *read* before acting — vanish whenever the CDN
 * carrying Alpine has a bad day.
 */
import type { ModeratorNoteWithAuthor } from "../../db/queries";
import { escapeHtml, jsLiteral } from "../escape";

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

// Mirrors NOTE_BODY_MAX in routes/admin.ts, the same way reply-composer.ts
// mirrors SAVED_REPLY_BODY_MAX: admin-ui is downstream of that module, so
// importing the constant back would close a cycle. It only feeds the
// textarea's `maxlength`; the server rejects an over-long body regardless.
const NOTE_BODY_MAX = 4000;

export type ModeratorNotesOptions = {
	target_kind: "comment" | "user";
	target_id: string;
	notes: ModeratorNoteWithAuthor[];
	/** Signed-in moderator; decides which delete buttons render. */
	viewerId: string;
	/** Admins can strike any note, not only their own. */
	viewerIsAdmin: boolean;
};

const noteRow = (
	n: ModeratorNoteWithAuthor,
	canDelete: boolean,
): string => `
<li class="note">
  <div class="note-meta muted">
    <strong>${escapeHtml(n.author_name ?? n.author_id)}</strong>
    · ${formatTs(n.created_at)}
    ${
			canDelete
				? `<button type="button" class="btn bad note-del"
              :disabled="busy" @click="remove(${jsLiteral(n.id)})">Delete</button>`
				: ""
		}
  </div>
  <div class="note-body">${escapeHtml(n.body)}</div>
</li>`;

export const moderatorNotes = (o: ModeratorNotesOptions): string => {
	const rows = o.notes
		.map((n) =>
			noteRow(n, o.viewerIsAdmin || n.author_id === o.viewerId),
		)
		.join("");
	const list = o.notes.length
		? `<ul class="note-list">${rows}</ul>`
		: `<p class="muted">No notes yet. Anything written here is visible to every moderator and to no one else.</p>`;
	return `
<div class="card" x-data="{
  body: '',
  busy: false,
  add() {
    if (this.busy || !this.body.trim()) return;
    this.busy = true;
    return fetch('/admin/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target_kind: ${jsLiteral(o.target_kind)},
        target_id: ${jsLiteral(o.target_id)},
        body: this.body,
      }),
    }).then(r => {
      if (!r.ok) throw new Error('Could not save the note: ' + r.status);
      this.$dispatch('toast', { text: 'Note added' });
      setTimeout(() => location.reload(), 600);
    }).catch(e => {
      this.busy = false;
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    });
  },
  remove(id) {
    if (this.busy || !confirm('Delete this note?')) return;
    this.busy = true;
    return fetch('/admin/api/notes/' + id, { method: 'DELETE' }).then(r => {
      if (!r.ok) throw new Error('Could not delete the note: ' + r.status);
      this.$dispatch('toast', { text: 'Note deleted' });
      setTimeout(() => location.reload(), 600);
    }).catch(e => {
      this.busy = false;
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    });
  }
}">
  <h3>Moderator notes (${o.notes.length})</h3>
  <p class="muted" style="margin:0 0 0.5rem">
    Internal to the moderation team — never shown to the commenter, and plain
    text, not markdown.
  </p>
  ${list}
  <label style="display:block;margin-top:0.5rem">Add a note<br>
    <textarea x-model="body" rows="3" maxlength="${NOTE_BODY_MAX}"
              placeholder="Context for whoever picks this up next…"
              style="width:100%;font-family:inherit"></textarea>
  </label>
  <p style="margin-top:0.5rem">
    <button :disabled="busy || !body.trim()" @click="add()">Add note</button>
  </p>
</div>`;
};
