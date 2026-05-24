import type { AuditRowWithAdmin, AdminAction } from "../../db/queries";
import { escapeHtml } from "../escape";

export type AuditFilters = {
	admin_id: string;
	action: string;
	target_kind: string;
	target_id: string;
	from: string;
	to: string;
};

const queryString = (f: AuditFilters): string => {
	const params = new URLSearchParams();
	if (f.admin_id) params.set("admin_id", f.admin_id);
	if (f.action) params.set("action", f.action);
	if (f.target_kind) params.set("target_kind", f.target_kind);
	if (f.target_id) params.set("target_id", f.target_id);
	if (f.from) params.set("from", f.from);
	if (f.to) params.set("to", f.to);
	const s = params.toString();
	return s ? `?${s}` : "";
};

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const targetLink = (kind: string, id: string | null): string => {
	if (!id) return "—";
	if (kind === "comment")
		return `<a href="/admin/comments/${escapeHtml(id)}">comment <code>${escapeHtml(id.slice(0, 8))}</code></a>`;
	if (kind === "user")
		return `<a href="/admin/users/${escapeHtml(id)}">user <code>${escapeHtml(id.slice(0, 8))}</code></a>`;
	return `<code>${escapeHtml(kind)}:${escapeHtml(id.slice(0, 8))}</code>`;
};

export const renderAudit = (
	rows: AuditRowWithAdmin[],
	filters: AuditFilters,
	nextCursor: string | null,
	actions: ReadonlyArray<AdminAction>,
): string => {
	const actionOptions = ["", ...actions]
		.map(
			(a) =>
				`<option value="${escapeHtml(a)}"${a === filters.action ? " selected" : ""}>${a || "any action"}</option>`,
		)
		.join("");
	const kindOptions = ["", "comment", "user", "subscription", "system"]
		.map(
			(k) =>
				`<option value="${escapeHtml(k)}"${k === filters.target_kind ? " selected" : ""}>${k || "any kind"}</option>`,
		)
		.join("");

	const trs = rows.length
		? rows
				.map(
					(r) => {
						const meta = r.meta ? escapeHtml(r.meta) : "";
						return `
<tr>
  <td class="muted">${formatTs(r.created_at)}</td>
  <td><span class="pill">${escapeHtml(r.action)}</span></td>
  <td>${escapeHtml(r.admin_name ?? r.admin_id)}</td>
  <td>${escapeHtml(r.target_kind)}</td>
  <td>${targetLink(r.target_kind, r.target_id)}</td>
  <td class="muted">${escapeHtml(r.reason ?? "")}</td>
  <td class="muted" style="font-size:0.75rem">${meta}</td>
</tr>`;
					},
				)
				.join("")
		: `<tr><td colspan="7" class="muted">No audit rows.</td></tr>`;

	const qs = queryString(filters);
	const nextHref = nextCursor
		? `/admin/audit${qs}${qs ? "&" : "?"}before=${encodeURIComponent(nextCursor)}`
		: null;
	const next = nextHref
		? `<a href="${nextHref}">Next →</a>`
		: '<span class="muted">end</span>';

	return `
<form class="filter-bar queue-filter" method="get" action="/admin/audit">
  <input type="text" name="admin_id" placeholder="admin id" value="${escapeHtml(filters.admin_id)}">
  <select name="action">${actionOptions}</select>
  <select name="target_kind">${kindOptions}</select>
  <input type="text" name="target_id" placeholder="target id" value="${escapeHtml(filters.target_id)}">
  <input type="date" name="from" value="${escapeHtml(filters.from)}" title="from (UTC)">
  <input type="date" name="to" value="${escapeHtml(filters.to)}" title="to (UTC, inclusive)">
  <button type="submit">Filter</button>
  <a href="/admin/audit" class="muted">clear</a>
</form>

<div class="card">
  <table>
    <thead><tr>
      <th>When</th><th>Action</th><th>Admin</th><th>Kind</th><th>Target</th><th>Reason</th><th>Meta</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  <div class="pager">${next}</div>
</div>`;
};
