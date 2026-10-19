/**
 * GET /embed.js — serves the bundled widget.
 *
 * The bundle is built by scripts/build-embed.ts which:
 *   1. esbuild bundles src/widget/embed.ts → dist/embed.js
 *   2. Re-emits the same bytes as src/widget/embed.bundled.ts (a const
 *      string export) so this route imports them as a normal module —
 *      no wrangler text-loader rule required of self-hosters.
 *
 * Fallback route. Since v2.38 the template serves this file from Workers
 * Static Assets (`[assets] directory = "./public"`, written by
 * scripts/build-embed.ts) and this handler is never reached; it stays so a
 * wrangler.toml without the block keeps working, at one Worker request per
 * browser-cache miss. `s-maxage` is honored only by a cache in front of the
 * Worker, which a bare Worker does not have; the cache and nosniff
 * headers match public/_headers.
 *
 * **This asset is locale-free and must stay that way.** The widget carries the
 * English table and fetches any other language from /api/v1/config at runtime,
 * precisely so this URL stays one shared edge object across every embed on
 * every site. Serving a per-locale bundle from here — or adding ?lang= to the
 * script tag — would shatter the cache of the single asset that benefits most
 * from being shared.
 */
import { Hono } from "hono";
import type { Bindings } from "../index";
import { EMBED_JS } from "../widget/embed.bundled";

const embed = new Hono<{ Bindings: Bindings }>();

embed.get("/embed.js", (c) => {
	c.header("content-type", "application/javascript; charset=utf-8");
	c.header("cache-control", "public, max-age=3600, s-maxage=86400");
	c.header("x-content-type-options", "nosniff");
	return c.body(EMBED_JS);
});

export { embed };
