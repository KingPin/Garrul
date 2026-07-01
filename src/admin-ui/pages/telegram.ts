import { escapeHtml } from "../escape";

export type TelegramPageData = {
	/** TELEGRAM_BOT_TOKEN is set — outbound + interactive both need it. */
	configured: boolean;
	/** TELEGRAM_WEBHOOK_SECRET is set — required for inbound (buttons/commands). */
	webhookSecretSet: boolean;
	/** Bot @username (no @), if TELEGRAM_BOT_USERNAME is set — enables a deep link. */
	botUsername: string | null;
	/** The viewing admin's existing link, if any. */
	link: { linked_at: number; digest: boolean } | null;
};

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const setupCard = (data: TelegramPageData): string => {
	const tokenPill = data.configured
		? '<span class="pill approved">set</span>'
		: '<span class="pill spam">missing</span>';
	const secretPill = data.webhookSecretSet
		? '<span class="pill approved">set</span>'
		: '<span class="pill pending">missing</span>';
	return `
<div class="card">
  <h3 style="margin-top:0">Bot configuration</h3>
  <p class="muted">
    The Telegram operator bot is configured with Worker secrets, not in this
    panel. See <code>docs/telegram.md</code> for BotFather setup and the
    <code>setWebhook</code> call.
  </p>
  <table>
    <tbody>
      <tr><td><code>TELEGRAM_BOT_TOKEN</code></td><td>${tokenPill}</td>
          <td class="muted">Sends notifications + powers buttons and commands.</td></tr>
      <tr><td><code>TELEGRAM_WEBHOOK_SECRET</code></td><td>${secretPill}</td>
          <td class="muted">Required for inbound buttons / slash commands.</td></tr>
    </tbody>
  </table>
  ${
		data.configured
			? ""
			: `<p style="color:var(--warn)">Set <code>TELEGRAM_BOT_TOKEN</code> via
         <code>wrangler secret put</code> before linking — linking is useless
         until the bot can message you.</p>`
	}
</div>`;
};

const linkedCard = (data: TelegramPageData): string => {
	// data.link is non-null in this branch.
	const link = data.link as { linked_at: number; digest: boolean };
	return `
<div class="card" x-data="${escapeHtml(`{
  busy: false,
  digest: ${link.digest ? "true" : "false"},
  async toggleDigest() {
    if (this.busy) return;
    this.busy = true;
    const next = !this.digest;
    try {
      const r = await fetch('/admin/api/telegram/digest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digest: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.digest = next;
      this.$dispatch('toast', { text: next ? 'Daily digest on' : 'Daily digest off' });
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  },
  async unlink() {
    if (this.busy) return;
    if (!confirm('Unlink this Telegram account? You will stop receiving operator messages and can no longer moderate from Telegram.')) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/telegram/link', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.$dispatch('toast', { text: 'Telegram account unlinked' });
      setTimeout(() => location.reload(), 300);
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  }
}`)}">
  <h3 style="margin-top:0">Your linked account</h3>
  <p class="muted">Linked ${formatTs(link.linked_at)}. Notification buttons and
    slash commands run under your account, with your current role.</p>
  <p>
    <label style="display:inline-flex;gap:0.4rem;align-items:center">
      <input type="checkbox" :checked="digest" :disabled="busy" @change="toggleDigest()">
      Send me the daily operator digest
    </label>
  </p>
  <p><button class="bad" :disabled="busy" @click="unlink()">Unlink Telegram</button></p>
</div>`;
};

const linkCard = (data: TelegramPageData): string => {
	const deepLinkJs = data.botUsername
		? `'https://t.me/${data.botUsername}?start=' + j.code`
		: "null";
	const instruction = data.botUsername
		? `Tap the link below (or send <code>/start &lt;code&gt;</code> to the bot manually).`
		: `Send <code>/start &lt;code&gt;</code> to your bot in Telegram. The code expires in 10 minutes.`;
	return `
<div class="card" x-data="${escapeHtml(`{
  busy: false,
  code: null,
  deepLink: null,
  async generate() {
    if (this.busy) return;
    this.busy = true; this.code = null; this.deepLink = null;
    try {
      const r = await fetch('/admin/api/telegram/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.code = j.code;
      this.deepLink = ${deepLinkJs};
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  }
}`)}">
  <h3 style="margin-top:0">Link your Telegram account</h3>
  <p class="muted">${instruction}</p>
  <p><button :disabled="busy" @click="generate()">
    <span x-show="!busy">Generate link code</span>
    <span x-show="busy">Generating…</span>
  </button></p>
  <template x-if="code">
    <div>
      <p>Your one-time code:
        <code x-text="code" style="user-select:all;font-size:1.1rem"></code>
      </p>
      <p x-show="deepLink">
        <a class="btn" :href="deepLink" target="_blank" rel="noopener">Open in Telegram</a>
      </p>
    </div>
  </template>
</div>`;
};

export const renderTelegram = (data: TelegramPageData): string => {
	const linkSection = data.link ? linkedCard(data) : linkCard(data);
	return `
<p class="muted" style="margin-top:0">
  Connect a Telegram account to receive operator notifications and moderate
  comments from your phone. Notifications are configured as a
  <a href="/admin/webhooks">webhook endpoint</a> with the Telegram adapter;
  this page links your personal account for interactive buttons, slash
  commands, and the optional daily digest.
</p>
${setupCard(data)}
${linkSection}`;
};
