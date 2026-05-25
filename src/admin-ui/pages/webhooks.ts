import type { WebhookEndpoint } from "../../db/queries";
import { escapeHtml } from "../escape";

const formatTs = (ts: number | null): string =>
	ts == null ? "—" : new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const ALL_EVENTS = [
	"comment.posted",
	"comment.edited",
	"comment.deleted",
	"comment.approved",
	"comment.spam",
] as const;

const ADAPTERS: Array<{ value: string; label: string }> = [
	{ value: "generic", label: "Generic JSON (v1 contract)" },
	{ value: "slack", label: "Slack incoming webhook" },
	{ value: "discord", label: "Discord webhook" },
];

const endpointRow = (e: WebhookEndpoint): string => {
	const eventsLabel = e.events == null ? "all events" : e.events.join(", ");
	const signedPill = e.secret
		? '<span class="pill approved">signed</span>'
		: '<span class="pill pending">unsigned</span>';
	const statusPill = e.enabled
		? '<span class="pill approved">enabled</span>'
		: '<span class="pill spam">disabled</span>';
	const autoDisableNote = e.disabled_at
		? `<div class="muted" style="font-size:0.75rem">auto-paused ${formatTs(e.disabled_at)} after ${e.fail_count} fails</div>`
		: "";
	return `
<tr x-data="{ busy: false, enabled: ${e.enabled} }">
  <td>
    <div><code>${escapeHtml(e.url)}</code></div>
    <div class="muted" style="font-size:0.75rem">${escapeHtml(eventsLabel)} · ${escapeHtml(e.adapter)}</div>
    ${autoDisableNote}
  </td>
  <td>${signedPill}</td>
  <td><template x-if="enabled">${statusPill}</template>
      <template x-if="!enabled"><span class="pill spam">disabled</span></template></td>
  <td class="muted">${formatTs(e.created_at)}</td>
  <td class="actions">
    <a href="/admin/webhooks/${escapeHtml(e.id)}" class="btn">Edit</a>
    <button :disabled="busy" class="bad" @click="busy=true; del('${escapeHtml(e.id)}').finally(()=>busy=false)">Delete</button>
  </td>
</tr>`;
};

const eventChecklist = (selected: ReadonlySet<string>): string =>
	ALL_EVENTS.map(
		(ev) => `
<label style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.8rem">
  <input type="checkbox" name="event_${ev}" ${selected.has(ev) ? "checked" : ""}> ${escapeHtml(ev)}
</label>`,
	).join("");

const adapterSelect = (selected: string): string =>
	ADAPTERS.map(
		(a) =>
			`<option value="${escapeHtml(a.value)}"${a.value === selected ? " selected" : ""}>${escapeHtml(a.label)}</option>`,
	).join("");

export const renderWebhooksList = (
	endpoints: WebhookEndpoint[],
	envShim: { active: boolean; url: string },
): string => {
	const rows = endpoints.length
		? endpoints.map(endpointRow).join("")
		: '<tr><td colspan="5" class="muted">No webhook endpoints configured yet.</td></tr>';
	const envBanner = envShim.active
		? `
<div class="card" style="border-left:3px solid var(--warn)">
  <p>
    <strong>Legacy <code>WEBHOOK_URL</code> in use</strong> —
    <code>${escapeHtml(envShim.url)}</code> is being delivered to as an
    unsigned, retry-less endpoint. Add a real endpoint below (with an HMAC
    secret) and remove the env var to gain signing + automatic retries.
  </p>
</div>`
		: "";
	return `
<div x-data="{
  del(id) {
    if (!confirm('Delete this webhook endpoint? Pending retries will be cancelled.')) return Promise.resolve();
    return fetch('/admin/api/webhooks/' + id, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ('delete failed: ' + r.status));
        }
        this.$dispatch('toast', { text: 'Endpoint deleted' });
        setTimeout(() => location.reload(), 300);
      })
      .catch(e => { this.$dispatch('toast', { text: e.message, kind: 'bad' }); });
  }
}">
${envBanner}
<div class="card">
  <h3 style="margin-top:0">Webhook endpoints</h3>
  <p class="muted">
    Each enabled endpoint receives a POST per matching event. Endpoints
    with an HMAC secret get an <code>X-Garrul-Signature</code> header;
    receivers should reject unsigned deliveries in production. Failed
    deliveries are retried with exponential backoff for ~9 hours before
    the row is given up; an endpoint that gives up 10 deliveries in a
    row is auto-paused.
  </p>
  <p><a href="/admin/webhooks/new" class="btn">+ Add endpoint</a></p>
  <table>
    <thead><tr><th>URL</th><th>Signed</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
</div>`;
};

