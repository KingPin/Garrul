/**
 * First-page comment-tree cache invalidation.
 *
 * GET /api/v1/comments caches the first page per slug in KV under
 * `tree:<slug>:first:<sort>:n<size>` — keyed by sort AND the operator-tunable
 * page size. Because the size is variable, a write path can't enumerate the
 * exact keys to delete; it prefix-lists instead. The `:first` suffix bounds the
 * prefix to first-page keys (and catches the legacy `tree:<slug>:first` key
 * from before the sort/size split).
 *
 * Best-effort: older pages bypass the cache entirely, so a brief stale first
 * page is the worst case. Every comment mutation (create / edit / delete /
 * moderate / react) calls this so the public reader path stays fresh.
 */
export const bustTreeCache = async (
	env: { TREE_CACHE: KVNamespace },
	slug: string,
): Promise<void> => {
	const listed = await env.TREE_CACHE.list({
		prefix: `tree:${slug}:first`,
	}).catch(() => null);
	if (!listed) return;
	// Swallow per-key delete failures: cache busting is best-effort and must
	// never turn a transient KV hiccup into a failed user-visible write
	// (comment post / edit / delete / reaction all call this).
	await Promise.all(
		listed.keys.map((k) => env.TREE_CACHE.delete(k.name).catch(() => {})),
	);
};
