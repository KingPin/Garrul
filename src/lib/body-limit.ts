import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../index";

/**
 * Largest request body any JSON route accepts.
 *
 * Every per-field cap in the app — the comment length limit, the name limit,
 * the bulk-action id count — is applied *after* `c.req.json()` has already
 * parsed the whole body into memory. So a 40 MB array of junk costs a full
 * parse (and the Worker's 128 MB memory ceiling and 10 ms CPU budget) before
 * any of those caps get a chance to reject it. This middleware is the cap
 * that applies *before* the parse.
 *
 * 64 KB is far above every legitimate payload: the longest is a bulk
 * moderation action at 100 ULIDs (~3 KB) and a comment POST at the 10k-char
 * body limit (~30 KB worst case in multi-byte UTF-8).
 */
export const MAX_JSON_BYTES = 64 * 1024;

/**
 * Routes that legitimately take a body orders of magnitude larger than a JSON
 * payload, and which enforce their own limit.
 *
 * Every `POST /admin/api/ops/import-*` route takes a whole comment-system
 * export — Disqus XML, or the JSON the Remark42, Comentario and isso paths
 * read — up to `MAX_IMPORT_BYTES` (50 MB), and each does its own
 * content-length check plus a byte-accurate recheck after reading. That is
 * why the list is every import route rather than the first one shipped: an
 * import route left off it silently caps at 64 KB while its operator card
 * still promises 50 MB, which is a `413` on any export worth importing.
 *
 * Exempting by *path* rather than by content-type is deliberate:
 * `Request.json()` parses regardless of the declared content-type, so a
 * content-type test would be an attacker-controlled bypass of the cap on
 * every other route. The list is spelled out rather than matched by prefix
 * for the same reason — a future `/admin/api/ops/import-…` route that does
 * *not* do its own byte check must not inherit the exemption by accident.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
	"/admin/api/ops/import-disqus",
	"/admin/api/ops/import-remark42",
	"/admin/api/ops/import-comentario",
	"/admin/api/ops/import-isso",
]);

/**
 * Reject an oversized request body before anything parses it.
 *
 * Wraps Hono's `bodyLimit` so the rejection is a JSON `{ error: "too_large" }`
 * matching the rest of the API rather than its default plain-text body. Hono
 * trusts `content-length` when it's present without `transfer-encoding` and
 * otherwise counts bytes off the stream, so a chunked body can't slip past.
 */
export const jsonBodyLimit = (): MiddlewareHandler<{ Bindings: Bindings }> => {
	const limit = bodyLimit({
		maxSize: MAX_JSON_BYTES,
		onError: (c) => c.json({ error: "too_large" }, 413),
	});
	return async (c, next) => {
		if (EXEMPT_PATHS.has(c.req.path)) return next();
		return limit(c, next);
	};
};
