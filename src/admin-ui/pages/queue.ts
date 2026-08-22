import type {
	AdminComment,
	AuditRowWithAdmin,
	CommentStatus,
} from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { renderHostFilter } from "../components/host-filter";
import { replyComposer } from "../components/reply-composer";
import { escapeHtml, jsLiteral } from "../escape";
import { kbdKeys } from "../layout";

const relTime = (ts: number, now: number = Date.now()): string => {
	const diff = Math.max(0, now - ts);
	const m = Math.floor(diff / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
};

const auditStrip = (a: AuditRowWithAdmin | undefined): string => {
	if (!a) return "";
	const who = a.admin_name ?? a.admin_id.slice(0, 8);
	return `<div class="muted audit-strip">${escapeHtml(a.action)} by ${escapeHtml(who)} · ${relTime(a.created_at)}</div>`;
};

/** Open-report count badge for a queue row. Empty string when zero. */
const reportBadge = (n: number): string =>
	n > 0
		? ` <span class="pill spam" title="${n} open report${n === 1 ? "" : "s"}">⚑ ${n}</span>`
		: "";

/**
 * Moderator-note count badge. Empty string when zero.
 *
 * The count, not the notes: the queue is a list of decisions to make, and the
 * badge's whole job is to say "someone already looked at this — read the
 * detail page before you act". Inlining bodies here would put another mod's
 * private reasoning on the screen a moderator skims fastest.
 */
const noteBadge = (n: number, about: string): string =>
	n > 0
		? ` <span class="pill note-badge" title="${n} moderator note${n === 1 ? "" : "s"} on ${about}">✎ ${n}</span>`
		: "";

/**
 * Note counts for the visible rows, keyed by the thing the note is about.
 * Two lookups because a row carries two targets: the comment in front of you
 * and the account that wrote it, and "this account has history" is the more
 * useful of the two to see before approving.
 */
export type QueueNoteCounts = {
	comment: Record<string, number>;
	user: Record<string, number>;
};

/**
 * The queue's keyboard shortcuts, in the order they're listed to the user.
 *
 * One list, three consumers: the hint strip above the table, the help
 * popover (the route hands this to `layout` as `opts.shortcuts`), and the
 * `onKey` switch below. Splitting them is how a popover ends up promising a
 * key the page no longer handles.
 */
export const QUEUE_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
	["j / k", "Move the row cursor"],
	["a", "Approve the row under the cursor"],
	["s", "Mark it as spam"],
	["d", "Delete it (asks first)"],
	["r", "Reply to it"],
	["Esc", "Clear the cursor"],
];

// Same keys the help popover lists, spelled out where the moderating
// happens — a shortcut nobody knows about is a shortcut nobody uses.
const shortcutStrip = (): string =>
	`<p class="muted shortcut-strip">${QUEUE_SHORTCUTS.map(
		([keys, desc]) =>
			`<span>${kbdKeys(keys)} ${escapeHtml(desc.toLowerCase())}</span>`,
	).join(" · ")}</p>`;

export type QueueFilters = {
	status: CommentStatus | "all";
	q: string;
	post_slug: string;
	user_id: string;
	from: string;
	to: string;
	host: string;
	/** The cross-status "reported" view (comments with open reader reports). */
	reported: boolean;
};

const queryString = (f: QueueFilters): string => {
	const params = new URLSearchParams();
	if (f.reported) params.set("reported", "1");
	else if (f.status !== "pending") params.set("status", f.status);
	if (f.q) params.set("q", f.q);
	if (f.post_slug) params.set("post_slug", f.post_slug);
	if (f.user_id) params.set("user_id", f.user_id);
	if (f.from) params.set("from", f.from);
	if (f.to) params.set("to", f.to);
	if (f.host) params.set("host", f.host);
	const s = params.toString();
	return s ? `?${s}` : "";
};