export type WebhookFormData = {
	endpoint: WebhookEndpoint | null; // null = new
	error: string | null;
};

export const renderWebhookForm = (data: WebhookFormData): string => {
	const e = data.endpoint;
	const isNew = e == null;
	const selectedEvents = new Set<string>(e?.events ?? ALL_EVENTS);
	const url = e?.url ?? "";
	const secret = e?.secret ?? "";
	const adapter = e?.adapter ?? "generic";
	const enabled = e?.enabled ?? true;
	const heading = isNew ? "Add webhook endpoint" : "Edit webhook endpoint";
	const action = isNew
		? "/admin/api/webhooks"
		: `/admin/api/webhooks/${escapeHtml(e.id)}`;
	const errorBlock = data.error
		? `<p style="color:var(--bad)">${escapeHtml(data.error)}</p>`
		: "";
	const submitLabel = isNew ? "Create endpoint" : "Save changes";
	return `
<a href="/admin/webhooks" class="muted">← back to webhooks</a>
<div class="card" x-data="{
  busy: false,
  error: ${JSON.stringify(data.error)},
  async submit(e) {
    e.preventDefault();
    if (this.busy) return;
    this.busy = true; this.error = null;
    const form = new FormData(e.target);
    const events = ${JSON.stringify(ALL_EVENTS)}.filter(ev => form.get('event_' + ev));
    const body = {
      url: form.get('url'),
      secret: form.get('secret') || null,
      events: events.length === ${ALL_EVENTS.length} ? null : events,
      adapter: form.get('adapter'),
      enabled: form.get('enabled') === 'on',
    };
    try {
      const r = await fetch(${JSON.stringify(action)}, {
        method: ${JSON.stringify(isNew ? "POST" : "PATCH")},
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('save failed: ' + r.status));
      this.$dispatch('toast', { text: 'Endpoint saved' });
      setTimeout(() => location.href = '/admin/webhooks', 300);
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busy = false;
    }
  }
}">
  <h3 style="margin-top:0">${heading}</h3>
  ${errorBlock}
  <p x-show="error" style="color:var(--bad)" x-text="error"></p>
  <form @submit="submit">
    <p>
      <label>URL<br>
        <input type="text" name="url" required value="${escapeHtml(url)}"
          placeholder="https://example.com/webhooks/garrul"
          style="width:100%;max-width:560px">
      </label>
    </p>
    <p>
      <label>HMAC secret (recommended)<br>
        <input type="text" name="secret" value="${escapeHtml(secret)}"
          placeholder="whsec_…"
          style="width:100%;max-width:560px">
      </label>
      <span class="muted" style="display:block;font-size:0.8rem">
        Leave blank to send unsigned. Rotating the secret invalidates the
        old signature immediately — coordinate with the receiver before
        changing this on a live endpoint.
      </span>
    </p>
    <p>
      <label>Adapter<br>
        <select name="adapter">${adapterSelect(adapter)}</select>
      </label>
    </p>
    <p>
      Events:<br>
      ${eventChecklist(selectedEvents)}
      <span class="muted" style="display:block;font-size:0.8rem">
        All boxes checked = no filter (every event matches).
      </span>
    </p>
    <p>
      <label>
        <input type="checkbox" name="enabled" ${enabled ? "checked" : ""}>
        Enabled
      </label>
    </p>
    <button :disabled="busy" type="submit">
      <span x-show="!busy">${submitLabel}</span>
      <span x-show="busy">Saving…</span>
    </button>
  </form>
</div>`;
};
