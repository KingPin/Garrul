import type { Subscription } from "../../db/queries";
import { renderHostFilter } from "../components/host-filter";
import { escapeHtml } from "../escape";

export type SubscriptionsFilters = {
	q: string;
	post_slug: string;
	confirmed: "" | "yes" | "no";
	unsubscribed: "" | "yes" | "no";
	host: string;
};

const queryString = (f: SubscriptionsFilters): string => {
	const params = new URLSearchParams();
	if (f.q) params.set("q", f.q);
	if (f.post_slug) params.set("post_slug", f.post_slug);
	if (f.confirmed) params.set("confirmed", f.confirmed);
	if (f.unsubscribed) params.set("unsubscribed", f.unsubscribed);
	if (f.host) params.set("host", f.host);
	const s = params.toString();
	return s ? `?${s}` : "";
};

const formatTs = (ts: number | null): string => {
	if (ts == null) return "—";
	return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
};

const statusPill = (sub: Subscription): string => {
	if (sub.unsubscribed_at != null)
		return '<span class="pill banned">unsubscribed</span>';
	if (sub.confirmed_at != null)
		return '<span class="pill approved">confirmed</span>';
	return '<span class="pill pending">pending</span>';
};

// JSON-stringify + HTML-escape so the value is a well-formed JS string
// literal inside the Alpine expression regardless of the id's content.
// ULIDs are safe today but the typing is just `string`.
const jsLiteral = (s: string): string => escapeHtml(JSON.stringify(s));

const actionButtons = (sub: Subscription): string => {
	const parts: string[] = [];
	if (sub.unsubscribed_at == null) {
		parts.push(
			`<button :disabled="busy" class="bad" @click="busy=true; act(${jsLiteral(sub.id)},'unsubscribe').finally(()=>busy=false)">Unsubscribe</button>`,
		);
	}
	if (sub.confirmed_at == null && sub.unsubscribed_at == null) {
		parts.push(
			`<button :disabled="busy" @click="busy=true; act(${jsLiteral(sub.id)},'resend').finally(()=>busy=false)">Resend confirm</button>`,
		);
	}
	return parts.join("");
};

export const renderSubscriptions = (
	rows: Subscription[],
	filters: SubscriptionsFilters,
	nextCursor: string | null,
	hosts: string[] = [],
): string => {
	const selOpts = (
		name: "confirmed" | "unsubscribed",
		current: SubscriptionsFilters["confirmed"],
	): string => {
		const labels: Record<string, string> = {
			"": "any",
			yes: name === "confirmed" ? "confirmed only" : "unsubscribed only",
			no: name === "confirmed" ? "pending only" : "active only",
		};
		return ["", "yes", "no"]
			.map(
				(v) =>
					`<option value="${v}"${v === current ? " selected" : ""}>${escapeHtml(labels[v] ?? v)}</option>`,
			)
			.join("");
	};

	const trs = rows.length
		? rows
				.map(
					(s) => `
<tr x-data="{ busy: false }">
  <td>${statusPill(s)}</td>
  <td class="muted">${formatTs(s.created_at)}</td>
  <td><code>${escapeHtml(s.email)}</code></td>
  <td><code>${escapeHtml(s.post_slug)}</code></td>
  <td class="muted">${formatTs(s.last_notified_at)}</td>
  <td class="actions">${actionButtons(s)}</td>
</tr>`,
				)
				.join("")
		: `<tr><td colspan="6" class="muted">No subscriptions match.</td></tr>`;

	const qs = queryString(filters);
	const nextHref = nextCursor
		? `/admin/subscriptions${qs}${qs ? "&" : "?"}before=${encodeURIComponent(nextCursor)}`
		: null;
	const next = nextHref
		? `<a href="${nextHref}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<form class="filter-bar queue-filter" method="get" action="/admin/subscriptions">
  <input type="text" name="q" placeholder="email search" value="${escapeHtml(filters.q)}">
  <input type="text" name="post_slug" placeholder="post slug" value="${escapeHtml(filters.post_slug)}">
  <select name="confirmed">${selOpts("confirmed", filters.confirmed)}</select>
  <select name="unsubscribed">${selOpts("unsubscribed", filters.unsubscribed)}</select>
  ${renderHostFilter({ hosts, selected: filters.host })}
  <button type="submit">Filter</button>
  <a href="/admin/subscriptions" class="muted">clear</a>
</form>

<div class="card" x-data="{
  act(id, action) {
    return fetch('/admin/api/subscriptions/' + id, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.$dispatch('toast', { text: action === 'unsubscribe' ? 'Unsubscribed' : 'Confirmation resent' });
      setTimeout(() => location.reload(), 500);
    }).catch(e => {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    });
  }
}">
  <table>
    <thead><tr>
      <th>Status</th><th>Subscribed</th><th>Email</th><th>Post</th><th>Last notified</th><th>Actions</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};