const authorCell = (c: AdminComment, noteCount: number): string => {
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
    <span class="author-name">${escapeHtml(name)} ${badges.join(" ")}${noteBadge(noteCount, "this account")}</span>
    <span class="author-sub muted">${escapeHtml(provider)}</span>
  </span>
</a>`;
};

// Net vote score with up/down split. We render the net first (the value
// brigading mitigation cares about) and a muted sub-line with the raw
// counts so a mod scanning the queue can spot e.g. 50↑/49↓ noise.
const scoreCell = (c: AdminComment): string => {
	const up = c.score_up ?? 0;
	const down = c.score_down ?? 0;
	const net = up - down;
	const cls = net > 0 ? "score-pos" : net < 0 ? "score-neg" : "muted";
	return `
<span class="score ${cls}">${net > 0 ? "+" : ""}${net}</span>
<div class="muted" style="font-size:0.75rem">${up}↑ ${down}↓</div>`;
};

// Only http(s) page URLs get turned into a link. A stored post.url could in
// principle carry a javascript:/data: scheme; refusing to emit those as an
// href keeps the admin DOM safe (mirrors the markdown renderer's URL allowlist).
const isHttpUrl = (u: string | null | undefined): u is string =>
	typeof u === "string" && /^https?:\/\//i.test(u);

// META cell: when, where, and which comment. The host/slug link back to the
// page the comment lives on (new tab) when we have a usable URL; otherwise we
// fall back to plain text. The ULID is click-to-copy rather than visual filler.
const metaCell = (c: AdminComment): string => {
	const exact = new Date(c.created_at)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ");
	const where = `
    <div><code>${escapeHtml(c.host)}</code></div>
    <div><code>${escapeHtml(c.post_slug)}</code></div>`;
	const whereLinked = isHttpUrl(c.post_url)
		? `<a href="${escapeHtml(c.post_url)}" target="_blank" rel="noopener noreferrer nofollow" title="Open page in new tab">${where}<span class="meta-ext muted">view&#8599;</span></a>`
		: where;
	const title = c.post_title
		? `<div class="meta-title">${escapeHtml(c.post_title)}</div>`
		: "";
	return `
    <div class="muted" title="${escapeHtml(exact)} UTC">${relTime(c.created_at)}</div>
    ${title}
    ${whereLinked}
    <span class="cid muted" role="button" title="Copy comment ID"
          @click="navigator.clipboard.writeText(${jsLiteral(c.id)}); $dispatch('toast',{text:'ID copied'})">${escapeHtml(c.id)}</span>`;
};

// Opening the reply modal carries the row's saved-reply variable context
// ({name}, {post}) alongside the id. The values live in the card scope's
// `rowCtx` map rather than being inlined here, because the keyboard shortcut
// opens the same modal from a cursor position with no row element in hand.
const openReply = (id: string): string => `openReply(${jsLiteral(id)})`;

const rowAct = (
	id: string,
	action: "approve" | "spam" | "delete",
	successText: string,
): string =>
	// Hiding the row is `bulk-done`'s job, not a local `gone=true`: the card
	// listens for the same event to mark the id spent, and the keyboard cursor
	// reads that map to decide what to skip. A mouse click that only set the
	// row-local flag left a hidden row the cursor would still land on — and
	// then act on a second time.
	`busy=true; act(${jsLiteral(id)},${jsLiteral(action)}).then(()=>{$dispatch('toast',{text:${jsLiteral(successText)}}); $dispatch('bulk-done',{ids:[${jsLiteral(id)}]});}).catch(e=>$dispatch('toast',{text:e.message||'Action failed',kind:'bad'})).finally(()=>busy=false)`;

/**
 * The lifecycle transitions a row offers, per current status, with the toast
 * each one earns.
 *
 * One table because the row's buttons and the keyboard shortcuts are two
 * consumers of the same rule, and drift between them is silent: `a` on an
 * already-approved comment re-audits it and fires a second approval webhook,
 * `s` on a deleted one quietly turns it into spam. The buttons render from
 * this; the browser handler gets the same table serialized into its scope.
 */
const ROW_ACTIONS: Record<
	CommentStatus,
	ReadonlyArray<{
		action: "approve" | "spam" | "delete";
		label: string;
		toast: string;
	}>
> = {
	pending: [
		{ action: "approve", label: "Approve", toast: "Approved" },
		{ action: "spam", label: "Spam", toast: "Marked as spam" },
		{ action: "delete", label: "Delete", toast: "Deleted" },
	],
	approved: [
		{ action: "spam", label: "Spam", toast: "Marked as spam" },
		{ action: "delete", label: "Delete", toast: "Deleted" },
	],
	spam: [
		{ action: "approve", label: "Restore", toast: "Restored" },
		{ action: "delete", label: "Delete", toast: "Deleted" },
	],
	deleted: [{ action: "approve", label: "Restore", toast: "Restored" }],
};

/** `{ [status]: { [action]: toast } }` — the browser copy of ROW_ACTIONS. */
export const rowActionToasts = (): Record<string, Record<string, string>> =>
	Object.fromEntries(
		Object.entries(ROW_ACTIONS).map(([status, acts]) => [
			status,
			Object.fromEntries(acts.map((a) => [a.action, a.toast])),
		]),
	);

