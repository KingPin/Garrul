import type { Bindings } from "../../index";
import {
	type FlagKey,
	type NumberKey,
	type ResolvedFlags,
	type ResolvedNumbers,
	numberBounds,
} from "../../lib/settings";
import { renderStepper, renderSwitch, renderTabs } from "../controls";
import { escapeHtml } from "../escape";

// Settings tabs. Email / Moderation tabs can slot in here later without
// touching the panel-toggle wiring (each panel just keys off `tab`).
const TABS = [
	{ id: "features", label: "Features" },
	{ id: "display", label: "Display" },
	{ id: "config", label: "Configuration" },
];

// Operator-facing labels + help for each runtime feature flag. Order here is
// the order rendered in the toggles card.
const FLAG_META: { key: FlagKey; label: string; help: string }[] = [
	{
		key: "comments_enabled",
		label: "Comments",
		help: "Accept new comments. When off, the composer is hidden and posting is rejected.",
	},
	{
		key: "reactions_enabled",
		label: "Emoji reactions (comments)",
		help: "Per-comment emoji reactions (like / love / laugh / hmm / cry).",
	},
	{
		key: "votes_enabled",
		label: "Votes (comments)",
		help: "Up/down voting on comments and the sort-by-top option.",
	},
	{
		key: "downvotes_enabled",
		label: "Downvotes",
		help: "Allow the downvote arrow. Ignored while comment votes are off.",
	},
	{
		key: "page_reactions_enabled",
		label: "Page reactions",
		help: "Let readers react to the article itself with an emoji, without leaving a comment.",
	},
	{
		key: "page_votes_enabled",
		label: "Page vote",
		help: "A simple helpful/up vote tally on the article itself.",
	},
];

// Operator-facing labels + help for each numeric display setting. Bounds are
// pulled from the settings registry so the input min/max can't drift from the
// server-side clamp.
const NUMBER_META: { key: NumberKey; label: string; help: string }[] = [
	{
		key: "comments_per_page",
		label: "Comments per page",
		help: "Top-level comments shown per initial load. \"Load older comments\" reveals the next batch.",
	},
	{
		key: "replies_per_thread",
		label: "Replies before “show more”",
		help: "Replies shown under each comment before a “Show N more replies” button. 0 = show all.",
	},
	{
		key: "auto_collapse_depth",
		label: "Auto-collapse depth",
		help: "Replies nested at this depth or deeper start collapsed. 0 = never auto-collapse.",
	},
];

