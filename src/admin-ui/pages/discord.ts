import { escapeHtml } from "../escape";

export type DiscordPageData = {
	/** DISCORD_BOT_TOKEN and DISCORD_PUBLIC_KEY are both set. */
	configured: boolean;
	botTokenSet: boolean;
	publicKeySet: boolean;
	clientIdSet: boolean;
	/** `${PUBLIC_BASE_URL}/discord/interactions`, or null when the base URL is unset. */
	endpointUrl: string | null;
	settings: { guildId: string; modRoleId: string; adminRoleId: string; digestChannelId: string };
	/** The viewing admin's existing link, if any. */
	link: { linked_at: number } | null;
};

const formatTs = (ts: number): string =>
	new Date(ts).toISOString().slice(0, 16).replace("T", " ");

const pill = (set: boolean, missing = "spam"): string =>
	set ? '<span class="pill approved">set</span>' : `<span class="pill ${missing}">missing</span>`;

const setupCard = (d: DiscordPageData): string => `
<div class="card">
  <h3 style="margin-top:0">Bot configuration</h3>
  <p class="muted">
    The Discord bot is configured with Worker secrets, not in this panel.
    Paste the endpoint URL below into the Discord developer portal as the
    <em>Interactions Endpoint URL</em>.
  </p>
  <table>
    <tbody>
      <tr><td><code>DISCORD_BOT_TOKEN</code></td><td>${pill(d.botTokenSet)}</td></tr>
      <tr><td><code>DISCORD_PUBLIC_KEY</code></td><td>${pill(d.publicKeySet)}</td></tr>
      <tr><td><code>DISCORD_CLIENT_ID</code></td><td>${pill(d.clientIdSet, "pending")}</td>
          <td class="muted">Application id, needed to register commands.</td></tr>
    </tbody>
  </table>
  <p>Interactions endpoint URL:
    ${
			d.endpointUrl
				? `<code style="user-select:all">${escapeHtml(d.endpointUrl)}</code>`
				: `<span style="color:var(--warn)">Set <code>PUBLIC_BASE_URL</code> to see the endpoint URL.</span>`
		}
  </p>
  ${
		d.configured
			? ""
			: `<p style="color:var(--warn)">Set <code>DISCORD_BOT_TOKEN</code> and
         <code>DISCORD_PUBLIC_KEY</code> via <code>wrangler secret put</code>
         to enable the bot.</p>`
	}
</div>`;

const alpine = (js: string): string => escapeHtml(js);

const settingsCard = (d: DiscordPageData): string => {
	const s = d.settings;
	const init = `{
  busy: false,
  f: ${JSON.stringify({
		guild_id: s.guildId,
		mod_role_id: s.modRoleId,
		admin_role_id: s.adminRoleId,
		digest_channel_id: s.digestChannelId,
	}).replace(/</g, "\\u003c")},
  async save() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/discord/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.f),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.$dispatch('toast', { text: 'Discord settings saved' });
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  },
  async register() {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/discord/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ? (j.error + (j.status ? ' (' + j.status + ')' : '')) : ('failed: ' + r.status));
      this.$dispatch('toast', { text: 'Slash commands registered' });
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  }
}`;
	const field = (key: string, label: string, hint: string): string => `
    <p><label>${label}<br>
      <input type="text" x-model="f.${key}" inputmode="numeric" pattern="[0-9]*" placeholder="snowflake id" style="min-width:20rem">
      <span class="muted">${hint}</span></label></p>`;
	return `
<div class="card" x-data="${alpine(init)}">
  <h3 style="margin-top:0">Server settings</h3>
  <p class="muted">Discord ids (enable Developer Mode, then right-click to copy an id). Leave a field empty to clear it.</p>
  <form @submit.prevent="save()">
    ${field("guild_id", "Server (guild) id", "Required for commands and the digest.")}
    ${field("mod_role_id", "Moderator role id", "Members with this role act as moderators.")}
    ${field("admin_role_id", "Admin role id", "Members with this role act as admins.")}
    ${field("digest_channel_id", "Digest channel id", "Daily digest goes here. Checked against Discord on save.")}
    <p><button type="submit" :disabled="busy">Save settings</button></p>
  </form>
  <h3>Slash commands</h3>
  <p class="muted">Registers <code>/queue</code>, <code>/stats</code>, <code>/comment</code>, <code>/user</code>, <code>/unban</code> and <code>/link</code> in your server. Save the server id first.</p>
  <p><button :disabled="busy" @click="register()">Register commands</button></p>
</div>`;
};

const linkedCard = (d: DiscordPageData): string => {
	const link = d.link as { linked_at: number };
	const init = `{
  busy: false,
  async unlink() {
    if (this.busy) return;
    if (!confirm('Unlink this Discord account? You can no longer moderate from Discord.')) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/api/discord/link', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.$dispatch('toast', { text: 'Discord account unlinked' });
      setTimeout(() => location.reload(), 300);
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  }
}`;
	return `
<div class="card" x-data="${alpine(init)}">
  <h3 style="margin-top:0">Your linked account</h3>
  <p class="muted">Linked ${formatTs(link.linked_at)}. Buttons and slash commands run under your account, with your current role.</p>
  <p><button class="bad" :disabled="busy" @click="unlink()">Unlink Discord</button></p>
</div>`;
};

const linkCard = (): string => {
	const init = `{
  busy: false,
  code: null,
  async generate() {
    if (this.busy) return;
    this.busy = true; this.code = null;
    try {
      const r = await fetch('/admin/api/discord/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('failed: ' + r.status));
      this.code = j.code;
    } catch (e) {
      this.$dispatch('toast', { text: e.message, kind: 'bad' });
    } finally { this.busy = false; }
  }
}`;
	return `
<div class="card" x-data="${alpine(init)}">
  <h3 style="margin-top:0">Link your Discord account</h3>
  <p class="muted">Generate a code, then run <code>/link code:&lt;code&gt;</code> in your server. The code expires in 10 minutes.</p>
  <p><button :disabled="busy" @click="generate()">
    <span x-show="!busy">Generate link code</span>
    <span x-show="busy">Generating…</span>
  </button></p>
  <template x-if="code">
    <p>Your one-time code: <code x-text="code" style="user-select:all;font-size:1.1rem"></code></p>
  </template>
</div>`;
};

export const renderDiscord = (d: DiscordPageData): string => `
<p class="muted" style="margin-top:0">
  Connect Discord to moderate comments from your server. Alerts are posted by
  a <a href="/admin/webhooks">webhook endpoint</a> with the Discord bot adapter;
  this page sets up the server, links your account and registers slash commands.
</p>
${setupCard(d)}
${settingsCard(d)}
${d.link ? linkedCard(d) : linkCard()}`;