const actionButtons = (id: string, status: CommentStatus): string => {
	const parts: string[] = ROW_ACTIONS[status].map(
		({ action, label, toast }) =>
			`<button :disabled="busy"${action === "approve" ? "" : ' class="bad"'} @click="${rowAct(id, action, toast)}">${label}</button>`,
	);
	// Reply opens the free-text composer — mods only see it on
	// approved/pending comments. No point replying to deleted/spam.
	if (status !== "deleted" && status !== "spam") {
		parts.push(
			`<button :disabled="busy" @click="${openReply(id)}">Reply</button>`,
		);
	}
	return parts.join("");
};

/**
 * Per-post comment-lifecycle state, surfaced only when the queue is filtered
 * down to a single post_slug. Drives the "Close / Open comments" toggle.
 */
export type PostLifecycle = { slug: string; closed: boolean };

export const renderQueue = (
	rows: AdminComment[],
	filters: QueueFilters,
	nextCursor: string | null,
	latestAudit: Map<string, AuditRowWithAdmin> = new Map(),
	hosts: string[] = [],
	post: PostLifecycle | null = null,
	reportCounts: Record<string, number> = {},
	/** Signed-in moderator's display name, shown as the reply composer's identity. */
	modName = "",
	noteCounts: QueueNoteCounts = { comment: {}, user: {} },
): string => {
	const statusTabs = ["all", "approved", "pending", "spam", "deleted"]
		.map((s) => {
			// Status tabs preserve every other active filter — clicking
			// "spam" while a search is active should keep the search.
			const tabFilters = {
				...filters,
				reported: false,
				status: s as QueueFilters["status"],
			};
			const href = `/admin/queue${queryString(tabFilters)}`;
			const active = !filters.reported && s === filters.status;
			return `<a href="${href}" ${active ? 'style="font-weight:600"' : ""}>${s}</a>`;
		})
		.join(" · ");
	// Cross-status "reported" tab — its own filter dimension, not a status.
	const reportedHref = `/admin/queue${queryString({ ...filters, reported: true })}`;
	const reportedTab = `<a href="${reportedHref}" ${filters.reported ? 'style="font-weight:600"' : ""}>reported</a>`;
	const tabs = `${statusTabs} · ${reportedTab}`;

	const hasFilters =
		filters.q ||
		filters.post_slug ||
		filters.user_id ||
		filters.from ||
		filters.to ||
		filters.host ||
		filters.reported;
	// Submitting the filter form (or clearing) must keep the active tab. The
	// reported view is its own dimension, so carry it through as a hidden field
	// and point "clear" back at it; otherwise the form would silently drop the
	// user out of the reported tab and into the status view.
	const tabHidden = filters.reported
		? `<input type="hidden" name="reported" value="1">`
		: `<input type="hidden" name="status" value="${escapeHtml(filters.status)}">`;
	const clearHref = filters.reported
		? "/admin/queue?reported=1"
		: `/admin/queue?status=${escapeHtml(filters.status)}`;
	const filterBar = `
<form class="filter-bar queue-filter" method="get" action="/admin/queue">
  ${tabHidden}
  <input type="text" name="q" placeholder="search body" value="${escapeHtml(filters.q)}">
  <input type="text" name="post_slug" placeholder="post slug" value="${escapeHtml(filters.post_slug)}">
  ${renderHostFilter({ hosts, selected: filters.host })}
  <input type="date" name="from" value="${escapeHtml(filters.from)}" title="from (UTC)">
  <input type="date" name="to" value="${escapeHtml(filters.to)}" title="to (UTC, inclusive)">
  ${filters.user_id ? `<input type="hidden" name="user_id" value="${escapeHtml(filters.user_id)}"><span class="muted">user: <code>${escapeHtml(filters.user_id)}</code></span>` : ""}
  <button type="submit">Filter</button>
  ${hasFilters ? `<a href="${clearHref}" class="muted">clear</a>` : ""}
</form>`;

	// Per-post freeze toggle. Only meaningful when the queue is scoped to one
	// post (a global flag/auto-close still applies on top of this; this controls
	// only the manual per-post `closed` column). Mod-gated server-side.
	const lifecycleBar = post
		? `
<div class="filter-bar post-lifecycle" x-data="{ closed: ${post.closed ? "true" : "false"}, busy: false,
  async toggle() {
    this.busy = true;
    try {
      const r = await fetch('/admin/api/posts/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: ${jsLiteral(post.slug)}, closed: !this.closed }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('Failed: ' + r.status)); }
      const j = await r.json();
      this.closed = !!j.closed;
      this.$dispatch('toast', { text: this.closed ? 'Comments closed for this thread' : 'Comments reopened for this thread' });
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Action failed', kind: 'bad' });
    } finally { this.busy = false; }
  }
}">
  <span class="muted">thread <code>${escapeHtml(post.slug)}</code>:</span>
  <span class="pill" :class="closed ? 'spam' : 'approved'" x-text="closed ? 'closed' : 'open'"></span>
  <button :disabled="busy" @click="toggle()" x-text="closed ? 'Open comments' : 'Close comments'"></button>
</div>`
		: "";

	const rowsHtml = rows.length
		? rows
				.map(
					(c) => `
<tr x-data="{ busy: false, gone: false }"
    x-show="!gone" x-transition.opacity
    :class="allIds[cursor] === ${jsLiteral(c.id)} ? 'row-cursor' : ''"
    @bulk-done.window="if ($event.detail.ids.includes(${jsLiteral(c.id)})) gone = true">
  <td class="bulk-cell"><input type="checkbox" :value="${jsLiteral(c.id)}" x-model="selected" :disabled="busy"></td>
  <td><span class="pill ${c.status}">${c.status}</span>${reportBadge(reportCounts[c.id] ?? 0)}${noteBadge(noteCounts.comment[c.id] ?? 0, "this comment")}</td>
  <td>${authorCell(c, noteCounts.user[c.user_id] ?? 0)}</td>
  <td class="score-cell" title="up / down">${scoreCell(c)}</td>
  <td class="meta-cell">${metaCell(c)}</td>
  <td class="row-body">
    <div class="md">${resanitizeBodyHtml(c.body_html)}</div>
    ${auditStrip(latestAudit.get(c.id))}
  </td>
  <td class="actions">${actionButtons(c.id, c.status)}</td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="7" class="muted">No comments match.</td></tr>`;

	const allIds = rows.map((r) => r.id);
	// Saved-reply variable context per row: the author's display name and the
	// post's human title (slug when the crawler never gave us one). Kept as a
	// map keyed by comment id so both the Reply button and the keyboard
	// shortcut resolve it the same way.
	//
	// Built literal-by-literal through jsLiteral rather than JSON.stringify'd
	// whole: unlike `allIds` these values are user-authored (a display name, a
	// page <title>), and JSON.stringify leaves `<`, `>` and U+2028/U+2029 raw
	// inside what becomes executable JS. See tests/admin-js-context-escaping.
	const rowCtx = `{${rows
		.map(
			(r) =>
				`${jsLiteral(r.id)}: { name: ${jsLiteral(r.author_name ?? "")}, post: ${jsLiteral(r.post_title || r.post_slug)}, status: ${jsLiteral(r.status)} }`,
		)
		.join(", ")}}`;

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
${lifecycleBar}
${shortcutStrip()}
<div x-data="{ open: false, commentId: null, authorName: '', postTitle: '' }"
@open-reply.window="open = true; commentId = $event.detail.id; authorName = $event.detail.name || ''; postTitle = $event.detail.post || '';"
@reply-posted="open = false"
@keydown.escape.window="open = false">
<div class="card" x-data="{
  selected: [],
  bulkBusy: false,
  allIds: ${escapeHtml(JSON.stringify(allIds))},
  rowCtx: ${rowCtx},
  rowActions: ${escapeHtml(JSON.stringify(rowActionToasts()))},
  cursor: -1,
  done: {},
  openReply(id) {
    const ctx = this.rowCtx[id] || {};
    this.$dispatch('open-reply', { id: id, name: ctx.name || '', post: ctx.post || '' });
  },
  // --- keyboard driving ------------------------------------------------
  // The cursor is an index into allIds, not a DOM pointer: rows leave the
  // table by going x-show=false, so 'the next row' means the next index
  // this page hasn't already acted on, not the next visible <tr>.
  nextLive(from, dir) {
    for (let i = from; i >= 0 && i < this.allIds.length; i += dir) {
      if (!this.done[this.allIds[i]]) return i;
    }
    return -1;
  },
  move(dir) {
    const start = this.cursor < 0 ? (dir > 0 ? 0 : this.allIds.length - 1) : this.cursor + dir;
    const next = this.nextLive(start, dir);
    if (next < 0) return;
    this.cursor = next;
    const row = this.$el.querySelectorAll('tbody tr')[next];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  },
  advance() {
    const fwd = this.nextLive(this.cursor + 1, 1);
    this.cursor = fwd >= 0 ? fwd : this.nextLive(this.cursor - 1, -1);
  },
  keyAct(action) {
    const id = this.allIds[this.cursor];
    if (!id || this.done[id]) return;
    // The row's own buttons suppress transitions that don't apply to its
    // status; a shortcut that didn't would be the only way to re-approve an
    // approved comment or spam a deleted one. Same table, same answer.
    const ctx = this.rowCtx[id] || {};
    const label = (this.rowActions[ctx.status] || {})[action];
    if (!label) {
      this.$dispatch('toast', { text: 'Cannot ' + action + ' a comment that is already ' + ctx.status, kind: 'bad' });
      return;
    }
    if (action === 'delete' && !confirm('Delete this comment?')) return;
    // Marked done up front so a fast repeat can't fire twice on one row;
    // rolled back if the request fails, which also puts the cursor's path
    // back the way it was.
    this.done[id] = true;
    this.act(id, action).then(() => {
      this.$dispatch('toast', { text: label });
      this.$dispatch('bulk-done', { ids: [id] });
      this.advance();
    }).catch(e => {
      this.done[id] = false;
      this.$dispatch('toast', { text: e.message || 'Action failed', kind: 'bad' });
    });
  },
  keyReply() {
    const id = this.allIds[this.cursor];
    if (!id) return;
    const ctx = this.rowCtx[id] || {};
    if (ctx.status === 'deleted' || ctx.status === 'spam') {
      this.$dispatch('toast', { text: 'Nothing to reply to on a ' + ctx.status + ' comment', kind: 'bad' });
      return;
    }
    this.openReply(id);
  },
  onKey(e) {
    // A shortcut that fires while someone is typing a search term is worse
    // than no shortcut at all, so the filter inputs, the reply composer and
    // any open modal all keep the keyboard to themselves. Modifier combos
    // belong to the browser.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.open) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Escape') { this.cursor = -1; return; }
    if (e.key === 'j') { e.preventDefault(); this.move(1); return; }
    if (e.key === 'k') { e.preventDefault(); this.move(-1); return; }
    if (this.cursor < 0) return;
    if (e.key === 'a') { e.preventDefault(); this.keyAct('approve'); }
    else if (e.key === 's') { e.preventDefault(); this.keyAct('spam'); }
    else if (e.key === 'd') { e.preventDefault(); this.keyAct('delete'); }
    else if (e.key === 'r') { e.preventDefault(); this.keyReply(); }
  },
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
      return r.json();
    });
  },
  bulk(action) {
    if (this.selected.length === 0) return;
    if (!confirm(action + ' ' + this.selected.length + ' comment(s)?')) return;
    this.bulkBusy = true;
    const ids = this.selected.slice();
    return fetch('/admin/api/comments/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, action }),
    }).then(r => {
      if (!r.ok) throw new Error('bulk action failed: ' + r.status);
      return r.json();
    }).then(j => {
      const doneIds = (j && Array.isArray(j.touched)) ? j.touched : ids;
      this.$dispatch('toast', { text: action + ' ' + doneIds.length + ' comment(s)' });
      this.$dispatch('bulk-done', { ids: doneIds });
      this.selected = [];
    }).catch(e => {
      this.$dispatch('toast', { text: e.message || 'Bulk failed', kind: 'bad' });
    }).finally(() => { this.bulkBusy = false; });
  }
}" @keydown.window="onKey($event)"
   @bulk-done.window="$event.detail.ids.forEach(i => { done[i] = true; })">
  <table>
    <thead><tr>
      <th class="bulk-cell"><input type="checkbox" @change="toggleAll($event)" :checked="selected.length > 0 && selected.length === allIds.length"></th>
      <th>Status</th><th>Author</th><th title="Vote score">Score</th><th>Meta</th><th>Body</th><th>Actions</th>
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
</div>
<div class="reply-modal" x-show="open" x-cloak role="dialog" aria-label="Reply to this comment"
     @click.self="open=false">
  <div class="reply-modal-inner">
    <h3 style="margin-top:0">Reply to this comment</h3>
    <!-- x-if rather than x-show so each open mounts a fresh composer: closing
         the modal must not leave last time's draft, preview or notify choice
         sitting in the next reply. -->
    <template x-if="open">
${replyComposer({
	commentIdExpr: "commentId",
	modName,
	// Same wrapper scope as commentId: whichever row opened the modal.
	authorNameExpr: "authorName",
	postTitleExpr: "postTitle",
	// The composer has its own Alpine scope, so assigning `open` there would
	// create a new property on the child instead of closing the modal. Bubble an
	// event to the wrapper's @reply-posted handler instead.
	onPosted: "this.$dispatch('reply-posted');",
})}
    </template>
    <p><button class="btn" @click="open=false">Cancel</button></p>
  </div>
</div>
</div>`;
};
