import type { RerenderStats } from "../../db/rerender";
import { MAX_XML_BYTES } from "../../lib/disqus-import";

export type OperatorData = {
	rerender: RerenderStats;
	seed_demo_allowed: boolean;
};

// Human-readable form of the shared import cap for the UI hint + client
// error message. Whole MB by construction (MAX_XML_BYTES is N * 1024²).
const MAX_XML_MB = Math.floor(MAX_XML_BYTES / (1024 * 1024));

export const renderOperator = (data: OperatorData): string => {
	const { rerender, seed_demo_allowed } = data;
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
