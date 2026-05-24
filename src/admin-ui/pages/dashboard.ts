import type { Bindings } from "../../index";
import type { AdminStats } from "../../db/queries";
import { spamSummary } from "../components/spam-summary";

export const renderDashboard = (stats: AdminStats, env: Bindings): string => `
<div class="card">
  <h2>Overview</h2>
  <div class="stat-grid">
    <div class="stat"><div class="v">${stats.total_comments}</div><div class="l">total comments</div></div>
    <div class="stat"><div class="v">${stats.pending_comments}</div><div class="l">pending</div></div>
    <div class="stat"><div class="v">${stats.spam_comments}</div><div class="l">spam</div></div>
    <div class="stat"><div class="v">${stats.total_users}</div><div class="l">users</div></div>
    <div class="stat"><div class="v">${stats.banned_users}</div><div class="l">banned</div></div>
  </div>
  <p class="muted">Anti-spam: ${spamSummary(env)}. See <a href="/admin/settings">Settings</a> to change.</p>
</div>
<div class="card">
  <h3>Quick actions</h3>
  <ul>
    <li><a href="/admin/queue?status=pending">Review ${stats.pending_comments} pending comment(s)</a></li>
    <li><a href="/admin/queue?status=spam">Inspect spam folder</a></li>
    <li><a href="/admin/users">Manage users</a></li>
  </ul>
</div>`;
