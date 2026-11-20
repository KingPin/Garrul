/**
 * The operator's canonical origin, with trailing slashes and whitespace removed,
 * or null when unset. Every URL that joins a path onto PUBLIC_BASE_URL reads it
 * through here, so `https://x.test/` cannot produce `https://x.test//path`.
 */
export const publicBaseUrl = (env: { PUBLIC_BASE_URL?: string }): string | null => {
	// A loop, not /[\s/]+$/: that regex backtracks quadratically on a long run
	// of internal whitespace.
	let base = (env.PUBLIC_BASE_URL ?? "").trim();
	while (base.endsWith("/")) base = base.slice(0, -1).trimEnd();
	return base || null;
};
