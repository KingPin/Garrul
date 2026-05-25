import type { ReleaseSummary } from "../../lib/version-check";
import {
	CURRENT_VERSION,
	REPO_NAME,
	REPO_OWNER,
} from "../../lib/version.gen";
import { escapeHtml } from "../escape";

const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

const formatDate = (iso: string): string => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toISOString().slice(0, 10);
};

const renderRelease = (r: ReleaseSummary): string => {
	const date = formatDate(r.publishedAt);
	const dateHtml = date ? `<span class="muted"> · ${escapeHtml(date)}</span>` : "";
	// r.bodyHtml is sanitized at cache-write time via renderMarkdown — do not re-escape.
	const body =
		r.bodyHtml ||
		`<p class="muted">No release notes.</p>`;
	return `
<article class="release-card">
  <h3 class="release-head">
    <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.tag)}</a>
    ${r.name && r.name !== r.tag ? `<span class="release-name">${escapeHtml(r.name)}</span>` : ""}
    ${dateHtml}
  </h3>
  <div class="md release-body">${body}</div>
</article>`;
};

export const renderAbout = (releases: ReleaseSummary[] | null): string => {
	const releasesHtml =
		releases && releases.length > 0
			? releases.map(renderRelease).join("")
			: `<p class="muted">No release data cached yet — reload in a moment.</p>`;

	return `
<div class="card">
  <h2>About Garrul</h2>
  <p>Self-hosted comment system on Cloudflare Workers, D1, and KV.</p>
  <p>Running version: <code>v${escapeHtml(CURRENT_VERSION)}</code></p>
</div>

<div class="card">
  <h2>Links</h2>
  <ul class="link-list">
    <li><a href="${REPO_URL}" target="_blank" rel="noopener">Repository on GitHub</a></li>
    <li><a href="${REPO_URL}/releases" target="_blank" rel="noopener">All releases</a></li>
    <li><a href="${REPO_URL}/issues" target="_blank" rel="noopener">Report an issue</a></li>
    <li><a href="${REPO_URL}/blob/main/README.md" target="_blank" rel="noopener">README</a></li>
    <li><a href="/AGENTS.md" target="_blank" rel="noopener">AGENTS.md (AI integration)</a></li>
    <li><a href="${REPO_URL}/blob/main/AGENTS-OPERATE.md" target="_blank" rel="noopener">AGENTS-OPERATE.md (operations)</a></li>
  </ul>
  <p class="muted">Operators: run <code>npm run upgrade</code> from your checkout to see the drift plan against the latest release.</p>
</div>

<div class="card">
  <h2>Recent releases</h2>
  <p class="muted">Showing up to the 5 most recent releases from <code>${escapeHtml(REPO_OWNER)}/${escapeHtml(REPO_NAME)}</code>. Cached for 24h.</p>
  ${releasesHtml}
</div>`;
};
