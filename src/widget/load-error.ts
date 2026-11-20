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

/** A non-2xx answer from a comments fetch. The status is data, never shown. */
export class HttpStatusError extends Error {
	readonly status: number;
	constructor(status: number) {
		super("request failed");
		this.status = status;
	}
}

const statusOf = (err: unknown): number | null => {
	if (err instanceof HttpStatusError) return err.status;
	const detail = err instanceof Error ? err.message : String(err);
	const match = /\bHTTP (\d{3})\b/.exec(detail);
	return match ? Number(match[1]) : null;
};

export const loadErrorMessage = (err: unknown, s: Translate): string => {
	const status = statusOf(err);
	// No status = network/parse failure (backend unreachable); 5xx = backend up
	// but failing. Both are transient from the reader's point of view.
	const transient = status === null || status >= 500;
	return s(transient ? "w.err.transient" : "w.err.generic");
};

/** Machine codes such as `invalid_email`. Human sentences always fail this. */
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Copy for a failed action (save, reply, vote, load more).
 *
 * A server `error` that reads as prose is shown as the server localized it.
 * A machine code is not for readers, so it falls through. A rejected fetch is
 * a network failure. Anything else (a bad JSON body, a thrown bug) is generic.
 */
export const actionErrorMessage = (
	err: unknown,
	body: { error?: string } | null,
	s: Translate,
): string => {
	const prose = body?.error;
	if (typeof prose === "string" && prose !== "" && !MACHINE_CODE.test(prose)) {
		return prose;
	}
	if (err instanceof TypeError) return s("w.err.network");
	return s("w.err.action");
};
