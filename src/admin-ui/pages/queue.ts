import type {
	AdminComment,
	AuditRowWithAdmin,
	CommentStatus,
} from "../../db/queries";
import { identiconSvg } from "../../lib/identicon";
import { sanitizeForEmail as resanitizeBodyHtml } from "../../lib/markdown";
import { renderHostFilter } from "../components/host-filter";
import { escapeHtml, jsLiteral } from "../escape";

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

const rowAct = (
	id: string,
	action: "approve" | "spam" | "delete",
	successText: string,
): string =>
	`busy=true; act(${jsLiteral(id)},${jsLiteral(action)}).then(()=>{$dispatch('toast',{text:${jsLiteral(successText)}}); gone=true;}).catch(e=>$dispatch('toast',{text:e.message||'Action failed',kind:'bad'})).finally(()=>busy=false)`;

const actionButtons = (id: string, status: CommentStatus): string => {
	const parts: string[] = [];
	if (status !== "approved") {
		const label = status === "deleted" || status === "spam" ? "Restore" : "Approve";
		parts.push(
			`<button :disabled="busy" @click="${rowAct(id, "approve", label === "Restore" ? "Restored" : "Approved")}">${label}</button>`,
		);
	}
	if (status !== "spam" && status !== "deleted") {
		parts.push(
			`<button :disabled="busy" class="bad" @click="${rowAct(id, "spam", "Marked as spam")}">Spam</button>`,
		);
	}
	if (status !== "deleted") {
		parts.push(
			`<button :disabled="busy" class="bad" @click="${rowAct(id, "delete", "Deleted")}">Delete</button>`,
		);
	}
	// Reply opens the saved-replies picker — mods only see it on
	// approved/pending comments. No point replying to deleted/spam.
	if (status !== "deleted" && status !== "spam") {
		parts.push(
			`<button :disabled="busy" @click="$dispatch('open-reply', { id: ${jsLiteral(id)} })">Reply</button>`,
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
	const filterBar = `
<form class="filter-bar queue-filter" method="get" action="/admin/queue">
  <input type="hidden" name="status" value="${escapeHtml(filters.status)}">
  <input type="text" name="q" placeholder="search body" value="${escapeHtml(filters.q)}">
  <input type="text" name="post_slug" placeholder="post slug" value="${escapeHtml(filters.post_slug)}">
  ${renderHostFilter({ hosts, selected: filters.host })}
  <input type="date" name="from" value="${escapeHtml(filters.from)}" title="from (UTC)">
  <input type="date" name="to" value="${escapeHtml(filters.to)}" title="to (UTC, inclusive)">
  ${filters.user_id ? `<input type="hidden" name="user_id" value="${escapeHtml(filters.user_id)}"><span class="muted">user: <code>${escapeHtml(filters.user_id)}</code></span>` : ""}
  <button type="submit">Filter</button>
  ${hasFilters ? `<a href="/admin/queue?status=${escapeHtml(filters.status)}" class="muted">clear</a>` : ""}
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
    @bulk-done.window="if ($event.detail.ids.includes(${jsLiteral(c.id)})) gone = true">
  <td class="bulk-cell"><input type="checkbox" :value="${jsLiteral(c.id)}" x-model="selected" :disabled="busy"></td>
  <td><span class="pill ${c.status}">${c.status}</span>${reportBadge(reportCounts[c.id] ?? 0)}</td>
  <td>${authorCell(c)}</td>
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
<div x-data="{
  open: false,
  commentId: null,
  replies: [],
  selected: null,
  busy: false,
  body: '',
  loaded: false,
  async load() {
    if (this.loaded) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/saved-replies', { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error('Could not load saved replies');
      const j = await r.json();
      this.replies = Array.isArray(j.replies) ? j.replies : [];
      this.loaded = true;
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Load failed', kind: 'bad' });
    } finally {
      this.busy = false;
    }
  },
  pick(r) {
    this.selected = r;
    this.body = r.body_md;
  },
  async send() {
    if (!this.selected || !this.commentId) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/saved-replies/' + this.selected.id + '/post', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ comment_id: this.commentId, body_md: this.body }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Post failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Reply posted' });
      this.open = false;
    } catch (e) {
      this.$dispatch('toast', { text: e.message || 'Post failed', kind: 'bad' });
    } finally {
      this.busy = false;
    }
  }
}"
@open-reply.window="open=true; commentId=$event.detail.id; selected=null; body=''; load();"
@keydown.escape.window="open=false">
<div class="card" x-data="{
  selected: [],
  bulkBusy: false,
  allIds: ${escapeHtml(JSON.stringify(allIds))},
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
}">
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
<div class="reply-modal" x-show="open" x-cloak role="dialog" aria-label="Reply with a saved reply"
     @click.self="open=false">
  <div class="reply-modal-inner">
    <h3 style="margin-top:0">Reply with a saved reply</h3>
    <p class="muted" x-show="!replies.length && loaded">
      No saved replies yet — <a href="/admin/saved-replies/new">create one</a>.
    </p>
    <ul class="reply-list" x-show="replies.length">
      <template x-for="r in replies" :key="r.id">
        <li>
          <button type="button"
                  :class="selected && selected.id === r.id ? 'reply-pick active' : 'reply-pick'"
                  @click="pick(r)">
            <strong x-text="r.title"></strong>
            <span class="muted" x-text="r.scope"></span>
          </button>
        </li>
      </template>
    </ul>
    <div x-show="selected">
      <label>Body (markdown)<br>
        <textarea x-model="body" rows="8" maxlength="8000"
                  style="width:100%;min-height:160px;font-family:ui-monospace,monospace"></textarea>
      </label>
      <p>
        <button :disabled="busy || !body.trim()" @click="send()">Post reply</button>
        <button :disabled="busy" @click="open=false" class="btn">Cancel</button>
      </p>
    </div>
    <p x-show="!selected && replies.length" class="muted">Pick a reply above to preview and post.</p>
  </div>
</div>
</div>`;
};
