/**
 * Free-text moderator reply composer.
 *
 * Shared by the queue's reply modal and the single-comment view so the two
 * can't drift. Free text is the primary input; saved replies are offered as an
 * optional *prefill* behind a collapsed picker, which is the inverse of how
 * this worked when the only way to reply was to pick a preset first.
 *
 * The component owns its own Alpine scope (body, notify, preview, save-for-
 * reuse). The target comment id comes from the caller as a JS *expression*
 * evaluated in the enclosing Alpine scope: a literal on the comment-detail
 * page, and the modal's `commentId` state in the queue, where the same
 * composer serves whichever row was clicked.
 */
import { escapeHtml, jsLiteral } from "../escape";
import { MAX_BODY_CHARS } from "../../lib/markdown";

// Mirrors SAVED_REPLY_BODY_MAX in routes/admin.ts. Not imported: admin-ui is
// downstream of that module (it imports these renderers), so reaching back for
// the constant would close an import cycle. The same literal is already
// hard-coded in pages/saved-replies.ts for the same reason.
//
// It is *lower* than MAX_BODY_CHARS, so a reply can be perfectly postable and
// still too long to save as a preset. The UI has to say so rather than let the
// save 400 with body_too_long.
const SAVED_REPLY_BODY_MAX = 8000;

export type ReplyComposerOptions = {
	/**
	 * JS expression, evaluated in the enclosing Alpine scope, yielding the id of
	 * the comment being replied to. Callers pass either a quoted literal or the
	 * name of a state property; either way it must already be safe to embed.
	 */
	commentIdExpr: string;
	/** Display name of the signed-in moderator, shown as the posting identity. */
	modName: string;
	/** Statements to run after a successful post (close a modal, reload, …). */
	onPosted?: string;
	/** Offer the saved-reply picker as a prefill source. */
	offerSavedReplies?: boolean;
};

