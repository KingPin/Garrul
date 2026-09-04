/**
 * GitHub API access for `npm run upgrade`.
 *
 * The unauthenticated API allows 60 requests per hour per IP. That is plenty
 * for one upgrade, but the IP is shared with everything else on the operator's
 * network (and with the Worker's own update check during local dev), so the
 * one call the script makes can land on an exhausted counter and come back as
 * a bare 403 that names no cause.
 *
 * A token is optional and never required: `GITHUB_TOKEN` (the same secret the
 * Worker's update check accepts) or `GH_TOKEN` (what `gh` exports) raises the
 * cap to 5000/hr. No token means the unauthenticated request exactly as before.
 * The manifest fetch itself goes to raw.githubusercontent.com, which is not
 * subject to this cap, so only the release lookups carry the header.
 */

export type GithubHeaders = { Accept: string; Authorization?: string };

export const githubToken = (
	env: Record<string, string | undefined> = process.env,
): string | null => {
	const token = (env.GITHUB_TOKEN ?? "").trim() || (env.GH_TOKEN ?? "").trim();
	return token.length > 0 ? token : null;
};

export const githubHeaders = (
	env: Record<string, string | undefined> = process.env,
): GithubHeaders => {
	const headers: GithubHeaders = { Accept: "application/vnd.github+json" };
	const token = githubToken(env);
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
};

/**
 * Operator-facing message for a non-2xx GitHub response. A 403 with the
 * rate-limit counter at zero is the one failure with a known remedy, so it is
 * named explicitly along with the reset time; everything else is the status.
 * `authenticated` suppresses the "set a token" hint when one was already sent.
 */
export const describeGithubFailure = (
	res: Response,
	endpoint: string,
	slug: string,
	authenticated: boolean,
): string => {
	const base = `GitHub ${endpoint} returned ${res.status} for ${slug}`;
	const remaining = res.headers.get("x-ratelimit-remaining");
	if ((res.status !== 403 && res.status !== 429) || remaining !== "0") {
		return base;
	}
	const resetRaw = Number(res.headers.get("x-ratelimit-reset"));
	const resetAt =
		Number.isFinite(resetRaw) && resetRaw > 0
			? ` (resets at ${new Date(resetRaw * 1000).toISOString()})`
			: "";
	const hint = authenticated
		? "the token in use has exhausted its own rate limit"
		: "set GITHUB_TOKEN (or GH_TOKEN) to raise the 60 req/hr unauthenticated cap";
	return `${base}: GitHub API rate limit exhausted${resetAt} — ${hint}`;
};
