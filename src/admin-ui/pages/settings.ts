import type { Bindings } from "../../index";
import { escapeHtml } from "../escape";

export const renderSettings = (env: Bindings): string => {
	const rows: [string, string][] = [
		["ENV", env.ENV ?? "(unset)"],
		["ALLOWED_ORIGINS", env.ALLOWED_ORIGINS ?? "(unset)"],
		["ADMIN_EMAILS", env.ADMIN_EMAILS ?? "(unset)"],
		["EDIT_WINDOW_MINUTES", env.EDIT_WINDOW_MINUTES ?? "(default: 15)"],
		["TURNSTILE_SITE_KEY", env.TURNSTILE_SITE_KEY ? "(set)" : "(unset)"],
		["GH_CLIENT_ID", env.GH_CLIENT_ID ? "(set)" : "(unset)"],
		["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID ? "(set)" : "(unset)"],
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
	return `
<div class="card">
  <h2>Configuration</h2>
  <p class="muted">All settings are environment variables. Change them with
  <code>wrangler secret put NAME</code> (or edit <code>wrangler.toml</code>
  <code>[vars]</code> for non-secrets) and redeploy.</p>
  <table>
    <thead><tr><th>Variable</th><th>Value</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>
<div class="card">
  <h3>Bindings</h3>
  <ul>
    <li><code>DB</code> — D1 database (comments, users, reactions, posts)</li>
    <li><code>RATE_LIMITS</code>, <code>OAUTH_STATE</code>, <code>SESSIONS</code>, <code>TREE_CACHE</code> — KV namespaces</li>
    <li><code>ANALYTICS</code> — Workers Analytics Engine dataset (optional)</li>
  </ul>
</div>`;
};
