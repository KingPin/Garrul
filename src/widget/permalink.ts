/**
 * Reader-facing permalink for a single comment.
 *
 * The link points at the *host page* (`https://blog/post/#garrul-comment-<id>`),
 * not at the Worker's `/c/:id` redirect. `/c/:id` is already built and does
 * survive a post moving, but every click of it is a Worker request against a
 * 100,000/day free-tier ceiling — the same ceiling the bootstrap consolidation
 * exists to protect. It also 404s when `post.url` is unset, so its durability
 * edge only holds on installs where `data-url` is set and the host anchor
 * works anyway.
 *
 * `/c/:id` survives as the last rung: inside the iframe embed
 * (src/routes/embed-iframe.ts) with no `?url=`, `location` *is* the Worker's
 * own page, and anchoring at it would produce a link to a bare embed frame.
 *
 * DOM-free on purpose — that is what lets it unit-test in the plain `node`
 * pool with no browser, the same way time.ts and boot.ts do.
 */

/** Anchor id stamped on each thread node by embed.ts (`buildThread`). */
export const commentAnchorId = (id: string): string => `garrul-comment-${id}`;

/**
 * Inverse of `commentAnchorId`: pull the comment id back out of
 * `location.hash`, or null when the hash isn't one of ours.
 *
 * Built from `commentAnchorId("")` rather than a re-typed `"garrul-comment-"`
 * literal, so the prefix has exactly one source of truth.
 *
 * The match is anchored at the start of the hash, not a substring search: a
 * shape like `#existing&garrul-comment-<id>` returns null rather than `<id>`,
 * because loosening to a substring search would also match an unrelated
 * page's `#foo-garrul-comment-bar`-shaped anchor. Nothing we emit produces
 * that shape — both this module's `withAnchor` and the server's `/c/:id`
 * redirect *replace* any existing fragment — so anchoring at the start costs
 * no real link, and an unrecognised hash gets the same "no match, no error"
 * contract as any other hash that isn't ours.
 */
export const commentIdFromHash = (hash: string): string | null => {
	const prefix = `#${commentAnchorId("")}`;
	if (!hash.startsWith(prefix)) return null;
	const id = hash.slice(prefix.length);
	return id.length > 0 ? id : null;
};

export interface PermalinkCtx {
	/** The host page's `data-url`, if the operator set one. */
	dataUrl: string | undefined;
	/** `window.location.href` at mount time. */
	locationHref: string;
	/** Resolved API origin (`host.dataset.api ?? SCRIPT_ORIGIN ?? origin`). */
	apiBase: string;
}

/**
 * Parse as an absolute http(s) URL, or null.
 *
 * `data-url` is caller-supplied by the host page, so the scheme check is a
 * security boundary, not tidiness: without it a hostile or misconfigured host
 * turns every timestamp in the thread into a `javascript:` link. Mirrors the
 * same check the server does at src/routes/permalink.ts:44.
 */
const httpUrl = (raw: string | undefined): URL | null => {
	if (!raw) return null;
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	return u.protocol === "http:" || u.protocol === "https:" ? u : null;
};

/** Replace any existing fragment with the comment anchor. */
const withAnchor = (u: URL, id: string): string => {
	u.hash = commentAnchorId(id);
	return u.toString();
};

export const commentHref = (id: string, ctx: PermalinkCtx): string => {
	const data = httpUrl(ctx.dataUrl);
	if (data) return withAnchor(data, id);

	// Rung 2 is gated on an origin comparison rather than a frame check. A host
	// blog that happens to be iframed for unrelated reasons still deserves a
	// real anchor, and `window.top` access can throw cross-origin where
	// comparing two origins cannot.
	const loc = httpUrl(ctx.locationHref);
	const api = httpUrl(ctx.apiBase);
	if (loc && (!api || loc.origin !== api.origin)) return withAnchor(loc, id);

	return `${ctx.apiBase.replace(/\/+$/, "")}/c/${id}`;
};

/**
 * Upper bound on extra list pages a permalink visit may fetch while it looks
 * for its target. Each page is one billed Worker request on the 100,000/day
 * free tier, so a single permalink visit may cost at most this many extra.
 */
export const MAX_SEEK_PAGES = 10;

type ThreadLike = { id: string; replies: readonly ThreadLike[] };

/** True when `node` or any descendant has `id`. Structural type: no TreeNode import. */
export const subtreeHas = (node: ThreadLike, id: string): boolean =>
	node.id === id || node.replies.some((r) => subtreeHas(r, id));

/**
 * True when comment `id` sits anywhere under `list`. The one lookup behind
 * every "does this batch hold the permalink target?" question: the first
 * render (keep the batch open) and a later hashchange (open it) both ask it.
 */
export const listHolds = (list: readonly ThreadLike[], id: string | null): boolean =>
	id !== null && list.some((r) => subtreeHas(r, id));

/**
 * What a `hashchange` asks of the widget, given the anchor id last revealed.
 *
 * A hash that is not one of our comments ("reset") forgets the revealed and
 * the sought record both: the seek skips a hash that matches either, so
 * clearing just one would leave A -> #top -> A landing nowhere.
 */
export const hashAction = (
	revealed: string | null,
	hash: string,
): "reveal" | "reset" | "none" => {
	const id = commentIdFromHash(hash);
	if (!id) return "reset";
	return commentAnchorId(id) === revealed ? "none" : "reveal";
};

/**
 * Call `reveal()`; if false, call `next()` and retry, up to `maxPages` calls of
 * `next`. Stops early when `next()` returns null (no more pages) or resolves
 * false (fetch failed). Resolves whether the target was revealed.
 *
 * `reveal` is checked before any paging, so a target already on screen costs
 * no request. The page budget is spent only on `next` calls.
 */
export const seekComment = async (
	reveal: () => boolean,
	next: () => Promise<boolean> | null,
	maxPages: number,
): Promise<boolean> => {
	if (reveal()) return true;
	for (let i = 0; i < maxPages; i++) {
		const more = next();
		if (more === null) return false;
		if (!(await more)) return false;
		if (reveal()) return true;
	}
	return false;
};
