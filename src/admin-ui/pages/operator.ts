import type { RerenderStats } from "../../db/rerender";
import type { RetentionStats } from "../../db/ip-retention";
import { MIN_RETENTION_DAYS } from "../../db/ip-retention";
import type { AuditRetentionStats } from "../../db/audit-retention";
import { MIN_AUDIT_RETENTION_DAYS } from "../../db/audit-retention";
import { MAX_XML_BYTES } from "../../lib/disqus-import";

export type OperatorData = {
	rerender: RerenderStats;
	retention: RetentionStats;
	audit_retention: AuditRetentionStats;
	seed_demo_allowed: boolean;
};

// Human-readable form of the shared import cap for the UI hint + client
// error message. Whole MB by construction (MAX_XML_BYTES is N * 1024²).
const MAX_XML_MB = Math.floor(MAX_XML_BYTES / (1024 * 1024));

// Always-shown tail of the retention card. The ghost count is the honest part:
// retention covers two of the three places an ip_hash lands, and an operator
// reading "IP retention: 90 days" would otherwise reasonably assume an export
// carries no hashes older than that. It does — for anonymous identities, which
// are never expired on a timer because that column *is* the identity.
const ghostNote = (ghosts: number): string => `
  <p class="muted">Anonymous ghost identities: <strong>${ghosts}</strong>.
    These are <em>never</em> swept — for a signed-out visitor the hashed IP
    <em>is</em> the account (it's how a returning visitor finds their own
    comments, and how a ghost ban keeps applying), so expiring it would delete
    accounts rather than hashes. Clear them per-person from a user's page
    ("Erase personal data"), or all at once with the purge runbook in
    <code>AGENTS-OPERATE.md</code> §11 if the hashing secret ever leaks.</p>`;

const retentionCard = (r: RetentionStats): string => {
	if (!r.enabled) {
		const reason =
			r.retention_days === 0
				? `Off. Stored hashes are kept for the life of the row.`
				: `Set to <code>${r.retention_days}</code> day(s), which is below the
	     ${MIN_RETENTION_DAYS}-day floor — the sweep refuses to run rather than
	     purge nearly everything on a typo. Raise it to ${MIN_RETENTION_DAYS} or
	     more, or set it to 0 to turn retention off deliberately.`;
		return `
<div class="card">
  <h3>IP-hash retention</h3>
  <p class="muted">${reason}
    Change it on <a href="/admin/settings">Settings</a> (or via
    <code>IP_HASH_RETENTION_DAYS</code>).</p>
  <p class="muted">Comments currently holding a hashed IP:
    <strong>${r.comments_total}</strong>.</p>
  ${ghostNote(r.ghosts_total)}
</div>`;
	}

	const pending = r.comments_pending + r.reports_pending;
	return `
<div class="card" x-data="{
  busy: false,
  comments: 0,
  reports: 0,
  done: false,
  error: null,
  step(first) {
    if (this.busy) return;
    if (first &amp;&amp; !confirm('Clear stored IP hashes older than ${r.retention_days} days? This cannot be undone.')) return;
    this.busy = true; this.error = null;
    return fetch('/admin/api/ops/ip-retention', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      this.comments += j.comments;
      this.reports += j.reports;
      this.busy = false;
      if (j.more) return this.step(false);
      this.done = true;
    }).catch(e => { this.error = e.message; this.busy = false; });
  }
}">
  <h3>IP-hash retention</h3>
  <p class="muted">Window: <strong>${r.retention_days}</strong> days. The cron
    sweeps automatically; this button just drains the backlog now instead of
    over the next few ticks. <strong>Irreversible</strong> — nothing
    reconstructs a cleared hash.</p>
  <p class="muted">Past the window right now — comments:
    <strong>${r.comments_pending}</strong> · reports:
    <strong>${r.reports_pending}</strong>.</p>
  ${
		pending > 0
			? `<button :disabled="busy" @click="step(true)">
    <span x-show="!busy &amp;&amp; !done">Sweep now</span>
    <span x-show="busy">Sweeping…</span>
    <span x-show="!busy &amp;&amp; done">Done</span>
  </button>
  <div class="muted" style="margin-top:0.5rem" x-show="comments || reports">
    Cleared <span x-text="comments"></span> comment(s) ·
    <span x-text="reports"></span> report(s)
  </div>
  <p style="color:var(--bad)" x-show="error" x-text="error"></p>`
			: `<p class="muted">Nothing to do — the cron has already swept everything
    past the window.</p>`
	}
  ${ghostNote(r.ghosts_total)}
</div>`;
};

