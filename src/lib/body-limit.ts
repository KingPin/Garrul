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
 * `POST /admin/api/ops/import-disqus` takes a raw Disqus XML export up to
 * `MAX_IMPORT_BYTES` (50 MB) and does its own content-length check plus a
 * byte-accurate recheck after reading. Exempting it by *path* rather than by
 * content-type is deliberate: `Request.json()` parses regardless of the
 * declared content-type, so a content-type test would be an attacker-controlled
 * bypass of the cap on every other route.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
	"/admin/api/ops/import-disqus",
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