export const replyComposer = (o: ReplyComposerOptions): string => {
	const onPosted = o.onPosted ?? "";
	const offer = o.offerSavedReplies !== false;
	return `<div class="reply-composer" x-data="{
  body: '',
  notify: true,
  busy: false,
  previewing: false,
  previewHtml: '',
  savedReplyId: null,
  pickedBody: '',
  pickerOpen: false,
  replies: [],
  loadedReplies: false,
  saveOpen: false,
  saveTitle: '',
  saveScope: 'private',
  saving: false,
  get tooLongToSave() { return this.body.length > ${SAVED_REPLY_BODY_MAX}; },
  onEdit(v) {
    this.body = v;
    // Editing away from the preset drops the provenance claim, so the audit row
    // never credits a saved reply for text the mod actually wrote.
    if (this.savedReplyId && v !== this.pickedBody) this.savedReplyId = null;
    if (this.previewing) this.previewing = false;
  },
  async loadReplies() {
    if (this.loadedReplies) return;
    try {
      const r = await fetch('/admin/api/saved-replies', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('Could not load saved replies');
      const j = await r.json();
      this.replies = Array.isArray(j.replies) ? j.replies : [];
      this.loadedReplies = true;
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Load failed', kind: 'bad' });
    }
  },
  pick(r) {
    this.body = r.body_md;
    this.pickedBody = r.body_md;
    this.savedReplyId = r.id;
    this.pickerOpen = false;
    this.previewing = false;
  },
  async togglePreview() {
    if (this.previewing) { this.previewing = false; return; }
    if (!this.body.trim()) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body_md: this.body }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Preview failed: ' + r.status));
      }
      const j = await r.json();
      this.previewHtml = j.html || '';
      this.previewing = true;
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Preview failed', kind: 'bad' });
    } finally { this.busy = false; }
  },
  async send() {
    if (this.busy || !this.body.trim()) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/comments/' + ${o.commentIdExpr} + '/reply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body_md: this.body, saved_reply_id: this.savedReplyId, notify: this.notify }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Post failed: ' + r.status));
      }
      this.$dispatch('toast', { text: this.notify ? 'Reply posted — subscribers notified' : 'Reply posted' });
      this.body = ''; this.savedReplyId = null; this.previewing = false;
      ${onPosted}
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Post failed', kind: 'bad' });
    } finally { this.busy = false; }
  },
  async saveForReuse() {
    if (this.saving || !this.saveTitle.trim() || !this.body.trim() || this.tooLongToSave) return;
    this.saving = true;
    try {
      const r = await fetch('/admin/api/saved-replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: this.saveTitle, body_md: this.body, scope: this.saveScope }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Save failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Saved for reuse' });
      this.saveOpen = false; this.saveTitle = '';
      this.loadedReplies = false; this.replies = [];
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Save failed', kind: 'bad' });
    } finally { this.saving = false; }
  }
}">
  <p class="muted" style="margin:0 0 0.5rem">Posting as <strong>${escapeHtml(o.modName)}</strong> — published immediately, no spam check.</p>
${
	offer
		? `  <p style="margin:0 0 0.5rem">
    <button type="button" class="btn" @click="pickerOpen = !pickerOpen; loadReplies()"
            x-text="pickerOpen ? 'Hide saved replies' : 'Insert a saved reply'"></button>
  </p>
  <div x-show="pickerOpen" x-cloak style="margin-bottom:0.5rem">
    <ul class="reply-list" x-show="replies.length">
      <template x-for="r in replies" :key="r.id">
        <li>
          <button type="button"
                  :class="savedReplyId === r.id ? 'reply-pick active' : 'reply-pick'"
                  @click="pick(r)">
            <strong x-text="r.title"></strong>
            <span class="muted" x-text="r.scope"></span>
          </button>
        </li>
      </template>
    </ul>
    <p class="muted" x-show="loadedReplies && !replies.length">
      No saved replies yet. Write the reply below — you can save it for reuse afterwards.
    </p>
  </div>
`
		: ""
}  <label>Reply (markdown)<br>
    <textarea :value="body" @input="onEdit($event.target.value)" rows="8" maxlength="${MAX_BODY_CHARS}"
              placeholder="Write a reply…"
              style="width:100%;min-height:160px;font-family:ui-monospace,monospace"></textarea>
  </label>
  <div x-show="previewing" x-cloak class="reply-preview" style="margin:0.5rem 0">
    <p class="muted" style="margin:0 0 0.25rem">Preview</p>
    <div x-html="previewHtml"></div>
  </div>
  <p style="margin:0.5rem 0">
    <label><input type="checkbox" x-model="notify"> Notify thread subscribers by email</label>
  </p>
  <p>
    <button :disabled="busy || !body.trim()" @click="send()">Post reply</button>
    <button :disabled="busy || !body.trim()" class="btn" @click="togglePreview()"
            x-text="previewing ? 'Hide preview' : 'Preview'"></button>
    <button :disabled="!body.trim()" class="btn" @click="saveOpen = !saveOpen">Save for reuse</button>
  </p>
  <div x-show="saveOpen" x-cloak style="margin-top:0.5rem">
    <p class="muted" x-show="tooLongToSave" style="margin:0 0 0.25rem">
      Too long to save as a preset (over ${SAVED_REPLY_BODY_MAX} characters). It can still be posted.
    </p>
    <label>Title<br>
      <input type="text" x-model="saveTitle" maxlength="120" style="width:100%">
    </label>
    <label style="display:block;margin-top:0.25rem">Scope<br>
      <select x-model="saveScope">
        <option value="private">private</option>
        <option value="shared">shared</option>
      </select>
    </label>
    <p style="margin-top:0.5rem">
      <button :disabled="saving || !saveTitle.trim() || !body.trim() || tooLongToSave" @click="saveForReuse()">Save</button>
      <button :disabled="saving" class="btn" @click="saveOpen = false">Cancel</button>
    </p>
  </div>
</div>`;
};

/**
 * Quote a known-at-render-time comment id for use as `commentIdExpr`.
 *
 * `jsLiteral`, not `jsLiteralRaw`: the composer writes its `x-data` blob raw
 * rather than escaping it as a whole, so the literal's own double quotes have
 * to become `&quot;` or they'd terminate the double-quoted attribute early.
 * They decode back to quotes before Alpine parses the expression.
 */
export const commentIdLiteral = (id: string): string => jsLiteral(id);