const auditRetentionCard = (r: AuditRetentionStats): string => {
	// The oldest surviving row is the number that makes the setting concrete: an
	// operator deciding on a window wants to know they're sitting on four years
	// of history, not just that the table has 12,000 rows in it.
	const oldest =
		r.oldest === null
			? `<p class="muted">The audit log is empty.</p>`
			: `<p class="muted">Rows: <strong>${r.total}</strong>, oldest dated
	     <strong>${new Date(r.oldest).toISOString().slice(0, 10)}</strong>.</p>`;

	if (!r.enabled) {
		const reason =
			r.retention_days === 0
				? `Off. Moderation history is kept indefinitely.`
				: `Set to <code>${r.retention_days}</code> day(s), which is below the
	     ${MIN_AUDIT_RETENTION_DAYS}-day floor — the sweep refuses to run rather
	     than shred months of moderation history on a typo. Raise it to
	     ${MIN_AUDIT_RETENTION_DAYS} or more, or set it to 0 to keep everything
	     deliberately.`;
		return `
<div class="card">
  <h3>Audit-log retention</h3>
  <p class="muted">${reason}
    Change it on <a href="/admin/settings">Settings</a> (or via
    <code>AUDIT_LOG_RETENTION_DAYS</code>).</p>
  ${oldest}
</div>`;
	}

	return `
<div class="card" x-data="{
  busy: false,
  deleted: 0,
  done: false,
  error: null,
  step(first) {
    if (this.busy) return;
    if (first &amp;&amp; !confirm('Delete audit-log rows older than ${r.retention_days} days? This cannot be undone.')) return;
    this.busy = true; this.error = null;
    return fetch('/admin/api/ops/audit-retention', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      this.deleted += j.deleted;
      this.busy = false;
      if (j.more) return this.step(false);
      this.done = true;
    }).catch(e => { this.error = e.message; this.busy = false; });
  }
}">
  <h3>Audit-log retention</h3>
  <p class="muted">Window: <strong>${r.retention_days}</strong> days. The cron
    prunes automatically; this button just drains the backlog now instead of
    over the next few ticks. <strong>Irreversible</strong> — a pruned row is
    gone, and with it the record of why an action was taken.</p>
  ${oldest}
  <p class="muted">Past the window right now: <strong>${r.pending}</strong>.</p>
  ${
		r.pending > 0
			? `<button :disabled="busy" @click="step(true)">
    <span x-show="!busy &amp;&amp; !done">Prune now</span>
    <span x-show="busy">Pruning…</span>
    <span x-show="!busy &amp;&amp; done">Done</span>
  </button>
  <div class="muted" style="margin-top:0.5rem" x-show="deleted">
    Deleted <span x-text="deleted"></span> row(s)
  </div>
  <p style="color:var(--bad)" x-show="error" x-text="error"></p>`
			: `<p class="muted">Nothing to do — the cron has already pruned everything
    past the window.</p>`
	}
</div>`;
};