export const renderSettings = (
	env: Bindings,
	flags: ResolvedFlags,
	numbers: ResolvedNumbers,
): string => {
	const rows: [string, string][] = [
		["ENV", env.ENV ?? "(unset)"],
		["ALLOWED_ORIGINS", env.ALLOWED_ORIGINS ?? "(unset)"],
		["ADMIN_EMAILS", env.ADMIN_EMAILS ?? "(unset)"],
		["EDIT_WINDOW_MINUTES", env.EDIT_WINDOW_MINUTES ?? "(default: 15)"],
		["TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY ? "(set)" : "(unset)"],
		["GH_CLIENT_ID", env.GH_CLIENT_ID ? "(set)" : "(unset)"],
		["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID ? "(set)" : "(unset)"],
		["FACEBOOK_CLIENT_ID", env.FACEBOOK_CLIENT_ID ? "(set)" : "(unset)"],
		[
			"OAUTH_CALLBACK_BASE",
			env.OAUTH_CALLBACK_BASE ?? "(falls back to request origin)",
		],
		["EMAIL_PROVIDER", env.EMAIL_PROVIDER ?? "(unset)"],
		["SPAM_PROVIDER", env.SPAM_PROVIDER || "(unset)"],
		["AKISMET_API_KEY", env.AKISMET_API_KEY ? "(set)" : "(unset)"],
		["AKISMET_SITE_URL", env.AKISMET_SITE_URL ?? "(unset)"],
		["SPAM_LINK_THRESHOLD", env.SPAM_LINK_THRESHOLD ?? "(unset)"],
		["SPAM_HONEYPOT_MIN_MS", env.SPAM_HONEYPOT_MIN_MS ?? "(unset)"],
		["SPAM_FIRST_COMMENT_MODERATE", env.SPAM_FIRST_COMMENT_MODERATE ?? "(unset)"],
		["SPAM_FORM_TS_SECRET", env.SPAM_FORM_TS_SECRET ? "(set)" : "(unset)"],
	];
	const body = rows
		.map(
			([k, v]) =>
				`<tr><td><code>${k}</code></td><td>${escapeHtml(v)}</td></tr>`,
		)
		.join("");

	// Feature-flag toggles. Each checkbox reflects the *resolved* effective
	// value (DB override > env > default). Saving writes an explicit DB row
	// per flag (overriding env); "Reset to defaults" clears the rows so the
	// env vars / built-in defaults apply again.
	const toggles = FLAG_META.map((f) =>
		renderSwitch({
			name: f.key,
			model: `flags.${f.key}`,
			label: f.label,
			help: f.help,
		}),
	).join("");

	// Numeric display settings. Each stepper reflects the resolved effective
	// value; min/max mirror the server-side clamp (numberBounds).
	const numberInputs = NUMBER_META.map((f) => {
		const b = numberBounds(f.key);
		return renderStepper({
			name: f.key,
			model: `nums.${f.key}`,
			min: b.min,
			max: b.max,
			label: f.label,
			help: f.help,
		});
	}).join("");

	const initial = JSON.stringify(
		Object.fromEntries(FLAG_META.map((f) => [f.key, flags[f.key]])),
	);
	const numInitial = JSON.stringify(
		Object.fromEntries(NUMBER_META.map((f) => [f.key, numbers[f.key]])),
	);

	return `
<div x-data="{
  tab: 'features',
  busy: false,
  flags: ${escapeHtml(initial)},
  nums: ${escapeHtml(numInitial)},
  async save() {
    this.busy = true;
    try {
      const r = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flags: this.flags, numbers: this.nums }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Save failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Settings saved' });
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Save failed', kind: 'bad' });
    } finally {
      this.busy = false;
    }
  },
  async reset() {
    if (!confirm('Clear all runtime overrides and fall back to env vars / defaults?')) return;
    this.busy = true;
    try {
      const r = await fetch('/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('Reset failed: ' + r.status));
      }
      this.$dispatch('toast', { text: 'Reset to defaults' });
      setTimeout(() => location.reload(), 300);
    } catch (err) {
      this.$dispatch('toast', { text: err.message || 'Reset failed', kind: 'bad' });
      this.busy = false;
    }
  },
}">
  ${renderTabs("tab", TABS)}

  <form @submit.prevent="save()">
    <div class="card" x-show="tab === 'features'">
      <h2>Features</h2>
      <p class="muted">Toggle features without a redeploy. A toggle here overrides
      the matching env var (<code>VOTING_ENABLED</code>, <code>REACTIONS_ENABLED</code>,
      …); "Reset to defaults" clears the overrides so the env vars / built-in
      defaults apply again.</p>
      ${toggles}
    </div>

    <div class="card" x-show="tab === 'display'" x-cloak>
      <h2>Display &amp; pagination</h2>
      <p class="muted">Control how many comments load at once and how nested
      replies collapse. Smaller values keep a busy thread from pushing the rest
      of the page down.</p>
      ${numberInputs}
    </div>

    <p class="settings-actions" x-show="tab !== 'config'">
      <button type="submit" class="btn-primary" :disabled="busy">Save settings</button>
      <button type="button" class="secondary" @click="reset()" :disabled="busy">Reset to defaults</button>
    </p>
  </form>

  <div class="card" x-show="tab === 'config'" x-cloak>
    <h2>Configuration</h2>
    <p class="muted">These remain environment variables. Change them with
    <code>wrangler secret put NAME</code> (or edit <code>wrangler.toml</code>
    <code>[vars]</code> for non-secrets) and redeploy.</p>
    <table>
      <thead><tr><th>Variable</th><th>Value</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <h3>Bindings</h3>
    <ul>
      <li><code>DB</code> — D1 database (comments, users, reactions, posts)</li>
      <li><code>RATE_LIMITS</code>, <code>OAUTH_STATE</code>, <code>SESSIONS</code>, <code>TREE_CACHE</code> — KV namespaces</li>
      <li><code>ANALYTICS</code> — Workers Analytics Engine dataset (optional)</li>
    </ul>
  </div>
</div>`;
};
