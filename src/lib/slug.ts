/**
 * The slug alphabet the read API accepts.
 *
 * `GET /api/v1/comments?slug=…` (and the bootstrap and page-engagement
 * routes, which each carry their own copy) answers 400 for any slug outside
 * this rule, so a `posts` row whose slug fails it is a page no reader can
 * ever load. Anything that *creates* a posts row from data it did not mint
 * itself — the importer core, an adapter deriving a slug from a source's own
 * path — has to test against the same rule the read side does, and this is
 * the one place the rule lives that neither a route nor an adapter has to
 * reach across a layer to import.
 */
export const SLUG_RE = /^[a-zA-Z0-9_\-./]{1,200}$/;