export const renderOperator = (data: OperatorData): string => {
	const { rerender, retention, audit_retention, seed_demo_allowed } = data;
	const seedCard = seed_demo_allowed
		? `
<div class="card" x-data="{
  busy: false,
  result: null,
  error: null,
  run() {
    this.busy = true; this.error = null; this.result = null;
    return fetch('/admin/api/ops/seed-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      this.result = j;
    }).catch(e => { this.error = e.message; })
      .finally(() => { this.busy = false; });
  }
}">
  <h3>Seed demo post</h3>
  <p class="muted">Inserts the <code>welcome</code> post + a small comment thread.
    Skipped when the welcome post already has comments.</p>
  <button :disabled="busy" @click="run()">
    <span x-show="!busy">Seed demo</span>
    <span x-show="busy">Seeding…</span>
  </button>
  <p class="muted" x-show="result"
     x-text="result &amp;&amp; (result.skipped
       ? 'Already seeded — nothing changed.'
       : ('Inserted ' + result.comments_inserted + ' comments, ' + result.users_inserted + ' users.'))"></p>
  <p style="color:var(--bad)" x-show="error" x-text="error"></p>
</div>`
		: `
<div class="card">
  <h3>Seed demo post</h3>
  <p class="muted">Disabled in production. Set <code>ENV=dev</code> on this
    instance to enable.</p>
</div>`;

	return `
<div class="card" x-data="{
  busy: false,
  processed: 0,
  remaining: ${rerender.stale},
  cursor: null,
  error: null,
  step() {
    if (this.busy) return;
    this.busy = true; this.error = null;
    const body = this.cursor
      ? JSON.stringify({ cursor: this.cursor, batch: 50 })
      : JSON.stringify({ batch: 50 });
    return fetch('/admin/api/ops/rerender', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).then(async r => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      this.processed += j.processed;
      this.remaining = Math.max(0, this.remaining - j.processed);
      this.cursor = j.next_cursor;
      this.busy = false;
      if (j.next_cursor) {
        return this.step();
      }
    }).catch(e => { this.error = e.message; this.busy = false; });
  }
}">
  <h3>Rerender comments</h3>
  <p class="muted">Current renderer version: <code>${rerender.current_version}</code>.
    Up to date: <strong>${rerender.up_to_date}</strong> ·
    Stale: <strong>${rerender.stale}</strong>
    ${rerender.oldest_version != null ? `· oldest stale at v${rerender.oldest_version}` : ""}.</p>
  ${
		rerender.stale > 0
			? `<button :disabled="busy" @click="step()">
    <span x-show="!busy &amp;&amp; remaining > 0">Run rerender</span>
    <span x-show="busy">Working…</span>
    <span x-show="!busy &amp;&amp; remaining === 0">Done</span>
  </button>
  <div class="muted" style="margin-top:0.5rem">
    Processed <span x-text="processed"></span> · remaining <span x-text="remaining"></span>
  </div>
  <p style="color:var(--bad)" x-show="error" x-text="error"></p>`
			: `<p class="muted">Nothing to do — all comments are at the current version.</p>`
	}
</div>

${retentionCard(retention)}
${auditRetentionCard(audit_retention)}

${seedCard}

<div class="card" x-data="{
  busy: false,
  result: null,
  error: null,
  dryRun: true,
  includeDeleted: false,
  includeSpam: false,
  async run(file) {
    if (!file) return;
    if (file.size > ${MAX_XML_BYTES}) {
      this.error = 'file too large (max ${MAX_XML_MB} MB)';
      return;
    }
    this.busy = true; this.error = null; this.result = null;
    try {
      const text = await file.text();
      const r = await fetch('/admin/api/ops/import-disqus', {
        method: 'POST',
        headers: {
          'content-type': 'application/xml',
          'x-dry-run': this.dryRun ? '1' : '0',
          'x-include-deleted': this.includeDeleted ? '1' : '0',
          'x-include-spam': this.includeSpam ? '1' : '0',
        },
        body: text,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'import failed');
      this.result = j;
    } catch (e) {
      this.error = e.message || 'import failed';
    } finally {
      this.busy = false;
    }
  }
}">
  <h3>Import Disqus export</h3>
  <p class="muted">Uploads a Disqus comment-export XML file and ingests it
    into D1. Idempotent: re-running the same file is a no-op
    (deduplicated by Disqus comment ID). Imported HTML is stripped and
    re-rendered through the standard markdown allowlist.</p>
  <p>
    <label style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.8rem">
      <input type="checkbox" x-model="dryRun"> Dry run (parse + plan only)
    </label>
    <label style="display:inline-flex;gap:0.3rem;align-items:center;margin-right:0.8rem">
      <input type="checkbox" x-model="includeDeleted"> Include deleted
    </label>
    <label style="display:inline-flex;gap:0.3rem;align-items:center">
      <input type="checkbox" x-model="includeSpam"> Include spam
    </label>
  </p>
  <input type="file" accept=".xml,application/xml,text/xml"
         :disabled="busy"
         @change="run($event.target.files[0])">
  <p class="muted" x-show="busy">Importing… don't navigate away.</p>
  <pre x-show="result" x-text="result &amp;&amp; JSON.stringify(result, null, 2)"
       style="background:var(--bg);padding:0.6rem;border-radius:4px;font-size:0.85rem"></pre>
  <p style="color:var(--bad)" x-show="error" x-text="error"></p>
  <p class="muted">Max upload: ${MAX_XML_MB} MB. For larger exports use the CLI: <code>npm run import-disqus -- ./export.xml --dry-run</code>.</p>
</div>
`;
};
