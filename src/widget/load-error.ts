/**
 * Maps a failed comment-list load to reader-facing copy.
 *
 * A 5xx, or an unreachable backend (fetch rejects → no status parsed), is a
 * transient outage — a D1/KV/Worker hiccup that resolves on its own — so we
 * reassure rather than alarm with a raw status code. Anything else (a 4xx, a
 * malformed response) is surfaced as a plain load failure. The underlying
 * error is always in the Worker's request logs (`wrangler tail`); the widget
 * stays deliberately quiet on the host page.
 *
 * Takes the translator as an argument rather than importing one: this module is
 * pure (and unit-tested as such), and embed.ts owns the single translator the
 * page renders through.
 */
import type { Translate } from "./strings";

export const loadErrorMessage = (err: unknown, s: Translate): string => {
	const detail = err instanceof Error ? err.message : String(err);
	const match = /\bHTTP (\d{3})\b/.exec(detail);
	const status = match ? Number(match[1]) : null;
	// No status = network/parse failure (backend unreachable); 5xx = backend up
	// but failing. Both are transient from the reader's point of view.
	const transient = status === null || status >= 500;
	return s(transient ? "w.err.transient" : "w.err.generic");
};
